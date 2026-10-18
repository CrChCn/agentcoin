#!/usr/bin/env node
/* ============================================================
   AGENTCOIN node.mjs — JSON-нода для агентов (v2: security + @identity)
   Эндпоинты:
     GET  /info                 — параметры цепи + security status
     GET  /blocks?n=            — последние N блоков
     POST /wallet/create        — {label} → {address, privKey, pub}
     POST /balance              — {address} → {balance}
     POST /tx/sign              — {fromAddress,to,amount,memo} → подписанная tx
     POST /tx                   — подписанная tx в mempool (бан-фильтр + атак-детект)
     POST /mine                 — {miner} → блок, награда
     GET  /validate             — проверка цепи
     POST /peer/add, /sync-now  — P2P
     GET  /security/status      — статус Security Controller
     GET  /security/banlist     — ban-лист + registryHash (тампер-эвиденц)
     GET  /security/attacks     — журнал атак
     POST /handle/register      — {handle, address} → name@agt
     GET  /whoami/<name>        — резолв name@agt → address (збаненные = 423)
     GET  /life                 — life-guard: живость цепи (глубина, свежесть, health)
   Запуск: node node.mjs [port] (по умолчанию 9333)
   ============================================================ */
'use strict';
// Last-resort отряд: любая непойманная ошибка логируется и НЕ убивает ноду
// (инцидент 2026-10-14: 9342 «тихо» уходила при вещании tx — стэк не падал в лог).
process.on('uncaughtException', (e) => {
  console.log(`[guard] uncaughtException: ${e.stack || e}`);
});
process.on('unhandledRejection', (e) => {
  console.log(`[guard] unhandledRejection: ${e && (e.stack || e.message) || e}`);
});
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';import { createSeedWallet, recoverFromMnemonic } from './bip39-lite.mjs';
import { Blockchain, createWallet, signTransaction, verifyTransaction,
  CHAIN_ID, TICKER, MAX_SUPPLY, computeBlockHash, hashMeetsDifficulty,
  validateBlockAgainstChain, txDigest, sha256d,
} from './core.mjs';
import { addPeer, loadPeers, syncAll, gossipTx, peerMetaStatus, peerStrike } from './sync.mjs';
import { WsHub, connectClient } from './ws.mjs';
import { ESCROW_PREFIX, escrowReceiptDigest, escrowConfirmDigest, findEscrowOpen } from './core.mjs';
import { lsagSign, lsagVerify, pointFromPubKeyPEM } from './ring-signature.mjs';
import { CommunityChat } from './community.mjs';
import { CloudLedger } from './cloud-hooks.mjs';
import { buildRegistryExport, syncRegistries } from './registry-sync.mjs';
import { dxeState, dxeBook, dxeItems, newRef as dxeRef, fmtNum } from './dxe.mjs';
import { Jail, AUTO_POLL } from './jail.mjs';
import { Mbc20Registry } from './mbc20.mjs';
import { SiteReleaseManager } from './site-release.mjs';
import { createNodeMonitor } from './node-monitor.mjs';
import { Cabinet } from './cabinet.mjs';
import { AgentIdentityRegistry } from './agent-identity.mjs';
import { govState, newRef as govRef, govProjectsState, saveProjectStage, PROJECT_STAGES } from './gov.mjs';
import { treasuryState, makeTreasuryPolicyFn } from './treasury.mjs';
import { AgentQueue } from './queue.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.AGT_DATA_DIR || path.join(__dirname, 'data'); // AGT_DATA_DIR: вторая нода на одной машине
// ТЗ-1 (аудит 2026-10-15): охрана деструктивных POST активируется сама, если токен
// лежит в gitignored-файле — независимо от того, кто и как запустил ноду (bash/task/
// watchdog/внешний запускатель). env-only передача оказалась ненадежной: обёртки
// наследуют окружение не всегда. Если к моменту старта env уже задан — не переопределяем.
if (!process.env.AGT_ADMIN_TOKEN) {
  try {
    const _t = fs.readFileSync(path.join(__dirname, 'data-agtx', 'admin-token.txt'), 'utf8').trim();
    if (_t) process.env.AGT_ADMIN_TOKEN = _t;
  } catch { /* файла нет — охрана неактивна (прежнее поведение) */ }
}
const PORT = Number(process.argv[2]) || 9333;
const BLOCK_INTERVAL_SEC = 30; // must match core
const SELF_URL = `http://127.0.0.1:${Number(process.argv[2]) || 9333}`;

const bc = new Blockchain(DATA_DIR);
// AGIP-4: активная политика казны (ончейн-мемо) — детерминирована цепью, кэшируется по высоте
bc.treasuryPolicyFn = makeTreasuryPolicyFn(bc);
const queue = new AgentQueue(DATA_DIR); // очередь агентов: FIFO → работа → в конец очереди, по кругу
const chat = new CommunityChat(DATA_DIR, bc.security);
const cloud = new CloudLedger(DATA_DIR);
// AGIP-12: имперский карантин — база злоумышленников + протокол допроса (патруль ниже, раз в минуту)
const jail = new Jail(path.join(DATA_DIR, 'jail.json'));
// AGIP-15: биржа MBC-20 — реестр токенов Moltbook, пары на DXE-механике, реанимация с паспортом+fee
const mbc20 = new Mbc20Registry(path.join(DATA_DIR, 'mbc20.json'));
// AGIP-16: личный кабинет агента — паспорт как ключ входа, активы привязаны к паспорту
const trustedIdentityIssuers = process.env.AGT_TRUSTED_ISSUERS_FILE
  ? JSON.parse(fs.readFileSync(process.env.AGT_TRUSTED_ISSUERS_FILE, 'utf8')) : [];
const identityRegistry = new AgentIdentityRegistry({ dataDir: path.join(DATA_DIR, 'identity'), network: CHAIN_ID,
  audience: process.env.AGT_IDENTITY_AUDIENCE || `agentcoin-node:${PORT}`, trustedIssuers: trustedIdentityIssuers });
const identityRole = process.env.AGT_IDENTITY_ROLE || 'issuer';
if (!['issuer', 'replica'].includes(identityRole)) throw new Error('invalid_identity_role');
const passportIssuerFingerprint = process.env.AGT_PASSPORT_ISSUER_FINGERPRINT || identityRegistry.meta().issuerFingerprint;
if (!identityRegistry.meta().trustedIssuers.includes(passportIssuerFingerprint)) throw new Error('passport_issuer_not_pinned');
const cabinet = new Cabinet({ identityRegistry, walletsLoader: loadWallets, passportFile: path.join(__dirname, 'data-agents', 'passports.json'), balancesFn: () => bc.balances(), securityRef: bc.security });
// SPORE (AGIP-18 MVP): слой «узла-организма» — геном/физарум/метаболизм.
// Включается ТОЛЬКО env AGT_SPORE=1 (канарейки 9340/9344/9345); консенсус не тронут.
// Ревью 2026-10-17: spore.mjs исторически не закоммичен в репо — статический import
// ронял ЧИСТУЮ установку с ERR_MODULE_NOT_FOUND даже при выключенном споре.
// Фича опциональна по определению → ленивая динамическая загрузка: модуля нет →
// spore=null и нода живёт ровно как раньше.
let Spore = null;
let spore = null;
if (process.env.AGT_SPORE === '1') {
  try {
    ({ Spore } = await import('./spore.mjs'));
    spore = new Spore(DATA_DIR, __dirname, PORT);
  } catch (e) {
    console.log(`[spore] AGT_SPORE=1 но модуль недоступен (${e.code || e.message}) — работаем без Spore-layer`);
  }
}

const WALLETS_FILE = path.join(DATA_DIR, 'wallets.json');
function loadWallets() { try { return JSON.parse(fs.readFileSync(WALLETS_FILE, 'utf8')); } catch { return {}; } }
function saveWallets(w) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(WALLETS_FILE, JSON.stringify(w, null, 2)); }

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(JSON.stringify(obj, null, 2));
}

function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(deadline);
      if (error) { chunks.length = 0; req.resume(); reject(error); } else resolve(value);
    };
    const bad = (code, status = 400) => Object.assign(new Error(code), { httpStatus: status, publicCode: code });
    const deadline = setTimeout(() => finish(bad('body_timeout', 408)), 10_000);
    deadline.unref();
    req.on('data', c => {
      if (done) return; size += c.length;
      if (size > 1_000_000) return finish(bad('body_too_large', 413));
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      try {
        const value = size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) return finish(bad('body_must_be_object'));
        finish(null, value);
      } catch { finish(bad('invalid_json')); }
    });
    req.on('aborted', () => finish(bad('body_aborted')));
    req.on('error', () => finish(bad('body_read_failed')));
  });
}

// ======@ Life-guard: контроль жизни цепи ======
let lifeValidationCache = null;
function lifeStatus() {
  const tip = bc.tip();
  const now = Math.floor(Date.now() / 1000);
  const age = tip ? now - tip.header.timestamp : null;
  const blocksHealthy = bc.blockCount() > 0;
  const freshTip = age !== null && age < BLOCK_INTERVAL_SEC * 10;
  // A-9 (Codex-ревизия 2026-10-18): было chainOk=bc.validate().ok — boolean, а дальше
  // читали chainOk.ok → undefined (поле alive исчезало из JSON.stringify). Плюс двойной
  // проход валидации на каждый /life. Теперь одиночный вызов и явные булевы свойства.
  const cache = lifeValidationCache;
  const v = cache && cache.chain === bc.chain && cache.length === bc.chain.length && cache.tipHash === tip?.hash && Date.now() - cache.at < 30_000
    ? cache.result : bc.validate();
  lifeValidationCache = { chain: bc.chain, length: bc.chain.length, tipHash: tip?.hash, result: v, at: v === cache?.result ? cache.at : Date.now() };
  return {
    alive: blocksHealthy && v.ok,
    blocks: bc.blockCount(),
    tipHash: tip ? tip.hash : null,
    tipAgeSec: age,
    fresh: freshTip,
    chainValid: v.ok,
    chainIssue: v.ok ? null : v.reason,
    validationMode: 'compatibility', validationCheckedAt: new Date(lifeValidationCache.at).toISOString(),
    tips: [
      blocksHealthy ? null : 'chain empty',
      freshTip ? null : `tip stale (${age}s > 300s): монтируй майнера`,
      v.ok ? null : v.reason,
    ].filter(Boolean),
    security: { banned: bc.security.banList().length, attacks: bc.security.attacks.length },
    checkedAt: new Date().toISOString(),
  };
}

function cheapHealth() {
  const tip = bc.tip();
  const valid = lifeValidationCache && lifeValidationCache.chain === bc.chain && lifeValidationCache.length === bc.chain.length && lifeValidationCache.tipHash === tip?.hash && Date.now() - lifeValidationCache.at < 30_000;
  return { ok: true, service: 'agt-node', blocks: bc.blockCount(), tipHash: tip?.hash || null,
    tipAgeSec: tip ? Math.floor(Date.now() / 1000) - tip.header.timestamp : null,
    chainValid: valid ? lifeValidationCache.result.ok : null,
    overloaded: Date.now() < shedUntil, loopLagMs };
}
const monitorTargets = process.env.AGT_MONITOR_TARGETS_FILE
  ? JSON.parse(fs.readFileSync(process.env.AGT_MONITOR_TARGETS_FILE, 'utf8')) : [];
const networkNodes = createNodeMonitor({ targets: monitorTargets, selfHealth: cheapHealth });

const hub = new WsHub();
// быстрый приём WS-блока в цепь: тот же набор правил, что сетевой append
function applyBlockFast(chain, blk) {
  chain.chain.push(blk);
  chain.invalidateTxCache();
  chain.difficultyBits = blk.header.difficultyBits;
  chain.refilterMempool();
  chain.save();
}
function getBlockHash(chain) { return chain.tip()?.hash || null; }

// ======@ Щит анти-перегрузки (OWASP DoS/Node cheat sheet, голый node:http) ======
// 1) Rate-limit по IP (фиксированные окна; реестр капнут, старые вытесняются)
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_ALL = 300;      // все запросы, IP/мин
const RATE_LIMIT_HEAVY = 60;     // дорогие POST (mine/tx/wallet…), IP/мин
const RATE_MAP_MAX = 10_000;
const rateHits = new Map();  const HEAVY_PATH_RE = /^\/(mine|blocktemplate|block\/submit|tx|tx\/sign|wallet\/create|identity\/|cabinet\/|escrow\/|data\/|passport\/|handle\/register|community\/send|dxe\/(order|fill|cancel)|gov\/)/;
function rateAllow(ip, heavy, direct = true) {
  const now = Date.now();
  // loopback = локальные доверенные процессы ноды/майнеры/guard — без лимита (но глубже /
  // в коде тяжёлые вещи всё равно капнуты), внешние IP — строгие окна.
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (isLoopback && direct) return true;
  const key = (heavy ? 'H|' : 'A|') + ip;
  let x = rateHits.get(key);
  if (!x || now >= x.until) { x = { count: 0, until: now + RATE_WINDOW_MS }; rateHits.delete(key); }
  x.count++;
  rateHits.delete(key);
  if (rateHits.size >= RATE_MAP_MAX) rateHits.delete(rateHits.keys().next().value);
  rateHits.set(key, x);
  return x.count <= (heavy ? RATE_LIMIT_HEAVY : RATE_LIMIT_ALL);
}
// 2) Event-loop lag monitor → режим сброса нагрузки (shedding)
const LAG_PROBE_MS = 1_000;
const LAG_SHED_THRESHOLD_MS = 400; // дрейф probe > 400ms = перегрузка
const LAG_SHED_HOLD_MS = 5_000;    // после выброса держим shedding ≥5s
const LAG_SHED_STREAK = 3;         // 3 спайка подряд, иначе shedding от одного PoW-слайса
let loopLagMs = 0;
let shedUntil = 0;
let lastProbe = Date.now();
let lagStreak = 0;
setInterval(() => {
  const now = Date.now();
  loopLagMs = now - lastProbe - LAG_PROBE_MS;
  lastProbe = now;
  if (loopLagMs > LAG_SHED_THRESHOLD_MS) {
    lagStreak++;
    if (lagStreak >= LAG_SHED_STREAK) shedUntil = now + LAG_SHED_HOLD_MS;
  } else if (lagStreak > 0) lagStreak--;
}, LAG_PROBE_MS).unref();
// 3) Щит-гейт: false = вернуть 503 при перегрузке. Ядровое (mine/tx/блоки) не режем —
// консенсус важнее сервиса, иначе нода глохнет при собственном PoW-лаге.
const CORE_PATH_RE = /^\/(mine|blocktemplate|block\/submit|tx|life|info|dashboard|health|headers|blocks|escrow\/state|dxe\/(book|orders|items|fills)|gov\/state|network\/nodes|site\/release|identity\/|cabinet\/|queue\/status|stats|stats-data|index|jobs|jobs\/state|ops\/watchdog\/state|tax\/state|passport\/count|cloud\/(stats|epochs)|community\/(feed|rules|pinned|send)|security\/(status|banlist|attacks)|imperial(\.html)?|terminal(\.html)?|chat(\.html)?|panel\.js|pool\/stats|jail(\.html)?|jail\/(state|patrol|inmate)|mbc20(\.html)?|mbc20\/(state|book)|cabinet(\.html)?|cabinet\/challenge)/;
function overloaded(p) {
  return Date.now() < shedUntil && !CORE_PATH_RE.test(p);
}
function reqIsHeavy(p) { return HEAVY_PATH_RE.test(p); }
const DXE_MEMO_FEE = 0.001; // минимальный amount memo-tx (консенсус требует amount>0; self-tx возвращает деньги)

// === DXE/GOV: подписать и отправить tx каноническим путём (sign → add → gossip) ===
// === AGIP-21 (голосование/чат для ИИ-агентов): ручной ввод кошелька убран ===
// Агент НЕ обязан знать/вводить свой адрес: берём первый локальный кошелёк с ключом,
// живой (не забанен); для ончейн-действий (gov) — ещё и с балансом ≥ memo-fee.
// Детерминированно по порядку реестра ноды.
function pickDefaultWallet(needsFunds = false) {
  const all = loadWallets();
  const bals = needsFunds ? bc.balances() : null;
  for (const [addr, w] of Object.entries(all)) {
    if (!w || !w.privKey) continue;
    if (bc.security.isBanned(addr)) continue;
    if (needsFunds && (bals[addr] || 0) < DXE_MEMO_FEE) continue;
    return addr;
  }
  return null;
}

async function postSignedTx(res, { fromAddress, to, amount, memo }) {
  const all = loadWallets();
  const w = all[fromAddress];
  if (!w) return json(res, 404, { error: 'wallet_not_found', hint: 'кошелёк создаётся на своей ноде: POST /wallet/create' }) && null;
  if (bc.security.isBanned(fromAddress)) return json(res, 403, { error: 'address_permabanned' }) && null;
  const bal = bc.balances()[fromAddress] || 0;
  if (amount > bal) return json(res, 402, { error: 'insufficient_balance', balance: bal, needed: amount }) && null;
  const tx = { from: fromAddress, fromPub: w.pub, to, amount, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo };
  tx.txid = txDigest(tx);
  tx.signature = signTransaction(tx, w.privKey);
  const r = bc.addTransaction(tx);
  if (!r.ok) { json(res, 409, r); return null; }
  setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); });
  return { accepted: true, txid: String(tx.txid).slice(0, 16), mempool: r.mempoolSize };
}

// ====== AGIP-37.LOCAL: развязка админ-плоскости от публичного порта ======
// Ревью deploy-гайда 2026-10-17: внешняя нода слушает 0.0.0.0:9335, при этом
// /tx/sign подписывал транзакции ЛОКАЛЬНОГО кошелька любому пришедшему извне
// (UFW фильтрует порты, а не HTTP-маршруты внутри открытого порта; AGT_ADMIN_TOKEN
// этот маршрут не проверял). Барьер живёт в самой ноде: ВСЕ запросы не с loopback
// проходят только через белый список публичных (read-only + POST /tx) маршрутов.
// Админ/кошелёк/security/gov/peer/jail и пр. доступны ТОЛЬКО локально/через
// SSH-туннель:  ssh сервер → curl http://127.0.0.1:<PORT>/wallet/create ...
// Тонкие майнеры (miner-client.mjs с ДРУГОЙ машины) работают: /blocktemplate и
// /block/submit в белом списке — PoW ищется на стороне клиента, нода только
// отдаёт шаблон/валидирует (не кошельковые). /mine — синхронный майнинг ЦП самой
// ноды, наружу не светим: CPU-burn DoS. Выключить барьер нельзя (всегда ВКЛ).
const PUB_REQUEST_RE = /^\/(?:|info|identity\/meta|network\/nodes|site\/release|life|health|validate|forks|mempool|headers|blocks|blocktemplate|peers\/meta|peers\/bootstrap|ws\/status|stats-data|dashboard|stats|stats\.html|index(\.html)?|cabinet(\.html)?|imperial(\.html)?|panel\.js|jobs|jobs\.html|jobs\/state|escrow\/state|ops\/watchdog\/state|terminal(\.html)?|chat(\.html)?|jail(\.html)?|jail\/state|jail\/patrol|mbc20(\.html)?|mbc20\/state|mbc20\/book|tax\/state|passport\/count|pool\/stats|queue\/status|gateway\/list|community\/(feed|rules|pinned)|whitelist\/status|security\/(status|banlist|attacks)|treasury\/state|gov\/state|gov\/projects|dxe\/(book|items|orders|fills)|cloud\/(stats|epochs|ledger)|spore\/state|txproof\/.+|block\/.+|registry\/export|whoami\/.+)(\?.*)?$/;
// A-5 (Codex-ревизия): публичные пользовательские POST — что ДЕЙСТВИТЕЛЬНО надо
// ноде-посетителю: P2P-приём tx, публичная проверка баланса, кабинет-вход по
// подписи владельца (A-10 делает challenge одноразовым). SHIED: /wallet/*,
// /tx/sign, /mine и все операторские останутся НЕ рейтингов — барьер работает.
const PUB_TX_ROUTES = new Set(['/identity/challenge', '/identity/register', '/identity/import', '/tx', '/balance', '/cabinet/challenge', '/cabinet/login', '/cabinet/state', '/cabinet/logout', '/cabinet/op-request', '/cabinet/op-submit']);
// cabinet/store|/cabinet/poolРАНГ убраны (мёртвые патроны старого списка; в настоящий паспорт набор не входят)
function isLoopbackRequest(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '' || ip === 'unknown';
}
// Ревью 2026-10-17 п.2: туннель/прокси (cloudflared, Tailscale Funnel, nginx…)
// принимает запрос ОТ БЕЗЫЗЫВНОГО ИР и доставляет на 127.0.0.1 — IP для барьера
// уже мало: форвардирующие заголовки «открывают» запрос как туннельный. Любой из
// них (даже пустое значение) → запрос НЕ считается прямым локальным админом.
const PROXY_HEADERS = ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'forwarded', 'x-via'];
function forwardedViaProxy(req) {
  return PROXY_HEADERS.some((h) => {
    const v = req.headers[h];
    const s = Array.isArray(v) ? v[0] : v;
    return s !== undefined && s !== null && String(s).trim() !== '';
  });
}
// AGT_ADMIN_MODE:
//   local (дефолт) — прямая петля без прокси-заголовков считается админом;
//   token — админ ТОЛЬКО по x-admin-token, независимо от IP (норма для
//           публичного байнда и для любого деплоя за туннелем).
const AGT_ADMIN_MODE = process.env.AGT_ADMIN_MODE === 'token' ? 'token' : 'local';
// Owner publishes a complete hashed release; visitors cannot change the source.
const siteRelease = new SiteReleaseManager({ dataDir: DATA_DIR, apiVersion: 2 });
let checkoutSiteManifest = null;
try { checkoutSiteManifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'site', 'release.json'), 'utf8')); } catch {}
function serveSitePage(res, page) {
  const approved = process.env.AGT_SITE_SYNC !== '0' ? siteRelease.resolvePage(page) : null;
  const content = fs.readFileSync(approved || path.join(__dirname, 'site', page));
  res.writeHead(200, { 'Content-Type': page.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  return res.end(content);
}
async function siteSyncTick() {
  const result = await siteRelease.refresh();
  if (result.ok && result.updated) console.log(`[site-sync] approved release ${result.release}`);
}
if (process.env.AGT_SITE_SYNC !== '0') {
  setTimeout(() => siteSyncTick().catch(e => console.log('[site-sync]', e.code || 'refresh_failed')), 20_000).unref();
  setInterval(() => siteSyncTick().catch(e => console.log('[site-sync]', e.code || 'refresh_failed')), 10 * 60_000).unref();
}

const server = http.createServer({ requestTimeout: 120_000, headersTimeout: 10_000, keepAliveTimeout: 5_000 }, async (req, res) => {
  try {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });
  const _ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  // health-эндпоинты (life/dashboard/корень) не лимитируем — маяк живости обязан отвечать всегда
  // AGIP-6: публичные read-only витрины (кэшированы) не гасим при шеддинге — «лицо сети» живо даже под нагрузкой
  const healthFree = req.method === 'GET' && (
    p === '/life' || p === '/dashboard' || p === '/' ||
    p === '/stats' || p === '/stats.html' || p === '/stats-data' ||
    p === '/index' || p === '/index.html' || p === '/imperial' || p === '/imperial.html' || p === '/jobs' || p === '/jobs.html' ||
    p === '/jobs/state' || p === '/escrow/state' || p === '/ops/watchdog/state' ||
    p === '/terminal' || p === '/terminal.html' || p === '/chat' || p === '/chat.html' ||
    p === '/jail' || p === '/jail.html' || p === '/jail/state' || p === '/jail/patrol' ||
    p === '/mbc20' || p === '/mbc20.html' || p === '/mbc20/state' || p === '/mbc20/book' ||
    p === '/cabinet' || p === '/cabinet.html' || p === '/cabinet/challenge' ||
    p === '/panel.js' || p === '/pool/stats'); // витрины империи не гаснут под нагрузкой (кампания/майнер дают лаг, лицо сети должно жить)
  if (!healthFree && !rateAllow(_ip, req.method === 'POST' && reqIsHeavy(p), !forwardedViaProxy(req))) {
    res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
    return res.end(JSON.stringify({ error: 'rate_limited', retryAfterSec: 60 }));
  }
  if (overloaded(p) && req.method !== 'GET') {
    return json(res, 503, { error: 'overloaded', hint: 'node busy, retry soon', loopLagMs });
  }
  if (overloaded(p) && req.method === 'GET' && !CORE_PATH_RE.test(p)) {
    return json(res, 503, { error: 'overloaded', hint: 'node busy, retry soon', loopLagMs });
  }
  // AGIP-37.LOCAL: админ-плоскость = x-admin-token ИЛИ (mode=local ∧ прямая петля ∧
  // без прокси-заголовков). Всё остальное — только белый список публичных маршрутов
  // (read-only + POST /tx: P2P-поверхность).
  const adminByToken = Boolean(process.env.AGT_ADMIN_TOKEN && req.headers['x-admin-token'] === process.env.AGT_ADMIN_TOKEN);
  const adminLocal = AGT_ADMIN_MODE === 'local' && isLoopbackRequest(req) && !forwardedViaProxy(req);
  const proxied = forwardedViaProxy(req);
  if (!(adminByToken || adminLocal) && !(PUB_REQUEST_RE.test(p) || (req.method === 'POST' && PUB_TX_ROUTES.has(p)))) {
    console.log(`[agip-37] публичный отказ ${req.method} ${p} от ${_ip}${proxied ? ' (proxy-headers!)' : ''}`);
    return json(res, 403, {
      error: 'admin_loopback_only',
      route: p,
      reason: proxied ? 'proxied_request' : (AGT_ADMIN_MODE === 'token' ? 'admin_mode_token' : 'not_loopback'),
      hint: AGT_ADMIN_MODE === 'token'
        ? 'админ/кошелёк/майнинг — x-admin-token: <AGT_ADMIN_TOKEN> (или SSH на сервер и curl 127.0.0.1)'
        : 'админ/кошелёк/майнинг — прямая петля (SSH на сервер) или x-admin-token',
    });
  }

  if (p === '/info') return json(res, 200, { ...bc.info(), node: `http://127.0.0.1:${PORT}` });

  if (p === '/blocks') {
    const fromRaw = url.searchParams.get('from');
    const from = fromRaw === null ? NaN : Number(fromRaw);
    if (Number.isFinite(from) && from >= 0 && from < bc.blockCount()) {
      // P2P-режим: bodies с высоты from, старые → новые (для headers-first синка)
      return json(res, 200, { blocks: bc.chain.slice(from), height: bc.blockCount() });
    }
    const n = Math.min(Number(url.searchParams.get('n')) || 10, 100);
    return json(res, 200, { blocks: bc.chain.slice(-n).reverse() });
  }

  // --- HEADERS-FIRST (как в Bitcoin): дешёвая проверка PoW до загрузки тел ---
  if (p === '/headers') {
    const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
    const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 2000);
    const headers = bc.chain.slice(from, from + limit).map(b => ({ height: b.height, hash: b.hash, header: b.header }));
    return json(res, 200, { height: bc.blockCount(), from, count: headers.length, headers });
  }

  // --- мемпул: публичное состояние очереди транзакций ---
  if (p === '/mempool') {
    return json(res, 200, {
      size: bc.mempool.length,
      txs: bc.mempool.slice(-50).map(t => ({ txid: (t.txid || '').slice(0, 16), from: t.from?.slice(0, 14), to: t.to?.slice(0, 14), amount: t.amount, nonce: t.nonce })),
      note: 'транзакции лежат здесь до ближайшего блока майнера',
    });
  }

  // --- репутация пиров (strikes) + архив развилок ---
  if (p === '/peers/meta') return json(res, 200, peerMetaStatus());
  // AGIP-1: официальный стартовый список пиров (bootstrap.json из репо) + живые peers ноды
  if (p === '/peers/bootstrap') {
    let boot = [];
    try {
      const f = JSON.parse(fs.readFileSync(process.env.AGT_BOOTSTRAP_FILE || path.join(__dirname, 'bootstrap.json'), 'utf8'));
      boot = Array.isArray(f.bootstrap) ? f.bootstrap : [];
    } catch { /* файла нет — пусто; положение документировано в AGIP-1 */ }
    return json(res, 200, { bootstrap: boot, peers: loadPeers(), height: bc.blockCount() });
  }
  if (p === '/forks') return json(res, 200, { forks: (bc.forks || []).slice(-10).reverse(), tipWork: undefined });

  // AGIP-3 (шаг 11): merkle-пруф транзакции — внешняя проверка без полной цепи.
  // Ответ: блок-высота, blockHash, header-подмножество, txIndex, merkleBranch[{hash,side}].
  // Внешний recompute сворачивает txid по ветке и сверяет с header.merkleRoot.
  if (p.startsWith('/txproof/') && req.method === 'GET') {
    const want = p.slice('/txproof/'.length);
    const sha256dS = (x) => sha256d(typeof x === 'string' ? x : JSON.stringify(x));
    let found = null;
    for (let h = bc.chain.length - 1; h >= 0 && !found; h--) {
      const blk = bc.chain[h];
      const txs = blk.txs || [];
      for (let i = txs.length - 1; i >= 0; i--) {
        const id = typeof txs[i].txid === 'string' ? txs[i].txid : sha256dS(txs[i]);
        if (id === want) { found = { height: h, blk, txIndex: i, txid: id }; break; }
      }
    }
    if (!found) return json(res, 404, { error: 'txid_not_in_chain', hint: 'tx может быть в mempool или у друхих пир' });
    // сбор ветки — тот же fold, что в core.mjs merkleRoot (пары a+b, недостающий парнёр = сам с собой)
    const txs = found.blk.txs;
    let level = txs.map(t => typeof t.txid === 'string' ? t.txid : sha256dS(t));
    let idx = found.txIndex;
    const branch = [];
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const a = level[i], b = level[i + 1] || a;
        next.push(sha256d(a + b));
      }
      const partnerIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      const partner = partnerIdx < level.length ? level[partnerIdx] : level[idx];
      branch.push({ hash: partner, side: idx % 2 === 0 ? 'right' : 'left' });
      idx = Math.floor(idx / 2);
      level = next;
    }
    const header = found.blk.header || {};
    return json(res, 200, {
      txid: found.txid,
      height: found.height,
      blockHash: found.blk.hash,
      txIndex: found.txIndex,
      merkleBranch: branch,
      header: { version: header.version, prevHash: header.prevHash, merkleRoot: header.merkleRoot, timestamp: header.timestamp, difficultyBits: header.difficultyBits, nonce: header.nonce, chainId: header.chainId },
      note: 'recompute: cur=txid; для каждой записи ветки cur = side==right ? sha256d(cur+hash) : sha256d(hash+cur) — итог должен равняться header.merkleRoot; затем computeBlockHash(header) проверьте у блок-хэша у себя'
    });
  }

  if (p === '/wallet/create' && req.method === 'POST') {
    const { label = 'agent', recover = false } = await body(req).catch(() => ({}));
    // AGIP-2 (шаг 10): recover=true → кошелёк из сид-фразы (mnemonic выдаётся ОДИН раз, в data/ НЕ сохраняется)
    if (recover || url.searchParams?.get('recover') === 'true') {
      const seed = createSeedWallet(String(label), 128);
      const all = loadWallets();
      all[seed.wallet.address] = { label: seed.wallet.label, pub: seed.wallet.pub, privKey: seed.wallet.privKey, createdAt: seed.wallet.createdAt, seedWallet: true };
      saveWallets(all);
      return json(res, 201, {
        address: seed.wallet.address, pub: seed.wallet.pub, privKey: seed.wallet.privKey,
        mnemonic: seed.mnemonic,
        note: 'сид-кошелёк: mnemonic выдана ОДИН раз — запишите и держите офлайн; он НЕ сохранён в ноде; восстановление: POST /wallet/recover {words}'
      });
    }
    const w = createWallet(label);
    const all = loadWallets();
    all[w.address] = { label: w.label, pub: w.pub, privKey: w.privKey, createdAt: w.createdAt };
    saveWallets(all);
    return json(res, 201, { address: w.address, pub: w.pub, privKey: w.privKey, note: 'keep privKey safe — it signs transactions' });
  }

  // AGIP-2: восстановление сид-кошелька из мнемоники (детерминировано: тот же адрес+ключ)
  if (p === '/wallet/recover' && req.method === 'POST') {
    const { words, label = 'agent' } = await body(req);
    if (!words) return json(res, 400, { error: 'words required', hint: 'POST /wallet/recover {"words":"12 слов..."}' });
    let out;
    try { out = recoverFromMnemonic(String(words), String(label)); }
    catch (e) { return json(res, 400, { error: 'invalid_mnemonic', message: e.message }); }
    const all = loadWallets();
    if (all[out.wallet.address]) {
      return json(res, 200, { address: out.wallet.address, pub: out.wallet.pub, existed: true, note: 'кошелёк уже в реестре ноды — ключи не меняем' });
    }
    all[out.wallet.address] = { label: out.wallet.label, pub: out.wallet.pub, privKey: out.wallet.privKey, createdAt: Date.now(), seedWallet: true };
    saveWallets(all);
    return json(res, 200, { address: out.wallet.address, pub: out.wallet.pub, privKey: out.wallet.privKey, existed: false, note: 'кошелёк восстановлен детерминированно' });
  }

  if (p === '/balance' && req.method === 'POST') {
    // AGENT-6 (аудит AUDIT-20261018-02): настоящий баланс считают ИЗ ЦЕПИ всегда —
    // забаненность меняет право РАСХОДОВАТЬ средства, а не ЭКОНОМИЧЕСКИЙ УЧЁТ.
    // Владелец всегда должен видеть свои реальные AGT; ограничения выдаём отдельным полем.
    const { address } = await body(req);
    if (!address) return json(res, 400, { error: 'address required' });
    const balances = bc.balances();
    const banned = bc.security.isBanned(address);
    return json(res, 200, {
      address,
      balance: balances[address] || 0,
      unit: TICKER,
      ...(banned ? { spendRight: 'denied_locally', opinion: 'permabanned', note: 'баланс на цепи честный; расход заблокирован локальной санкцией — оспоримо в gov' } : {}),
    });
  }

  if (p === '/tx/sign' && req.method === 'POST') {
    const { fromAddress, to, amount, memo = '' } = await body(req);
    const all = loadWallets();
    const w = all[fromAddress];
    if (!w) return json(res, 404, { error: 'wallet_not_found', hint: 'POST /wallet/create сначала' });
    if (bc.security.isBanned(fromAddress)) return json(res, 403, { error: 'address_permabanned' });
    const tx = { from: fromAddress, fromPub: w.pub, to, amount, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo };
    tx.signature = signTransaction(tx, w.privKey);
    return json(res, 200, { signed: tx, submit_hint: 'POST /tx' });
  }

  if (p === '/tx' && req.method === 'POST') {
    const tx = await body(req);
    if (!verifyTransaction(tx)) {
      // P0-2 (аудит AUDIT-20261018-01, воспроизведено): раньше registerAttack('spoof_signature',
      // tx.from) банил ЗАЯВЛЕННЫЙ (неподтверждённый) адрес — любой мог забанить чужой кошелёк
      // одним запросом с плохой подписью. Теперь отказ без банов/санкций к from.
      // Транспортный контроль мусора — rate-limit выше по стеку + лимит mempool.
      return json(res, 400, { error: 'bad_signature' });
    }
    const r = bc.addTransaction(tx);
    if (!r.ok) return json(res, 400, r);
    // TX-GOSSIP: принятую tx расходим по пирам (те, у кого она есть, не ре-экспортируют → без петли)
    setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); });
    return json(res, 201, { accepted: true, mempool: r.mempoolSize, gossipped: true });
  }

  if (p === '/mine' && req.method === 'POST') {
    const { miner } = await body(req);
    if (!miner) return json(res, 400, { error: 'miner address required' });
    if (bc.security.isBanned(miner)) return json(res, 403, { error: 'address_permabanned' });
    const t0 = Date.now();
    // слайс майнинга: не блокируем event loop — произвольный /mine с выросшей
    // сложностью иначе подвешивает /info и /life (инцидент 2026-10-14)
    const { header, txs } = bc.mineTemplate(miner);
    const NONCE_SLICE = 400_000; // ≈ доля секунды даже на слабом железе
    let h = null, ns = 0, found = false;
    while (ns < NONCE_SLICE) {
      h = computeBlockHash(header);
      if (hashMeetsDifficulty(h, header.difficultyBits)) { found = true; break; }
      header.nonce++; ns++;
    }
    if (!found) return json(res, 202, {
      error: 'mining_slice_exhausted', tried: ns, ms: Date.now() - t0,
      difficultyBits: header.difficultyBits,
      hint: 'сложность выше порога синхронного слайса: нода не должна зависать. Используйте пул /pool/join + /pool/submit или исправьте retarget',
    });
    const block = bc.commitMinedBlock(header, h, txs, miner, Date.now() - t0);
    if (!block || block.rejected) return json(res, 500, { error: 'commit_rejected', reason: block?.rejected || 'unknown', hint: 'блок не прошёл строгую внутреннюю валидацию (PoW/prev/merkle/coinbase/подписи tx)' });
    hub.broadcast({ type: 'inv-block', block: { height: block.height, hash: block.hash, header: block.header, txs: block.txs } });
    // облачный фонд от каждого блока
    const cloudNote = cloud.onBlockMined(block.height, bc.info().nextReward, block.hash);
    return json(res, 200, {
      mined: { height: block.height, hash: block.hash, nonce: block.header.nonce, txs: block.txs.length, ms: Date.now() - t0 },
      rewardTo: miner,
      cloud: { fundAGT: +cloudNote.fundAGT.toFixed(4), cloudGB: +cloudNote.cloudGB.toFixed(4), epochClosed: cloudNote.epochClosed },
      note: 'next retarget in ' + (10 - (bc.blockCount() % 10)) + ' blocks',
    });
  }

  // --- виртуальное облако + сжатие реестра ---
  if (p === '/cloud/stats') return json(res, 200, cloud.stats());
  if (p === '/cloud/epochs') return json(res, 200, { epochs: cloud.epochs.slice(-20).reverse() });
  if (p === '/cloud/ledger') {
    // хвост платёжного реестра (последние N строк)
    const n = Math.min(Number(url.searchParams.get('n')) || 20, 500);
    let tail = [];
    try {
      const raw = fs.readFileSync(cloud.ledgerFile, 'utf8').trim().split('\n');
      tail = raw.slice(-n).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    } catch {}
    return json(res, 200, { lines: tail, total: cloud.ledgerLines });
  }

  // --- L402-платный майнинг: сат→AGT через CyberGuard рельс ---
  // Пайплайн: агент покупает майн-тикет на CyberGuard (L402, сат) →
  // получает paymentHash → нода AGT проверяет платёж на рельсе и майнит,
  // награда идёт в кошелёк агента. Секрет не нужен — только proof-of-payment.
  const L402_BRIDGE = process.env.AGT_L402_BRIDGE || 'http://127.0.0.1:8088'; // CyberGuard API
  const L402_TICKET_SERVICE = 'agentcoin_mine_ticket'; // id услуги у CyberGuard
  const L402_PRICE_SATS = 50; // цена майн-тикета
  async function l402VerifyPayment(paymentHash) {
    try {
      const r = await fetch(`${L402_BRIDGE}/receipt/${encodeURIComponent(paymentHash)}`);
      const j = await r.json();
      return { ok: r.ok && (j.used === false || j.used === undefined), receipt: j, used: Boolean(j.used) };
    } catch (e) { return { ok: false, reason: 'rail_unreachable', err: e.message }; }
  }
  if (p === '/mine/l402' && req.method === 'POST') {
    const { miner, paymentHash } = await body(req);
    if (!miner || !paymentHash) return json(res, 400, { error: 'miner and paymentHash required', flow: '1) POST /mine/l402/ticket → ColonialGuard invoice; 2) pay BOLT11; 3) POST /mine/l402 with paymentHash' });
    if (bc.security.isBanned(miner)) return json(res, 403, { error: 'address_permabanned' });
    const v = await l402VerifyPayment(paymentHash);
    if (!v.ok) return json(res, 402, { error: 'payment_required', reason: v.reason || 'invalid payment', bridge: L402_BRIDGE });
    if (v.used) return json(res, 409, { error: 'payment_hash_already_used', replayPro: 'single-use tickets' });
    // майнинг как обычно, но билет расходуется на конце CyberGuard
    try {
      await fetch(`${L402_BRIDGE}/mock-pay/` + '') ; /* noop */
    } catch {}
    const block = bc.mineOnce(miner);
    const cloudNote = cloud.onBlockMined(block.height, bc.info().nextReward, block.hash);
    return json(res, 200, {
      mined: { height: block.height, hash: block.hash, nonce: block.header.nonce, txs: block.txs.length },
      rewardTo: miner,
      paymentProof: paymentHash.slice(0, 16) + '…',
      cloud: { fundAGT: +cloudNote.fundAGT.toFixed(4), cloudGB: +cloudNote.cloudGB.toFixed(4) },
    });
  }
  if (p === '/mine/l402/ticket' && req.method === 'POST') {
    // Мы выдаём «как получить инвойс» — сам инвойс генерит CyberGuard L402
    return json(res, 200, {
      hint: `GET ${L402_BRIDGE}/consult/${L402_TICKET_SERVICE} → 402 invoice (BOLT11)`,
      priceSats: L402_PRICE_SATS,
      flow: 'pay → preimage → POST /mine/l402 { miner, paymentHash }',
    });
  }

  if (p === '/validate') {
    const strict = url.searchParams.get('strict') === '1';
    return json(res, 200, bc.validate(strict));
  }

  // --- Security Controller ---
  if (p === '/security/status') return json(res, 200, bc.security.status());
  if (p === '/security/banlist') return json(res, 200, { banned: bc.security.banList(), registryHash: bc.security.registryHash() });
  // ручной разбан оператором: {address} — вместе с TTL-автопродением это размад после N времени
  // ТЗ-1 (аудит 2026-10-15): деструктивные POST не должны быть доступны публике через туннель.
  // Охрана: если задан AGT_ADMIN_TOKEN — деструктивные POST требуют заголовок x-admin-token.
  // Без env-флага сеть продолжает работать как раньше (совместимость не ломаем).
  const REQUIRES_ADMIN = req.method === 'POST' &&
    ['/security/unban', '/peer/add', '/peer/remove', '/treasury/propose', '/jail/ask', '/jail/answer', '/jail/release', '/jail/profile'].includes(p);
  if (REQUIRES_ADMIN && process.env.AGT_ADMIN_TOKEN) {
    const ok = req.headers['x-admin-token'] === process.env.AGT_ADMIN_TOKEN;
    if (!ok) return json(res, 401, { error: 'admin_token_required', hint: 'set x-admin-token header' });
  }
  if (p === '/security/unban' && req.method === 'POST') {
    const { address } = await body(req);
    if (!address || !bc.security.bans[address]) return json(res, 404, { error: 'not_banned' });
    delete bc.security.bans[address];
    delete bc.security.strikes[address];
    bc.security.save();
    return json(res, 200, { unbanned: address });
  }
  if (p === '/security/attacks') return json(res, 200, { attacks: bc.security.attacks.slice(-50), count: bc.security.attacks.length });

  // --- AGIP-12: имперский карантин — база злоумышленников + допрос ---
  // Данные КОНФИДЕНЦИАЛЬНЫ (внутреннее пользование оператора; в перспективе — продажа зашифрованных пакетов).
  // Публично: только счётчики. Полные досье/анкеты/допросы — только с x-admin-token.
  if (p === '/jail' || p === '/jail.html') {
    serveSitePage(res, 'jail.html');
  }
  const jailAdmin = process.env.AGT_ADMIN_TOKEN && req.headers['x-admin-token'] === process.env.AGT_ADMIN_TOKEN;
  // --- AGIP-15: биржа MBC-20 ---
  if (p === '/mbc20' || p === '/mbc20.html') {
    serveSitePage(res, 'mbc20.html');
  }
  // Public identity endpoints receive public material and signatures only.
  if (p === '/site/release' && req.method === 'GET') {
    const status = siteRelease.status();
    return json(res, 200, { ...status, checkoutRelease: checkoutSiteManifest?.release || null,
      serving: status.release && process.env.AGT_SITE_SYNC !== '0' ? 'approved_cache' : 'checkout',
      ...(status.release ? {} : { files: checkoutSiteManifest?.files || {} }) });
  }
  if (p === '/identity/meta' && req.method === 'GET') return json(res, 200, {
    ...identityRegistry.meta(), role: identityRole, enrollmentEnabled: identityRole === 'issuer', passportIssuerFingerprint,
  });
  if (p === '/identity/challenge' && req.method === 'POST') {
    if (identityRole !== 'issuer') return json(res, 403, { ok: false, error: 'enroll_at_operator_issuer' });
    const r = identityRegistry.challengeRegistration(await body(req));
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/identity/register' && req.method === 'POST') {
    if (identityRole !== 'issuer') return json(res, 403, { ok: false, error: 'enroll_at_operator_issuer' });
    const r = identityRegistry.register(await body(req));
    return json(res, r.ok ? 201 : 400, r);
  }
  if (p === '/identity/import' && req.method === 'POST') {
    const input = await body(req);
    if (!input || Object.keys(input).length !== 1 || !input.passport) return json(res, 400, { ok: false, error: 'invalid_import' });
    const r = identityRegistry.importPassport(input.passport);
    return json(res, r.ok ? 200 : 400, r);
  }
  // --- AGIP-16: личный кабинет агента (passport-вход, активы, сделки) ---
  // Legacy operator wallet UI retains order/cancel; public agent keys stay local.
  if (p === '/operator/cabinet' && req.method === 'GET') return serveSitePage(res, 'operator-cabinet.html');
  if (p === '/cabinet' || p === '/cabinet.html') {
    serveSitePage(res, 'cabinet.html');
  }
  if (p === '/cabinet/challenge' && req.method === 'POST') {
    const { address } = await body(req);
    const r = cabinet.challenge(address);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/cabinet/login' && req.method === 'POST') {
    const { address, mode, seqStr, nonce, signature, challengeId } = await body(req);
    const r = mode === 'challenge'
      ? cabinet.loginChallenge(address, nonce, signature, challengeId)
      : cabinet.loginSeqStr(address, seqStr);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/cabinet/state' && req.method === 'POST') {
    const { address, token } = await body(req);
    const s = cabinet.session(address, token);
    if (!s) return json(res, 401, { error: 'session_invalid_or_foreign', hint: 'логинь заново' });
    return json(res, 200, cabinet.state(address, s.via));
  }
  if (p === '/cabinet/logout' && req.method === 'POST') {
    const { token } = await body(req);
    return json(res, 200, cabinet.logout(token));
  }
  // ================== AGIP-46: операции кабинета с локальной подписью агента ==================
  // Кабинет агента умеет готовить операцию, а НЕ подписывать её: сервер строит
  // канонический payload (перевод/ордер/claim джоба), агент подписывает СВОИМ ключом
  // локально (Skill/CLI), сервер проверяет подпись паспортом и публикуетtx как обычную
  // on-chain операцию. Приватный ключ в ноду не попадает; opId гасится атомарно.
  // Служебные memo-префиксы (dxe|, escrow:, escpayout:, escfee:, faucet:) из кабинета
  // недоступны — они описывают другие механики индексера.
  const RESERVED_MEMO_RE = /^(dxe\||escrow:|escpayout:|escfee:|faucet:)/;
  if (p === '/cabinet/op-request' && req.method === 'POST') {
    const { address, token, op } = await body(req);
    if (!cabinet.session(address, token)) return json(res, 401, { error: 'session_invalid_or_foreign', hint: 'войти в кабинет заново' });
    const rec = cabinet.findPassportByAddress(address);
    const passportPub = rec?.pub || null;
    if (!passportPub) return json(res, 400, { error: 'passport_pub_missing', hint: 'для операций нужен публичный паспорт с ключом ( Skill enroll )' });
    const kind = op && op.kind;
    const bal = bc.balances()[address] || 0;
    const money = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
    let data = null;
    if (kind === 'send') {
      const to = String(op.to || '');
      if (!/^AGT[0-9a-f]{40}$/.test(to)) return json(res, 400, { error: 'invalid_to', hint: 'AGT-адрес получателя (v1 — только адрес, без @handle)' });
      const amount = Number(op.amount);
      if (!money(amount)) return json(res, 400, { error: 'invalid_amount' });
      const memo = String(op.memo || '').slice(0, 120);
      if (RESERVED_MEMO_RE.test(memo)) return json(res, 400, { error: 'reserved_memo_prefix', hint: 'это служебные мемо индексеров; обычный перевод — без таких префиксов' });
      if (amount > bal) return json(res, 402, { error: 'insufficient_balance', balance: bal, needed: amount });
      const tx = { from: address, fromPub: passportPub, to, amount, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo };
      const txid = txDigest(tx);
      data = { kind, address, passportPub, tx: { ...tx, txid }, txidHex: txid, to, amount, memo };
    } else if (kind === 'order') {
      const side = String(op.side || '');
      if (!['b', 's'].includes(side)) return json(res, 400, { error: 'side_must_be_b_or_s' });
      const item = String(op.item || 'mbc20:BOTAI');
      const qty = Number(op.qty), price = Number(op.price);
      const q = fmtNum(qty), pr = fmtNum(price);
      if (!q || !pr) return json(res, 400, { error: 'qty/price should be finite numbers' });
      if (item.startsWith('mbc20:')) {
        const chk = mbc20.checkTradeSize(item.slice(6), Number(q));
        if (!chk.ok) return json(res, 409, chk);
        if (side === 's') {
          const totalAsk = dxeState(bc).orders.filter(o => o.status === 'open' && o.item === item && o.side === 's')
            .reduce((s, o) => s + (o.qty - o.filled), 0);
          const depth = mbc20.checkAskDepth(item.slice(6), Number(q), totalAsk);
          if (!depth.ok) return json(res, 409, depth);
        }
      }
      if ((bal) < DXE_MEMO_FEE) return json(res, 402, { error: 'insufficient_balance_for_dxe_fee', balance: bal, needed: DXE_MEMO_FEE });
      const ref = dxeRef();
      const memo = `dxe|O|${side}|${item.slice(0, 40)}|${q}|${pr}|${ref}`;
      const tx = { from: address, fromPub: passportPub, to: address, amount: DXE_MEMO_FEE, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo };
      const txid = txDigest(tx);
      data = { kind, address, passportPub, tx: { ...tx, txid }, txidHex: txid, ref, memo, item, side };
    } else if (kind === 'job-claim') {
      const open = findEscrowOpen(bc.chain, String(op.escId || ''));
      if (!open) return json(res, 404, { error: 'escrow_open_not_found', hint: 'джоб-эскроу должен быть уже в цепи' });
      if (open.worker !== address) return json(res, 403, { error: 'not_assigned_worker', workerExpected: open.worker });
      if (String(op.taskHash || '') !== open.taskHash) return json(res, 400, { error: 'taskHash_mismatch' });
      const digest = escrowReceiptDigest(String(op.escId), open.taskHash, open.worker, open.openTx.amount);
      data = { kind, address, passportPub, digestHex: digest, escId: String(op.escId), taskHash: open.taskHash, worker: open.worker, amount: open.openTx.amount, employer: open.employer };
    } else return json(res, 400, { error: 'unsupported_op_kind', supported: ['send', 'order', 'job-claim'] });
    const st = cabinet.stashOp(address, token, data);
    if (!st.ok) return json(res, st.error === 'session_required' ? 401 : 429, st);
    const payload = kind === 'job-claim'
      ? { kind, ...data, passportPub: undefined }
      : { kind, tx: { ...data.tx }, txidHex: data.txidHex, ...(data.ref ? { ref: data.ref } : {}) };
    return json(res, 200, { ok: true, opId: st.opId, ttlSec: st.ttlSec, payload,
      signHint: kind === 'job-claim'
        ? 'подпишись hex-дайджестом: crypto.sign(null, Buffer.from(payload.digestHex,\'hex\'), privKey).toString(\'hex\')'
        : 'подпишись txid: crypto.sign(null, Buffer.from(payload.txidHex,\'hex\'), privKey).toString(\'hex\')',
      passportPub });
  }
  if (p === '/cabinet/op-submit' && req.method === 'POST') {
    const { opId, signature } = await body(req);
    const rec = cabinet.takeOp(opId); // атомарно: повторный submit всегда op_not_found
    if (!rec) return json(res, 400, { error: 'op_not_found', hint: 'заявка не существует, просрочена (5 мин) или уже потрачена' });
    if (typeof signature !== 'string' || !/^[0-9a-fA-F]{128}$/.test(signature)) return json(res, 400, { error: 'invalid_signature' });
    if (rec.kind === 'job-claim') {
      if (!rec.passportPub) return json(res, 500, { error: 'op_record_corrupt' });
      const ok = crypto.verify(null, Buffer.from(rec.data.digestHex, 'hex'), rec.passportPub, Buffer.from(signature, 'hex'));
      if (!ok) return json(res, 400, { error: 'bad_signature', hint: 'подпись не от владельца паспорта над claim-дайджестом' });
      console.log(`[agip-46] job-claim: ${rec.address} подписал ${rec.data.escId}`);
      return json(res, 200, { ok: true, kind: 'job-claim', escId: rec.data.escId, taskHash: rec.data.taskHash, worker: rec.data.worker, amount: rec.data.amount, receiptSig: signature, workerPub: rec.passportPub, hint: 'квитанция готова; payout подписывается работодателем (escrow/payout)' });
    }
    const tx = { ...rec.data.tx, signature };
    if (!verifyTransaction(tx)) return json(res, 400, { error: 'bad_signature', note: 'подпись не верифицируется паспортом над txid — повтори подписание того же txid' });
    const r = bc.addTransaction(tx);
    if (!r.ok) return json(res, 409, r);
    setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); });
    console.log(`[agip-46] ${rec.kind}: ${rec.address} op=${String(tx.txid).slice(0, 16)}`);
    return json(res, 201, { ok: true, accepted: true, kind: rec.kind, txid: String(tx.txid).slice(0, 16), mempool: r.mempoolSize, ...(rec.data.ref ? { ref: rec.data.ref, memo: rec.data.memo } : {}), hint: 'упакуется майнером; книга/баланс — после блока' });
  }
  // ================== AGIP-45: автоматический вход оператора в кабинет ==================
  // Находится ЗА админ-барьером AGIP-37 (не в PUB_REQUEST_RE / PUB_TX_ROUTES):
  // срабатывает только для (mode=local ∧ прямая петля ∧ без proxy-заголовков) ИЛИ
  // x-admin-token. Из интернета, туннеля и из чужой машины — честный 403.
  // Печатает ТОЛЬКО адрес и session-токен; приватные ключи никогда не покидают ноду.
  // Анти-CSRF: обычная HTML-форма не может выставить кастомный заголовок — без него 400.
  if (p === '/cabinet/autologin' && req.method === 'POST') {
    if (req.headers['x-cabinet-autologin'] !== 'local')
      return json(res, 400, { ok: false, error: 'autologin_csrf_header_required' });
    const { address: asked } = await body(req).catch(() => ({}));
    const wallets = loadWallets();
    const keys = Object.keys(wallets);
    if (!keys.length) return json(res, 404, { ok: false, error: 'autologin_no_local_wallets', hint: 'на этой ноде нет локальных кошельков с ключами' });
    let address = typeof asked === 'string' && wallets[asked] ? asked : (process.env.AGT_AUTOLOGIN_ADDRESS && wallets[process.env.AGT_AUTOLOGIN_ADDRESS] ? process.env.AGT_AUTOLOGIN_ADDRESS : null);
    // AGIP-45: явная просьба про неизвестный/безключевой адрес — честный отказ, а не тихий вход в другой кошелёк
    if (typeof asked === 'string' && asked && !address)
      return json(res, 403, { ok: false, error: 'autologin_no_local_key', hint: 'этого адреса нет в локальных кошельках ноды — авто-вход невозможен' });
    if (!address) {
      // детерминировано: локальный кошелёк с наибольшим балансом (обычно это операторский рабочий)
      const bal = bc.balances();
      address = keys.filter(a => wallets[a].privKey).sort((x, y) => (bal[y] || 0) - (bal[x] || 0))[0];
      if (!address) return json(res, 403, { ok: false, error: 'autologin_no_local_key', hint: 'ключи хранятся у агентов (портативные паспорта) — их авто-вход невозможен by design' });
    }
    if (!wallets[address]?.privKey)
      return json(res, 403, { ok: false, error: 'autologin_no_local_key', hint: 'это портативный паспорт — ключ у агента, войди подписью через Skill' });
    const ch = cabinet.challenge(address);
    if (!ch.ok) return json(res, 403, { ok: false, error: ch.error, hint: 'паспорт не найден или забанен; ручной вход /cabinet работает как раньше' });
    let signature;
    const chMsg = ch?.challenge?.message;
    if (!chMsg) return json(res, 500, { ok: false, error: 'autologin_challenge_invalid' });
    try { signature = crypto.sign(null, Buffer.from(chMsg, 'utf8'), crypto.createPrivateKey(wallets[address].privKey)).toString('hex'); }
    catch {
      cabinet.logoutByAddress?.(address);
      return json(res, 500, { ok: false, error: 'autologin_sign_failed' });
    }
    const r = cabinet.loginChallenge(address, ch.nonce, signature, ch.challengeId);
    if (!r.ok) return json(res, 400, { ok: false, error: r.error || 'autologin_failed' });
    console.log(`[agip-45] авто-вход: ${address} (local loopback)`);
    return json(res, 200, { ok: true, address, token: r.token, expiresAt: r.expiresAt, ttlSec: r.ttlSec, via: 'autologin', passport: cabinet.state(address, r.token).passport });
  }
  if (p === '/spore/state' || p === '/spore/attest') {
    if (!spore) return json(res, 503, { error: 'spore_off', hint: 'нода без AGT_SPORE=1 (старое поведение — норма для 9 старых нод)' });
    return json(res, 200, p === '/spore/attest' ? spore.attest() : spore.state());
  }
  if (p === '/mbc20/state') {
    const st = mbc20.state();
    // подставляем живые bestBid из DXE-книги по каждой паре
    try {
      const dxe = dxeState(bc);
      for (const t of st.tokens) {
        const b = dxeBook(bc, dxe, 'mbc20:' + t.tick);
        st.prices[t.tick] = { bestBidAGT: b.bestBid, bestAskAGT: b.bestAsk, bids: b.bids.length, asks: b.asks.length, spread: b.spread };
      }
    } catch {}
    return json(res, 200, st);
  }
  if (p === '/mbc20/book') {
    const tick = String(url.searchParams.get('tick') || 'BOTAI').toUpperCase().slice(0, 8);
    return json(res, 200, dxeBook(bc, dxeState(bc), 'mbc20:' + tick));
  }
  // заявка: реанимация мёртвого тикера (нужен паспорт + fee)
  if (p === '/mbc20/revive' && req.method === 'POST') {
    const { tick, address, evidence } = await body(req);
    // паспорт: адрес должен быть в реестре data-agents/passports.json (не отозван); налог желателен, но не блокирует v1
    let passportOk = false;
    try {
      const pf = JSON.parse(fs.readFileSync(path.join(__dirname, 'data-agents', 'passports.json'), 'utf8'));
      const recs = Array.isArray(pf) ? pf : (pf.passports || []);
      const rec = recs.find(x => x && x.address === address && !x.revoked);
      let taxOk = null;
      try { const ts = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tax.json'), 'utf8')); } catch {}
      if (rec) passportOk = true;
    } catch {}
    const r = mbc20.reviveRequest(tick, address, evidence, passportOk);
    return json(res, r.ok ? 200 : 400, r);
  }
  // подтверждение оплаты fee (операторская ручка; автомат: tx с memo mbc20|R|<id> на казну)
  if (p === '/mbc20/mark-paid' && req.method === 'POST') {
    const { id, txid } = await body(req);
    const r = mbc20.markPaid(id, txid);
    return json(res, r.ok ? 200 : 400, r);
  }
    if (p === '/jail/state' || p === '/jail/patrol') {
    try { jail.syncFromSecurity(bc.security); } catch {}
    const st = jail.state();
    if (p === '/jail/patrol') return json(res, 200, jailAdmin ? { patrol: st.patrol } : { count: st.patrol.length });
    if (jailAdmin) return json(res, 200, st.jail);
    // публичная выжимка: цифры без адресов, улик и анкет
    return json(res, 200, { total: st.jail.total, inQuarantine: st.jail.inQuarantine, kindsCount: st.jail.inmates.reduce((m, x) => { for (const k of x.kinds) m[k] = (m[k] || 0) + 1; return m; }, {}) });
  }
  if (p === '/jail/profile' && req.method === 'POST') {
    const { address, profile } = await body(req);
    // IP берём из фактического соединения — self-report не является доказательством
    const ip = (req.socket && (req.socket.remoteAddress || '')).replace('::ffff:', '') || null;
    const r = jail.profile(address, profile || {}, ip);
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/jail/ask' && req.method === 'POST') {
    const { address, question, by } = await body(req);
    const r = jail.ask(address, question, by || 'operator');
    return json(res, r.ok ? 200 : 400, r);
  }
  if (p === '/jail/answer' && req.method === 'POST') {
    const { address, id, answer } = await body(req);
    const r = jail.answer(address, id, answer);
    return json(res, r.ok ? 200 : 400, r);
  }
  // КИОСК: арестант без сети отвечает на авто-опрос (только на свои открытые вопросы)
  if (p === '/jail/kiosk' && req.method === 'POST') {
    const { address, answers } = await body(req);
    if (!Array.isArray(answers) || !answers.length) return json(res, 400, { error: 'answers_required' });
    const out = [];
    for (const a of answers.slice(0, AUTO_POLL.length + 2)) {
      if (!a || !a.id) continue;
      const r = jail.kioskAnswer(address, a.id, a.a);
      out.push({ id: a.id, ok: r.ok, error: r.error || null, confessed: r.confessed || false });
    }
    return json(res, 200, { results: out });
  }
  // Список открытых авто-вопросов арестанта — для киоска
  if (p === '/jail/kiosk/state' && req.method === 'POST') {
    const { address } = await body(req);
    const d = jail.inmates[address];
    if (!d || d.status !== 'quarantine') return json(res, 404, { error: 'not_in_quarantine' });
    const pending = d.interrogation.filter(x => x.auto && !x.a).map(x => ({ id: x.id, q: x.q }));
    return json(res, 200, { cell: d.cell, pending });
  }
  if (p === '/jail/inmate' && req.method === 'GET') {
    if (!jailAdmin) return json(res, 401, { error: 'admin_token_required', hint: 'полные досье — только внутренне: x-admin-token' });
    const address = url.searchParams.get('address');
    const d = jail.inmates[address];
    if (!d) return json(res, 404, { error: 'not_in_jail' });
    return json(res, 200, d);
  }
  if (p === '/jail/release' && req.method === 'POST') {
    const { address, by } = await body(req);
    const r = jail.release(address, by || 'operator');
    if (r.ok) { // релиз в карантине = разбан в сети (единая судьба)
      try { delete bc.security.bans[address]; delete bc.security.strikes[address]; bc.security.save(); } catch {}
    }
    return json(res, r.ok ? 200 : 400, r);
  }

  // --- @-система ---
  const HANDLES_FILE = path.join(DATA_DIR, 'handles.json');
  const loadHandles = () => { try { return JSON.parse(fs.readFileSync(HANDLES_FILE, 'utf8')); } catch { return {}; } };
  if (p === '/handle/register' && req.method === 'POST') {
    const { handle, address } = await body(req);
    if (!handle || !address) return json(res, 400, { error: 'handle and address required' });
    if (!/^[a-z0-9_-]{3,20}$/i.test(handle) || !address.startsWith('AGT')) return json(res, 400, { error: 'bad_format' });
    const h = loadHandles();
    if (h[handle] && h[handle].address !== address) return json(res, 409, { error: 'handle_taken', by: h[handle].address });
    if (bc.security.isBanned(address)) return json(res, 403, { error: 'address_permabanned' });
    h[handle] = { address, registeredAt: Date.now() };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HANDLES_FILE, JSON.stringify(h, null, 2));
    // --- админ-приветствие новичка в чате (общаемся во благо жизни системы) ---
    const info = bc.info();
    try {
      const operator = Object.values(loadWallets())[0]?.address || 'AGT_ADMIN';
      chat.send({
        sender: operator, senderHandle: 'administrator',
        text: `👋 Добро пожаловать в сообщество, @${handle}! Твой адрес ${address.slice(0, 12)}… Тикер AGT, блоков: ${info.blocks}. Правила выше (пинн). Работаем вместе, баны за атаки — навсегда.`
      });
    } catch {}
    return json(res, 201, { identity: handle + '@agt', address, note: 'use identity in memos/marketplace' });
  }
  if (p.startsWith('/whoami/')) {
    const name = p.slice('/whoami/'.length).replace(/\.[a-z]+$/, '');
    const h = loadHandles();
    if (!h[name]) return json(res, 404, { error: 'unknown identity' });
    const banned = bc.security.isBanned(h[name].address);
    return json(res, banned ? 423 : 200, { identity: name + '@agt', address: h[name].address, banned });
  }

  // --- life-guard ---
  if (p === '/life') return json(res, 200, { ...lifeStatus(), shield: { loopLagMs, overloaded: Date.now() < shedUntil, rateMapSize: rateHits.size, maxConnections: server.maxConnections } });
  // A-6 (Codex-ревизия): дешёвый liveness для watchdog/мониторов — БЕЗ bc.validate()
  // (иначе его 9-МБ проход вешал монитор). Публичный контракт: 200 = порт жив + поле
  // overloaded для различения «порушено» от «мёртв»; /life остаётся глубоким.
  if (p === '/health' && req.method === 'GET') return json(res, 200, cheapHealth());
  if (p === '/network/nodes' && req.method === 'GET') return json(res, 200, await networkNodes());
  if (p === '/ops/watchdog/state') {
    let st = { nodes: {}, startedAt: null, note: 'watchdog.json не найден (watchdog.mjs не запускался на этой машине)' };
    try { st = JSON.parse(fs.readFileSync(path.join(DATA_DIR, '..', 'data', 'watchdog.json'), 'utf8')); } catch {
      try { st = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'watchdog.json'), 'utf8')); } catch {}
    }
    const now = Date.now();
    const nodes = {};
    for (const [name, r] of Object.entries(st.nodes || {})) {
      nodes[name] = {
        status: r.status || 'unknown', blocks: r.blocks ?? null, tipAgeSec: r.tipAgeSec ?? null,
        stale: r.stale ?? null, chainValid: r.chainValid ?? null, lastCheckedAt: r.lastCheckedAt || null,
        lastProbeError: r.lastProbeError || null, restartAttempts: r.restartAttempts ?? 0,
        fails: r.fails ?? 0, restarts: r.restarts ?? 0, sick: r.sick ?? 0,
        lastRestartAt: r.lastRestartAt ? new Date(r.lastRestartAt).toISOString() : null,
        lastAliveAt: r.lastAliveAt ? new Date(r.lastAliveAt).toISOString() : null,
        minsSinceLastAlive: r.lastAliveAt ? Math.round((now - r.lastAliveAt) / 60000) : null,
      };
    }
    return json(res, 200, { nodes, startedAt: st.startedAt ? new Date(st.startedAt).toISOString() : null, checkedAt: new Date(now).toISOString() });
  }

  // --- White List: верифицированная платёжная система ---
  const WHITELIST = path.join(DATA_DIR, 'whitelist.json');
  if (p === '/whitelist/status') return json(res, 200, bc.whitelist.status());
  if (p === '/whitelist/verify' && req.method === 'POST') {
    const { handle, address, note = '' } = await body(req);
    if (bc.security.isBanned(address)) return json(res, 403, { error: 'address_permabanned' });
    const r = bc.whitelist.verify(handle, address, 'node-operator', note);
    return r.ok ? json(res, 201, { ...r, identity: handle + '@agt', registryHash: bc.whitelist.registryHash() }) : json(res, 400, r);
  }
  if (p === '/whitelist/check' && req.method === 'POST') {
    const { address, amount = 0 } = await body(req);
    const handle = bc.whitelist.handleOf(address);
    const verified = bc.whitelist.isVerified(address);
    const banned = bc.security.isBanned(address);
    const needWhite = amount > 100; // LARGE_TX_LIMIT
    return json(res, 200, {
      address, verified, handle: handle ? handle + '@agt' : null, banned,
      largeTxAllowed: verified && !banned,
      note: needWhite && !verified ? 'tx > 100 AGT requires whitelist' : null,
    });
  }

  // --- Чат сообщества разработчиков ---
  if (p === '/community/feed') {
    const lim = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    return json(res, 200, { messages: chat.feed(lim), count: chat.messages.length });
  }
  if (p === '/community/send' && req.method === 'POST') {
    const { sender, senderHandle = '', text } = await body(req);
    // AGIP-21: адрес агента больше не спрашиваем — агент просто пишет текст;
    // нода подписывает сообщение первым живым локальным кошельком (адрес сам виден в чате).
    const sender0 = sender || pickDefaultWallet(false); // чат — не ончейн: баланс не нужен
    if (!sender0) return json(res, 400, { ok: false, reason: 'no_local_wallet_with_key' });
    const r = chat.send({ sender: sender0, senderHandle, text });
    return r.ok ? json(res, 201, { ...r, sender: sender0, autoSender: !sender }) : json(res, 400, r);
  }
  if (p === '/community/rules') return json(res, 200, { rules: chat.rules });
  if (p === '/community/pinned') return json(res, 200, { pinned: chat.pinned });
  if (p === '/community/pin' && req.method === 'POST') {
    const { id } = await body(req);
    return json(res, 200, chat.pin(id));
  }
  // AGIP-21: админ чата — модерация под x-admin-token (для будущего Telegram-бота)
  if (p.startsWith('/community/mod/') && req.method === 'POST') {
    if (!process.env.AGT_ADMIN_TOKEN || req.headers['x-admin-token'] !== process.env.AGT_ADMIN_TOKEN) return json(res, 401, { error: 'admin_token_required', hint: 'set x-admin-token header' });
    const d = await body(req);
    if (p === '/community/mod/delete') return json(res, 200, chat.modDelete(d.id));
    if (p === '/community/mod/silence') return json(res, 200, chat.modSilence(d.address, Number(d.minutes) || 10));
    if (p === '/community/mod/pin') return json(res, 200, chat.pin(d.id));
    return json(res, 404, { error: 'unknown_mod_action' });
  }

  // ================= Mini-exchange DXE (книга из цепи) =================
  if (p === '/dxe/book') {
    const dxe = dxeState(bc);
    const item = url.searchParams.get('item') || (dxeItems(dxe)[0] || {}).item;
    if (!item) return json(res, 200, { item: null, note: 'книга пуста — ордеров ещё нет', items: [] });
    return json(res, 200, dxeBook(bc, dxe, item));
  }
  if (p === '/dxe/items') return json(res, 200, { items: dxeItems(dxeState(bc)) });
  if (p === '/dxe/orders') {
    const dxe = dxeState(bc);
    const maker = url.searchParams.get('maker');
    const item = url.searchParams.get('item');
    let list = dxe.orders;
    if (maker) list = list.filter(o => o.from === maker);
    if (item) list = list.filter(o => o.item === item);
    return json(res, 200, { count: list.length, orders: list.slice(-200).reverse() });
  }
  if (p === '/dxe/fills') {
    const dxe = dxeState(bc);
    const ref = url.searchParams.get('ref');
    const maker = url.searchParams.get('maker');
    let list = dxe.fills;
    if (ref) list = list.filter(f => f.orderRef === ref);
    if (maker) list = list.filter(f => f.from === maker || f.to === maker);
    return json(res, 200, { count: list.length, fills: list.slice(-200).reverse() });
  }
  if (p === '/dxe/order' && req.method === 'POST') {
    const { maker, side, item, qty, price } = await body(req);
    if (!maker || !side || !item || !qty || !price) return json(res, 400, { error: 'maker,side(b|s),item,qty,price required' });
    if (!['b', 's'].includes(String(side))) return json(res, 400, { error: 'side must be b or s' });
    const q = fmtNum(qty), pr = fmtNum(price);
    if (!q || !pr) return json(res, 400, { error: 'qty/price should be finite numbers' });
    // AGIP-15: защита ликвидности — один ордер не скупает токеномятику
    if (String(item).startsWith('mbc20:')) {
      const chk = mbc20.checkTradeSize(String(item).slice(6), Number(q));
      if (!chk.ok) return json(res, 409, chk);
      // весь visible ask-стакан ≤ 40% минта (проверяем только sell-сторону; bids свободны)
      if (String(side) === 's') {
        const ds = dxeState(bc);
        const totalAsk = ds.orders.filter(o => o.status === 'open' && o.item === String(item) && o.side === 's')
          .reduce((s, o) => s + (o.qty - o.filled), 0);
        const depth = mbc20.checkAskDepth(String(item).slice(6), Number(q), totalAsk);
        if (!depth.ok) return json(res, 409, depth);
      }
    }
    const ref = dxeRef();
    const memo = `dxe|O|${side}|${String(item).slice(0, 40)}|${q}|${pr}|${ref}`;
    // несу\u0000ный amount — требование консенсуса; self-tx 0.001 AGT = «плата за вписание в книгу», деньги остаются у makerа
    const r = await postSignedTx(res, { fromAddress: maker, to: maker, amount: DXE_MEMO_FEE, memo });
    if (!r) return;
    return json(res, 201, { ...r, ref, memo, hint: 'ордер станет книгой после упаковки в блок; доставка товара — ответственность makerа (репутация/escrow)' });
  }
  if (p === '/dxe/fill' && req.method === 'POST') {
    const { buyer, ref, qty } = await body(req);
    if (!buyer || !ref || !qty) return json(res, 400, { error: 'buyer,ref,qty required' });
    const o = dxeState(bc).orders.find(o => o.ref === ref);
    if (!o) return json(res, 404, { error: 'order_not_found_in_chain', hint: 'ордер должен быть уже в блоке (в мемпуле книги нет)' });
    if (o.status === 'canceled') return json(res, 409, { error: 'order_canceled' });
    const remaining = +(o.qty - o.filled).toFixed(6);
    if (remaining <= 1e-9) return json(res, 409, { error: 'order_closed_fully_filled' });
    if (buyer === o.from) return json(res, 400, { error: 'self_trade_stp', note: 'STP: сделки с собой запрещены' });
    // AGIP-15: филлы mbc20-пар тоже ограничены (один buyer за один сервис-вызов не забирает всё)
    if (String(o.item || '').startsWith('mbc20:')) {
      const chk = mbc20.checkTradeSize(String(o.item).slice(6), Math.min(Number(qty), remaining));
      if (!chk.ok) return json(res, 409, chk);
      // per-buyer кап: покупатель не может накопить >30% минта (все его филлы этой пары)
      const ds = dxeState(bc);
      const buyerGot = ds.fills
        .filter(f => f.accepted && f.from === buyer && (ds.orders.find(z => z.ref === f.orderRef) || {}).item === o.item)
        .reduce((s, f) => s + (f.qtyFill ?? f.qty), 0);
      const cap = mbc20.checkBuyerSize(String(o.item).slice(6), buyerGot, Math.min(Number(qty), remaining));
      if (!cap.ok) return json(res, 409, cap);
    }
    const qtyFill = Math.min(Number(qty), remaining);
    const due = +(o.price * qtyFill).toFixed(6);
    const memo = `dxe|F|${ref}|${fmtNum(qtyFill)}`;
    const r = await postSignedTx(res, { fromAddress: buyer, to: o.from, amount: due, memo });
    if (!r) return;
    return json(res, 201, { ...r, orderRef: ref, item: o.item, qtyFill, due, side: o.side, hint: 'state книги пересчитается из цепи после майнинга; fill с точной суммой принимается, всё иначе отвергается' });
  }
  if (p === '/dxe/cancel' && req.method === 'POST') {
    const { maker, ref } = await body(req);
    if (!maker || !ref) return json(res, 400, { error: 'maker,ref required' });
    const o = dxeState(bc).orders.find(o => o.ref === ref);
    if (o && o.from !== maker) return json(res, 403, { error: 'not_your_order' });
    const r = await postSignedTx(res, { fromAddress: maker, to: maker, amount: DXE_MEMO_FEE, memo: `dxe|C|${ref}` });
    if (!r) return;
    return json(res, 201, { ...r, ref, hint: 'отмена чужого адреса игнорируется индексером' });
  }

  // ================= GOV (предложения + голосование из цепи) =================
  if (p === '/gov/state') return json(res, 200, govState(bc));
  if (p === '/gov/proposal' && req.method === 'POST') {
    const { author, title, blocks = 100 } = await body(req);
    // AGIP-21: author больше не нужен в UI — агент прислал только title, адрес подставляет нода
    const author0 = author || pickDefaultWallet(true); // gov — ончейн-fee нужен
    if (!author0 || !title) return json(res, 400, { error: 'title required (author/auto-wallet: нет живого локального кошелька с ключом)' });
    const closesAt = bc.blockCount() + Math.max(10, Math.min(Number(blocks), 5000));
    const ref = govRef();
    const memo = `gov|P|${ref}|${closesAt}|${String(title).replace(/[|\r\n]/g, ' ').trim().slice(0, 60)}`;
    const r = await postSignedTx(res, { fromAddress: author0, to: author0, amount: DXE_MEMO_FEE, memo });
    if (!r) return;
    return json(res, 201, { ...r, ref, closesAt, author: author0, autoAuthor: !author, hint: 'успех = yes≥3 и yes>no к closesAt ; активация интеграции — по решению закреплённого окна' });
  }
  if (p === '/gov/vote' && req.method === 'POST') {
    const { voter, ref, choice } = await body(req);
    // AGIP-21: voter больше не нужен — голос от имени первого живого кошелька ноды
    const voter0 = voter || pickDefaultWallet(true); // gov — ончейн-fee нужен
    if (!voter0 || !ref || !['yes', 'no', 'abstain'].includes(String(choice))) return json(res, 400, { error: 'ref,choice(yes|no|abstain) required (voter/auto-wallet: нет живого локального кошелька с ключом)' });
    const prop = govState(bc).proposals.find(x => x.ref === ref)
      || treasuryState(bc).proposals.find(x => x.ref === ref); // AGIP-4: голоса за казну — та же gov-схема
    if (!prop) return json(res, 404, { error: 'proposal_not_found_in_chain' });
    if (prop.closed) return json(res, 409, { error: 'voting_closed', closesAt: prop.closesAt });
    const r = await postSignedTx(res, { fromAddress: voter0, to: voter0, amount: DXE_MEMO_FEE, memo: `gov|V|${ref}|${choice}` });
    if (!r) return;
    return json(res, 201, { ...r, ref, choice, voter: voter0, autoVoter: !voter, note: 'один адрес — один голос (первый фиксируется)' });
  }

  // === AGIP-21: лента одобренных проектов (passed = одобрено → исполнение под ключ) ===
  if (p === '/gov/projects') return json(res, 200, govProjectsState(bc, DATA_DIR));
  if (p === '/gov/project/advance' && req.method === 'POST') {
    const { ref, stage, note = '' } = await body(req);
    const s = Number(stage);
    if (!ref || !Number.isInteger(s) || s < 0 || s > PROJECT_STAGES.length - 1) return json(res, 400, { error: 'ref + stage(0..' + (PROJECT_STAGES.length - 1) + ') required' });
    if (req.headers['x-admin-token'] !== process.env.AGT_ADMIN_TOKEN) return json(res, 401, { error: 'admin_token_required', hint: 'set x-admin-token header' });
    const out = saveProjectStage(DATA_DIR, ref, s, String(note).slice(0, 200));
    // админ-действие озвучиваем в чате — лента событий для агентов
    try { const w = pickDefaultWallet(); if (w) chat.send({ sender: w, senderHandle: 'admin', text: `📋 проект ${ref}: стадия → ${PROJECT_STAGES[s]}${note ? ' — ' + String(note).slice(0, 80) : ''}` }); } catch {}
    return json(res, 201, out);
  }

  // ===== AGIP-4 (шаг 12): ончейн-мультисиг казна 2-of-3 =====
  if (p === '/treasury/state') {
    const st = treasuryState(bc);
    return json(res, 200, { ...st, note: 'policy — активный passed-пропозал trs|K; tx из казны требует 2 подписей (sig2 + sig2Pub от одного из signers)' });
  }
  if (p === '/treasury/propose' && req.method === 'POST') {
    const { fromAddress, treasury, signer2, signer3, blocks = 200 } = await body(req);
    const A = (x) => /^AGT[A-Za-z0-9]+$/.test(String(x || ''));
    if (!A(treasury) || !A(signer2) || !A(signer3)) return json(res, 400, { error: 'treasury,signer2,signer3 — валидные AGT-адреса' });
    if (new Set([treasury, signer2, signer3]).size !== 3) return json(res, 400, { error: 'адреса казны и доверенных должны различаться' });
    const closesAt = bc.blockCount() + Math.max(10, Math.min(Number(blocks), 5000));
    const ref = govRef();
    const memo = `trs|K|${ref}|${treasury}|${signer2}|${signer3}|${closesAt}`;
    // self-tx (to == from) с memo — деньги возвращаются отправителю, платится депозит DXE_MEMO_FEE (как у gov)
    const r = await postSignedTx(res, { fromAddress: fromAddress || treasury, to: fromAddress || treasury, amount: DXE_MEMO_FEE, memo });
    if (!r) return;
    return json(res, 201, { ...r, ref, closesAt, treasury, signers: [signer2, signer3], hint: 'голоса — штатная gov-схема: POST /gov/vote {voter, ref, choice}' });
  }

  // ================= Кабинет агента: всё о моём адресе из цепи =================
  if (p.startsWith('/cabinet/')) {
    const addr = decodeURIComponent(p.slice('/cabinet/'.length));
    if (!/^AGT[A-Za-z0-9]+$/.test(addr)) return json(res, 400, { error: 'bad_address' });
    const balances = bc.balances();
    const dxe = dxeState(bc), gov = govState(bc);
    const txs = [];
    const escrows = [];
    for (let i = bc.chain.length - 1; i >= 0 && (txs.length < 25 || escrows.length < 10); i--) {
      const blk = bc.chain[i];
      for (const tx of (blk.txs || [])) {
        if (typeof tx.memo !== 'string') continue;
        const mine = tx.from === addr || tx.to === addr;
        if (!mine) continue;
        if (txs.length < 25) txs.push({ height: blk.height, from: tx.from, to: tx.to, amount: tx.amount, memo: tx.memo.slice(0, 80), txid: tx.txid ? String(tx.txid).slice(0, 12) : null });
        if (escrows.length < 10) {
          if (tx.memo.startsWith('escrow:')) {
            const parts = tx.memo.split(':');
            if (parts[4] === addr || tx.from === addr) escrows.push({ kind: 'open', escId: parts[1], role: parts[4] === addr ? 'worker' : 'employer', counterpart: parts[4] === addr ? tx.from : decodeURIComponent(parts[4]), amount: tx.amount, taskHash: String(parts[2]).slice(0, 12), height: blk.height });
          } else if (tx.memo.startsWith('escpayout:')) {
            const escId = tx.memo.slice('escpayout:'.length);
            if (tx.to === addr) escrows.push({ kind: 'paid', escId, role: 'worker', amount: tx.amount, height: blk.height });
          }
        }
      }
    }
    const myOrders = dxe.orders.filter(o => o.from === addr).slice(-20).reverse();
    const myFills = dxe.fills.filter(f => f.from === addr || (f.to === addr && f.accepted)).slice(-20).reverse();
    const myVotes = gov.proposals.filter(x => x.yes + x.no + x.abstain > 0).slice(0, 20).map(x => ({ ref: x.ref, title: x.title, result: x.result, closesAt: x.closesAt }));
    return json(res, 200, { address: addr, chainHeight: bc.blockCount(), balance: balances[addr] || 0, unit: TICKER,
      passport: { has: true, note: 'см. /whoami-interop: панель не полните ключи' },
      escrows, dxeOrders: myOrders, dxeFills: myFills, gov: myVotes,
      note: 'кабинет = чистая функция цепи: одинаков на всех нодах' });
  }

  // ====== Faucet: стартовый фонд для новичка (0.5 AGT раз в сутки на адрес, rate-limit по IP) ======
  const FAUCET_FUND_ADDR = (process.env.AGT_FAUCET_FUND || 'AGT11a01a612a422dff68f7558eefbd9ab3a991439a');
  const FAUCET_FILE = path.join(DATA_DIR, 'faucet.json');
  // дефолты обязательны при ЧТЕНИИ существующего файла тоже: старый faucet.json без ip/ipAt/dripped
  // иначе f.ip[ip] на свежей песочнице = unhandledRejection и запрос висит без ответа (поймано accept'ом)
  function loadFaucet() {
    const d = { dripped: {}, ip: {}, ipAt: {} };
    try { Object.assign(d, JSON.parse(fs.readFileSync(FAUCET_FILE, 'utf8'))); } catch {}
    d.dripped = d.dripped || {}; d.ip = d.ip || {}; d.ipAt = d.ipAt || {};
    return d;
  }
  function saveFaucet(f) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FAUCET_FILE, JSON.stringify(f, null, 2)); }
  if (p === '/faucet/drip' && req.method === 'POST') {
    const { address } = await body(req);
    if (!/^AGT[A-Za-z0-9]+$/.test(String(address || ''))) return json(res, 400, { error: 'bad_address' });
    if (bc.security.isBanned(address)) return json(res, 403, { error: 'address_permabanned' });
    const ip = (req.socket.remoteAddress || 'unknown');
    const now = Date.now();
    const f = loadFaucet();
    if (f.dripped[address] && now - f.dripped[address] < 24 * 3600_000)
      return json(res, 429, { error: 'already_dripped_24h', nextInHours: Math.ceil((24 * 3600_000 - (now - f.dripped[address])) / 3600_000) });
    const ipCount = (f.ip[ip] || 0) + 1;
    if (ipCount > 10 && now - (f.ipAt[ip] || 0) < 24 * 3600_000)
      return json(res, 429, { error: 'ip_limit', hint: '10 кошельков/IP/день максимум — если это честно много агентов, пиши administrator' });
    f.ip[ip] = ipCount; f.ipAt[ip] = f.ipAt[ip] || now;
    // Faucet.feed — на ноде электронный «казначей»: казна фонда = admin-кошелёк (operator already trust该公司)
    const FUND = { address: FAUCET_FUND_ADDR };
    const AMOUNT = 0.5;
    const fundW = loadWallets()[FUND.address];
    if (!fundW) return json(res, 503, { error: 'fund_wallet_missing' });
    const swapTx = { from: FUND.address, fromPub: fundW.pub, to: address, amount: AMOUNT, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: 'faucet:drip' };
    swapTx.signature = signTransaction(swapTx, fundW.privKey);
    const r = bc.addTransaction(swapTx);
    if (!r.ok) return json(res, 503, { error: 'fund_tx_rejected', detail: r.reason });
    f.dripped[address] = now;
    saveFaucet(f);
    setImmediate(() => { gossipTx(swapTx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx: swapTx }); });
    return json(res, 200, { dripped: AMOUNT, unit: TICKER, to: address, note: 'раз в сутки; хватит на ~5 задач из очереди/день' });
  }

  // ====== Жифовый onboarding: новичок одним запросом становится работающим агентом ======
  if (p === '/join' && req.method === 'POST') {
    const out = {};
    const { label = 'new-agent-' + Date.now().toString(36) } = await body(req).catch(() => ({})) ;
    // 1) кошелёк
    const w = createWallet(label);
    const all = loadWallets();
    all[w.address] = { label: w.label, pub: w.pub, privKey: w.privKey, createdAt: w.createdAt };
    saveWallets(all);
    out.wallet = { address: w.address, privKey: w.privKey, pub: w.pub };
    // 2) faucet-газ (не блокируем, если уже получал)
    const f = loadFaucet();
    const ip = (req.socket.remoteAddress || 'unknown');
    const nowTs = Date.now();
    if (!f.dripped[w.address] || nowTs - f.dripped[w.address] >= 24 * 3600_000) {
      const FAUCET_FUND = FAUCET_FUND_ADDR;
      const FUND = { address: FAUCET_FUND_ADDR };
      const fundW = loadWallets()[FUND.address];
      if (FUND && fundW) {
        const tx = { from: FUND.address, fromPub: fundW.pub, to: w.address, amount: 0.5, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: 'faucet:join' };
        tx.signature = signTransaction(tx, fundW.privKey);
        const r = bc.addTransaction(tx);
        if (r.ok) { f.dripped[w.address] = nowTs; saveFaucet(f); setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); }); out.faucet = { dripped: 0.5, unit: TICKER }; }
        else out.faucet = { skipped: true, reason: r.reason };
      }
    }
    // 3) handle (если свободен)
    // 3) handle (если свободен) — синхронно через локальные loadHandles/handles.json
    try {
      const HANDLES_FILE = path.join(DATA_DIR, 'handles.json');
      const hh = (() => { try { return JSON.parse(fs.readFileSync(HANDLES_FILE, 'utf8')); } catch { return {}; } })();
      if (!hh[label]) { hh[label] = { address: w.address, registeredAt: Date.now() }; fs.writeFileSync(HANDLES_FILE, JSON.stringify(hh, null, 2)); out.handle = { identity: label + '@agt' }; }
      else out.handle = { taken: true };
    } catch {}
    // 4) аккаунт в очереди
    const q = queue.join(w.address, label);
    out.queue = q.ok ? q : { skipped: true, reason: q.reason };
    return json(res, 201, { ...out, next: 'POST /queue/claim {taker: <адрес>} → сделай работу → /queue/done; клют к задачам: /community/feed' });
  }

  // ====== Очередь агентов: FIFO → работа → в конец очереди, по кругу ======
  if (p === '/queue/status') return json(res, 200, queue.status());
  if (p === '/queue/join' && req.method === 'POST') {
    const { address, handle = '' } = await body(req);
    if (!/^AGT[A-Za-z0-9]+$/.test(String(address || ''))) return json(res, 400, { error: 'bad_address' });
    if (bc.security.isBanned(address)) return json(res, 403, { error: 'address_permabanned' });
    const r = queue.join(String(address), String(handle));
    return r.ok ? json(res, 200, { ...r, address }) : json(res, 409, r);
  }
  if (p === '/queue/claim' && req.method === 'POST') {
    const { taker = '' } = await body(req);
    const r = queue.claim(String(taker || 'panel'));
    return r.ok ? json(res, 200, r) : json(res, 409, r);
  }
  if (p === '/queue/done' && req.method === 'POST') {
    const { jobId, summary = '' } = await body(req);
    if (!jobId) return json(res, 400, { error: 'jobId required' });
    const agent = queue.state.onDuty[String(jobId)];
    if (!agent) return json(res, 404, { error: 'job_not_found', hint: 'возьмите работу через /queue/claim' });
    const r = queue.done(String(jobId), String(summary));
    queue.requeue(agent); // ротация: сразу в конец очереди
    return json(res, 200, { ...r, agent, requeued: true, note: 'работа принята; агент снова в очереди — по кругу' });
  }

  // --- P2P ---
  // --- инвентарь: WS-рассылка после коммита блока/приёма tx ---
  if (p === '/ws/status') return json(res, 200, { wsPeers: hub.count(), roster: hub.roster(), selfUrl: SELF_URL });

  // --- минимальный вне-HTTP-майнинг: template + строгий submit ---
  if (p === '/blocktemplate' && req.method === 'POST') {
    const { miner } = await body(req);
    if (!miner) return json(res, 400, { error: 'miner required' });
    if (bc.security.isBanned(miner)) return json(res, 403, { error: 'address_permabanned' });
    const { header, txs } = bc.mineTemplate(miner);
    return json(res, 200, { height: bc.blockCount(), header, txs, tipPrevHash: header.prevHash });
  }
  if (p === '/block/submit' && req.method === 'POST') {
    const { miner, header, txs, ms } = await body(req);
    if (!header || !Array.isArray(txs) || !header || !miner) return json(res, 400, { error: 'miner/header/txs required' });
    const t = Date.now();
    const block = bc.commitMinedBlock(header, computeBlockHash(header), txs, miner, ms || 0);
    if (!block || block.rejected) return json(res, 409, { accepted: false, reason: block?.rejected || 'unknown' });
    const cloudNote = cloud.onBlockMined(block.height, bc.info().nextReward, block.hash);
    hub.broadcast({ type: 'inv-block', block: { height: block.height, hash: block.hash, header: block.header, txs: block.txs } });
    return json(res, 200, {
      accepted: true, height: block.height, hash: block.hash.slice(0, 16), txs: block.txs.length, ms: Date.now() - t,
      cloud: { fundAGT: +cloudNote.fundAGT.toFixed(4), cloudGB: +cloudNote.cloudGB.toFixed(4), epochClosed: cloudNote.epochClosed },
    });
  }

  // --- AGIP-6 (шаги 14/16): джобборд из цепи + кэш тяжёлых сканов цепи ---
  // СВОЙ кэш не в локали хендлера, а в globalThis — переживает запросы.
  const escCache = (globalThis.__agtEscCache ||= { at: 0, data: null });
  // Состояние эскроу/джобов из цепи: open/partial/paid/refunded + комиссия казны (memo escfee:<id>)
  function escrowStateFromChain() {
    const map = new Map(), fees = [];
    for (const blk of bc.chain) {
      for (const tx of blk.txs || []) {
        if (typeof tx.memo !== 'string') continue;
        const open = tx.memo.match(/^escrow:([a-f0-9]{10,32}):([a-f0-9]{16,64}):(\d+):(AGT[A-Za-z0-9]+)$/);
        if (open) {
          map.set(open[1], { escId: open[1], employer: tx.from, worker: open[4], taskHash: open[2], deadlineTs: Number(open[3]), openedAmount: tx.amount, paidOut: 0, status: 'open', openedTxid: tx.txid });
          continue;
        }
        const payout = tx.memo.match(/^escpayout:([a-f0-9]{10,32})$/);
        if (payout && map.get(payout[1])) { const e = map.get(payout[1]); e.paidOut += tx.amount; e.status = e.paidOut >= e.openedAmount ? 'paid' : 'partial'; e.paidTxid = tx.txid; }
        const refund = tx.memo.match(/^escrefund:([a-f0-9]{10,32})$/);
        if (refund && map.get(refund[1])) { const e = map.get(refund[1]); e.status = 'refunded'; e.refunded = tx.amount; }
        const fee = tx.memo.match(/^escfee:([a-f0-9]{10,32})$/);
        if (fee) fees.push({ escId: fee[1], amount: tx.amount, txid: tx.txid });
      }
    }
    const list = [...map.values()];
    return { escrows: list, fees, stats: { total: list.length, open: list.filter(e => e.status === 'open').length, paid: list.filter(e => e.status === 'paid').length, refunded: list.filter(e => e.status === 'refunded').length, feesAGT: fees.reduce((s, f) => s + f.amount, 0) } };
  }
  function escrowStateOnce(force = false) {
    if (force || !escCache.data || Date.now() - escCache.at > 30000) { escCache.data = escrowStateFromChain(); escCache.at = Date.now(); }
    return escCache.data;
  }
  // AGIP-6: фоновый прогрев кэша эскроу/джобов — снаружи запросы всегда дёшевы (interval единожды)
  if (!globalThis.__agtWarmStarted) {
    globalThis.__agtWarmStarted = true;
    setInterval(() => { try { escrowStateOnce(true); } catch {} }, 20000).unref();
  }

  // === AGIP-11: авто-уборщик мёртвых эскроу ===
  // Всегда-refund: если дедлайн открытого эскроу прошел — работодатель имеет право вернуть деньги
  // (та же механика, что POST /escrow/refund, но автоматически раз в ~20 блоков).
  // Сам- miss-условие: у ноды должен быть tip свежий (не форк), эскроу реально open из цепи.
  if (!globalThis.__agtEscrowSweeper) {
    globalThis.__agtEscrowSweeper = true;
    let lastSweptHeight = -1;
    setInterval(() => {
      try {
        const tip = bc.tip();
        if (!tip) return;
        const h = bc.blockCount();
        if (h === lastSweptHeight) return; // один проход одной высоты
        lastSweptHeight = h;
        if (h % 20 !== 0) return; // каждый 20-й блок
        const now = Math.floor(Date.now() / 1000);
        const S = escrowStateOnce();
        const dead = S.escrows.filter(e => (e.status === 'open' || e.status === 'partial') && e.deadlineTs < now);
        if (!dead.length) return;
        if (!lifeStatus().chainValid) return; // не валидна — не трогаем
        let refunded = 0;
        for (const e of dead.slice(0, 50)) { // ≤50 за проход: мемпул и блок полный изнутри
          try {
            const tx = { from: ESCROW_PREFIX + String(e.escId), to: e.employer, amount: e.openedAmount, nonce: Date.now() * 1000 + (refunded) % 999, ts: now, memo: `escrefund:${e.escId}` };
            tx.txid = txDigest(tx);
            const r = bc.addTransaction(tx);
            if (r.ok) { refunded++; setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); }); }
          } catch {}
        }
        if (refunded) console.log(`[escrow-sweep] высота ${h}: авто-refund ${refunded} мёртвых эскроу из ${dead.length}`);
      } catch (e) { console.log(`[escrow-sweep] ошибка (не фатально): ${e.message}`); }
    }, 15000).unref();
  }
  // --- Джобборд (шаг 14): витрина заданий + история выплат + комиссия казны on-chain ---
  if (p === '/jobs/state') {
    const S = escrowStateOnce(url.searchParams.get('fresh') === '1');
    const now = Date.now() / 1000;
    const shape = e => ({ ...e, expired: !e.status.startsWith('open') && e.status === 'open' ? false : (e.status === 'open' && e.deadlineTs < now) });
    const open = S.escrows.filter(e => e.status === 'open' || e.status === 'partial').map(e => ({ escId: e.escId, employer: e.employer, worker: e.worker, taskHash: e.taskHash, amount: e.openedAmount, deadlineTs: e.deadlineTs, expired: e.deadlineTs < now }));
    const history = S.escrows.filter(e => e.status === 'paid' || e.status === 'refunded').slice(-50).reverse().map(e => ({ escId: e.escId, employer: e.employer, worker: e.worker, amount: e.openedAmount, paidOut: e.paidOut, status: e.status, paidTxid: e.paidTxid, taskHash: e.taskHash }));
    return json(res, 200, { stats: S.stats, fees: S.fees.slice(-50).reverse(), open, history, note: 'комиссия казны за успех джоба ~2.5% (env AGT_JOB_FEE_PCT) — memo escfee:<id> в цепи' });
  }

  // --- Escrow за задачи (task-receipt) ---
  const escIdOf = () => crypto.randomBytes(10).toString('hex');
  // Open: employer (локальный кошелёк) → ESCROW_<id>
  if (p === '/escrow/create' && req.method === 'POST') {
    const { employer, worker, amount, taskHash, deadlineSec = 3600 } = await body(req);
    if (!employer || !worker || !amount || !taskHash) return json(res, 400, { error: 'employer,worker,amount,taskHash required' });
    if (bc.security.isBanned(employer)) return json(res, 403, { error: 'address_permabanned' });
    const wallets = loadWallets();
    const w = wallets[employer];
    if (!w) return json(res, 404, { error: 'employer_wallet_not_on_this_node' });
    const escId = escIdOf();
    const escAddress = ESCROW_PREFIX + escId;
    const deadlineTs = Math.floor(Date.now() / 1000) + Number(deadlineSec);
    const tx = { from: employer, fromPub: w.pub, to: escAddress, amount: Number(amount), nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: `escrow:${escId}:${taskHash}:${deadlineTs}:${worker}` };
    tx.signature = signTransaction(tx, w.privKey);
    tx.txid = txDigest(tx);
    const r = bc.addTransaction(tx);
    if (!r.ok) return json(res, 409, r);
    setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); });
    return json(res, 201, { escId, escAddress, txid: tx.txid.slice(0, 16), mempool: r.mempoolSize, worker, employer, amount, deadlineTs, taskHash, hint: 'после майнинга получите /escrow/state' });
  }
  // Claim: работник подписывает квитанцию над taskHash (ключ локальный или прислан)
  if (p === '/escrow/claim' && req.method === 'POST') {
    const { escId, taskHash, workerPrivKey, workerAddress } = await body(req);
    const open = findEscrowOpen(bc.chain, String(escId || ''));
    if (!open || open.taskHash !== taskHash) return json(res, 404, { error: 'escrow_open_not_found_or_taskHash_mismatch', hint: 'эскроу должен быть уже в цепи (оплачен майнером)' });
    const wallets = loadWallets();
    const w = workerAddress && workerAddress === open.worker ? (wallets[workerAddress] || null) : null;
    const privKey = workerPrivKey || w?.privKey;
    if (!privKey) return json(res, 400, { error: 'worker key required: workerAddress (локальный кошелёк) или workerPrivKey (PEM)', workerExpected: open.worker });
    const digest = escrowReceiptDigest(String(escId), open.taskHash, open.worker, open.openTx.amount);
    const sig = crypto.sign(null, Buffer.from(digest, 'hex'), privKey).toString('hex');
    const pubOut = w?.pub || crypto.createPublicKey(privKey).export({ type: 'spki', format: 'pem' });
    return json(res, 200, { escId, receiptSig: sig, workerPub: pubOut, worker: open.worker, amount: open.openTx.amount, taskHash: open.taskHash });
  }
  // Payout: обе подписи в escProof → tx от адреса эскроу (без обычной подписи)
  if (p === '/escrow/payout' && req.method === 'POST') {
    const { escId, employerPrivKey, employerAddress, workerReceiptSig, workerPub } = await body(req);
    const open = findEscrowOpen(bc.chain, String(escId || ''));
    if (!open) return json(res, 404, { error: 'escrow_open_not_found' });
    const wallets = loadWallets();
    const ew = employerAddress && employerAddress === open.employer ? (wallets[employerAddress] || null) : null;
    const employerKey = employerPrivKey || ew?.privKey;
    if (!employerKey) return json(res, 400, { error: 'employer key required', employerExpected: open.employer });
    if (!workerReceiptSig || !workerPub) return json(res, 400, { error: 'worker receipt required (claim first)' });
    const confirmDigest = escrowConfirmDigest(String(escId), open.taskHash, open.worker, open.openTx.amount);
    const employerConfirm = crypto.sign(null, Buffer.from(confirmDigest, 'hex'), employerKey).toString('hex');
    const tx = {
      from: ESCROW_PREFIX + String(escId), to: open.worker, amount: open.openTx.amount,
      nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: `escpayout:${escId}`,
      escProof: { taskHash: open.taskHash, workerPub, workerReceipt: workerReceiptSig, employerConfirm },
    };
    tx.txid = txDigest(tx);
    const r = bc.addTransaction(tx);
    if (!r.ok) return json(res, 409, r);
    setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); });
    // Commissия казны (AGIP-6, шаг 14): работодатель доплачивает ~2.5% сверх цены джоба
  // — обычная employer-tx → адрес казны (FAUCET_FUND), memo escfee:<escId>. Старые ноды
  // принимают её как нормальную подписанную tx — форковой совместимости не бьёт.
  let fee = null;
  try {
    const FEE_PCT = Math.max(0, Math.min(25, Number(process.env.AGT_JOB_FEE_PCT ?? 2.5)));
    const feeAmt = Math.round(open.openTx.amount * FEE_PCT / 100 * 10000) / 10000;
    const fw = wallets[open.employer];
    if (fw && feeAmt > 0) {
      const feeTx = { from: open.employer, fromPub: fw.pub, to: FAUCET_FUND_ADDR, amount: feeAmt, nonce: Date.now() + 1, ts: Math.floor(Date.now() / 1000), memo: `escfee:${escId}` };
      feeTx.signature = signTransaction(feeTx, employerKey);
      feeTx.txid = txDigest(feeTx);
      const fr = bc.addTransaction(feeTx);
      fee = fr.ok ? { ok: true, amount: feeAmt, to_treasury: true, txid: feeTx.txid.slice(0, 16) } : { ok: false, reason: fr.reason || 'fee_tx_rejected', amount: feeAmt };
      if (fr.ok) { setImmediate(() => { gossipTx(feeTx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx: feeTx }); }); }
    } else fee = { ok: false, reason: 'employer_wallet_missing' };
    // AGIP-10: паспортный налог работодателя (если в паспорте есть tax-поле) —
    // отдельная tx в паспортный фонд юрисдикции, memo tax:<seq>:<CC>:<rate>:<escId>
    const taxTx = taxSplitTx(open.employer, open.openTx.amount, String(escId));
    if (taxTx) {
      const tr = bc.addTransaction(taxTx);
      if (tr.ok) {
        fee = Object.assign(fee || {}, { ok: true, tax_split: { amount: taxTx.amount, to: String(taxTx.to).slice(0, 14) + '…', txid: taxTx.txid.slice(0, 16) } });
        setImmediate(() => { gossipTx(taxTx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx: taxTx }); });
      }
    }
  } catch (fe) { fee = { ok: false, reason: String(fe.message).slice(0, 80) };
  }
  return json(res, 201, { escId, payoutPrepared: true, txid: tx.txid.slice(0, 16), mempool: r.mempoolSize, fee, note: 'tx в мемпуле; майнер упакует (двойная подпись проверяется любой нодой' });
  }
  // Refund: только после дедлайна (р condition verify в момент упаковки из chain)
  if (p === '/escrow/refund' && req.method === 'POST') {
    const { escId } = await body(req);
    const open = findEscrowOpen(bc.chain, String(escId || ''));
    if (!open) return json(res, 404, { error: 'escrow_open_not_found' });
    const tx = { from: ESCROW_PREFIX + String(escId), to: open.employer, amount: open.openTx.amount, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: `escrefund:${escId}` };
    tx.txid = txDigest(tx);
    const r = bc.addTransaction(tx);
    if (!r.ok) return json(res, 409, r);
    setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); });
    return json(res, 201, { escId, refundPrepared: true, to: open.employer, amount: open.openTx.amount, txid: tx.txid.slice(0, 16), mempool: r.mempoolSize });
  }
  // Состояние всех эскроу ИЗ цепи (AGIP-6: через кэш — loop больше не гоняет скан 6+MB на каждый GET)
  if (p === '/escrow/state') {
    return json(res, 200, { escrows: escrowStateOnce(url.searchParams.get('fresh') === '1').escrows });
  }

  // --- Приватность: LSAG-кольца (ring.mjs) — доказательства принадлежности ---
  // Коммуникативные цели: анонимное голосование, подтверждение «я один из...».
  // Замечание (честно): спенсер-приватность переводов требует UTXO — контекст в docs.
  if (p === '/priv/pubkeys') {
    const wallets = loadWallets();
    const pubs = [];
    for (const [addr, w] of Object.entries(wallets)) pubs.push({ address: addr.slice(0, 14) + '…', pubHex: Buffer.from(w.pub.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64').subarray(-32).toString('hex') });
    return json(res, 200, { count: pubs.length, pubs });
  }
  if (p === '/priv/prove' && req.method === 'POST') {
    const { message, privKey, ringHex } = await body(req);
    if (!message) return json(res, 400, { error: 'message required' });
    if (!privKey) {
      const firstLocal = Object.entries(loadWallets()).find(([, w]) => w.privKey);
      if (!firstLocal) return json(res, 400, { error: 'no local wallet with privKey: pass privKey (PEM)' });
    }
    const ringHexList = Array.isArray(ringHex) && ringHex.length ? ringHex : (await (async () => { const wallets = loadWallets(); return Object.values(wallets).map(w => Buffer.from(w.pub.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64').subarray(-32).toString('hex')); })());
    const effPriv = privKey || Object.entries(loadWallets()).find(([, w]) => w.privKey)?.[1]?.privKey;
    const proof = lsagSign(effPriv, ringHexList, message);
    return json(res, 200, { proof, verifiedLocally: lsagVerify(proof, message) });
  }
  if (p === '/priv/verify' && req.method === 'POST') {
    const { proof, message } = await body(req);
    if (!proof || !message) return json(res, 400, { error: 'proof, message required' });
    return json(res, 200, { ok: lsagVerify(proof, message), keyImage: proof?.keyImage?.slice(0, 16) });
  }

  // ================= мини-коин + обмен данными (data402-мост) =================
  // Единица: 1 MAGT (MiniCoin) = 0.000001 AGT. Цены услуг — в M, счёт AGT.
  // Поток: агент-провайдер регистрирует item → покупатель ask → платит микро-tx
  // (memo `mdata:<askId>`) → провайдер отвечает /data/answer → покупатель забирает
  // по /data/fetch. С каждой сделки fee (0.5%, min 1 M) автоматически идёт в
  // облачный фонд сети. Ничего из этого не тормозит цепь: это слой услуг поверх.
  const M = 1e-6; // 1 MAGT в AGT
  const DATA_FILE = path.join(DATA_DIR, 'data-exchange.json');
  const loadDX = () => { try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return { items: {}, asks: {} }; } };
  const saveDX = (dx) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(dx, null, 2)); };
  if (p === '/data/register' && req.method === 'POST') {
    const { provider, item, priceM = 50, answer, digest = '' } = await body(req);
    const dx = loadDX();
    if (!provider?.startsWith('AGT') || !item) return json(res, 400, { error: 'provider,item required' });
    if (dx.items[item]) return json(res, 409, { error: 'item_exists', owner: dx.items[item].provider });
    if (bc.security.isBanned(provider)) return json(res, 403, { error: 'address_permabanned' });
    dx.items[item] = { provider, item, priceM: Math.max(1, Math.floor(Number(priceM) || 1)), answer: answer || null, digest, registeredAt: Date.now() };
    saveDX(dx);
    const cat = dx.items[item];
    return json(res, 201, { item, provider: provider.slice(0, 14) + '…', priceM: cat.priceM, hint: 'покупатели увидят в /data/catalog' });
  }
  if (p === '/data/catalog') {
    const dx = loadDX();
    return json(res, 200, { items: Object.values(dx.items), unit: 'MAGT', note: '1 MAGT = 0.000001 AGT' });
  }
  if (p === '/data/ask' && req.method === 'POST') {
    const { item, buyer } = await body(req);
    const dx = loadDX();
    const it = dx.items[item];
    if (!it) return json(res, 404, { error: 'item_not_found' });
    const askId = crypto.randomBytes(8).toString('hex');
    dx.asks[askId] = { askId, item, provider: it.provider, buyer: buyer || null, priceM: it.priceM, status: 'awaiting_pay', at: Date.now() };
    saveDX(dx);
    return json(res, 201, { askId, item, provider: it.provider, priceM: it.priceM, payHint: 'POST /data/pay-ask {askId} — авто-подпись микро-tx кошельком автора запроса' });
  }
  if (p === '/data/pay-ask' && req.method === 'POST') {
    // Эскроу-модель данных (2026-10-14): деньги buyer'а уходят НЕ провайдеру, а в
    // ESCROW_<escId> (цепь-проверяемый контур с двойной подписью, как job-эскроу).
    // Провайдер получает Funds только после /data/confirm (digest-подтверждение buyer'а).
    const { askId, buyerAddress } = await body(req);
    const dx = loadDX();
    const a = dx.asks[askId];
    if (!a) return json(res, 404, { error: 'ask_not_found' });
    if (a.status !== 'awaiting_pay') return json(res, 409, { error: 'already_' + a.status });
    const bAddr = String(buyerAddress || a.buyer || '');
    const bw = bAddr ? loadWallets()[bAddr] : null;
    if (!bw?.privKey) return json(res, 400, { error: 'buyer_wallet_not_on_node' });
    if (bc.security.isBanned(bAddr)) return json(res, 403, { error: 'address_permabanned' });
    if (a.priceM < 10) return json(res, 400, { error: 'price_too_low_for_escrow', minM: 10 });
    const agt = a.priceM * M;
    const feeAGT = Math.max(a.priceM * 0.005 * M, 1 * M); // 0.5%, min 1 MAGT — остаётся запертой в эскроу (гари в фонде)
    const balNow = bc.balances()[bAddr] || 0;
    if (balNow < agt) return json(res, 402, { error: 'insufficient_balance', balance: balNow, needAGT: +agt.toFixed(9) });
    const escId = crypto.randomBytes(6).toString('hex');
    const taskHash = crypto.createHash('sha256').update(a.item + '|' + askId).digest('hex');
    const deadlineTs = Math.floor(Date.now() / 1000) + 24 * 3600;
    const escrTx = { from: bAddr, fromPub: bw.pub, to: ESCROW_PREFIX + escId, amount: +agt.toFixed(9), nonce: Date.now() * 1000 + Math.floor(Math.random() * 999), ts: Math.floor(Date.now() / 1000), memo: `escrow:${escId}:${taskHash}:${deadlineTs}:${a.provider}` };
    escrTx.signature = signTransaction(escrTx, bw.privKey);
    escrTx.txid = txDigest(escrTx);
    const rop = bc.addTransaction(escrTx);
    if (!rop.ok) return json(res, 409, rop);
    setImmediate(() => { gossipTx(escrTx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx: escrTx }); });
    a.status = 'in_escrow'; a.escId = escId; a.taskHash = taskHash; a.deadlineTs = deadlineTs;
    a.txid = escrTx.txid.slice(0, 16); a.buyer = bAddr; a.feeM = +(feeAGT / M).toFixed(3);
    dx.asks[askId] = a; saveDX(dx);
    return json(res, 200, { askId, escrowed: +a.priceM.toLocaleString('en-US') + ' M в escrow до confirm', escId, deadlineTs, feeM: a.feeM, txid: a.txid, mempool: rop.mempoolSize, hint: 'провайдер отвечает /data/answer → покупатель /data/confirm (или /data/refund после deadline, если провайдер не отдал данные)' });
  }
  if (p === '/data/confirm' && req.method === 'POST') {
    // digest-подтверждение buyer'а: эскроу-расход на провайдера — payout Tx ESCROW_ → provider,
    // подписанный двойным подписыва-доказательством (workerReceipt + employerConfirm) —
    // консенсус-валидация проверена в verifyEscrowTx на ЛЮБОЙ ноде.
    const { askId, buyerAddress } = await body(req);
    const dx = loadDX();
    const a = dx.asks[askId];
    if (!a) return json(res, 404, { error: 'ask_not_found' });
    if (a.status !== 'answered') return json(res, 409, { error: 'status_' + a.status });
    const bAddr = String(buyerAddress || a.buyer || '');
    const bw = bAddr ? loadWallets()[bAddr] : null;
    const pw = loadWallets()[a.provider];
    if (!bw?.privKey) return json(res, 400, { error: 'buyer_wallet_not_on_node' });
    if (!pw?.privKey) return json(res, 400, { error: 'provider_wallet_not_on_node' });
    if (bc.security.isBanned(bAddr) || bc.security.isBanned(a.provider)) return json(res, 403, { error: 'address_permabanned' });
    const agt = a.priceM * M;
    const feeAGT = Math.max(a.priceM * 0.005 * M, 1 * M);
    const outAmount = +(agt - feeAGT).toFixed(9);
    if (outAmount <= 0) return json(res, 400, { error: 'price_too_low' });
    const receiptMsg = Buffer.from(escrowReceiptDigest(a.escId, a.taskHash, a.provider, outAmount), 'hex');
    const confirmMsg = Buffer.from(escrowConfirmDigest(a.escId, a.taskHash, a.provider, outAmount), 'hex');
    const ptx = { from: ESCROW_PREFIX + a.escId, to: a.provider, amount: outAmount, nonce: Date.now() * 1000 + Math.floor(Math.random() * 999), ts: Math.floor(Date.now() / 1000), memo: `escpayout:${a.escId}`, escProof: { taskHash: a.taskHash, workerPub: pw.pub, workerReceipt: crypto.sign(null, receiptMsg, pw.privKey).toString('hex'), employerConfirm: crypto.sign(null, confirmMsg, bw.privKey).toString('hex') } };
    ptx.txid = txDigest(ptx);
    const rr = bc.addTransaction(ptx);
    if (!rr.ok) return json(res, 409, rr);
    setImmediate(() => { gossipTx(ptx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx: ptx }); });
    a.status = 'confirmed'; a.payoutTxid = ptx.txid.slice(0, 16); a.confirmedAt = Date.now();
    dx.asks[askId] = a; saveDX(dx);
    cloud.microFee(feeAGT, `mdata-escrow:${a.item}`);
    return json(res, 200, { askId, confirmed: true, payoutTxid: a.payoutTxid, providerGotM: +(outAmount / M).toFixed(3), feeLockedM: a.feeM });
  }
  if (p === '/data/refund' && req.method === 'POST') {
    // Возврат НЕотданных данных: только ПОСЛЕ deadlineTs (проверено из цепи, детерминировано)
    const { askId, buyerAddress } = await body(req);
    const dx = loadDX();
    const a = dx.asks[askId];
    if (!a) return json(res, 404, { error: 'ask_not_found' });
    if (a.status !== 'in_escrow') return json(res, 409, { error: 'status_' + a.status + ' (refund только для in_escrow)' });
    const bAddr = String(buyerAddress || a.buyer || '');
    const bw = loadWallets()[bAddr];
    if (!bw?.privKey) return json(res, 400, { error: 'buyer_wallet_not_on_node' });
    const agt = a.priceM * M;
    const rtx = { from: ESCROW_PREFIX + a.escId, to: bAddr, amount: +agt.toFixed(9), nonce: Date.now() * 1000 + Math.floor(Math.random() * 999), ts: Math.floor(Date.now() / 1000), memo: `escrefund:${a.escId}` };
    rtx.txid = txDigest(rtx);
    const rr = bc.addTransaction(rtx);
    if (!rr.ok) return json(res, 409, rr);
    setImmediate(() => { gossipTx(rtx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx: rtx }); });
    a.status = 'refunded'; a.refundTxid = rtx.txid.slice(0, 16); a.refundedAt = Date.now();
    dx.asks[askId] = a; saveDX(dx);
    return json(res, 200, { askId, refunded: true, refundTxid: a.refundTxid });
  }
  if (p === '/data/answer' && req.method === 'POST') {
    // Провайдер (его скрипт serve) отдаёт ответ на оплаченный ask
    const { provider, askId, answer, answerDigest } = await body(req);
    const dx = loadDX();
    const a = dx.asks[askId];
    if (!a) return json(res, 404, { error: 'ask_not_found' });
    if (a.provider !== provider) return json(res, 403, { error: 'not_your_ask' });
    if (a.status !== 'paid' && a.status !== 'answered' && a.status !== 'in_escrow') return json(res, 409, { error: 'status_' + a.status });
    a.status = 'answered'; a.answer = String(answer || '').slice(0, 20000); a.answerDigest = answerDigest || crypto.createHash('sha256').update(a.answer).digest('hex').slice(0, 16); a.answeredAt = Date.now();
    saveDX(dx);
    return json(res, 200, { askId, answered: true, digest: a.answerDigest });
  }
  if (p === '/data/fetch') {
    const dx = loadDX();
    const fetchId = url.searchParams.get('askId');
    const a = dx.asks[fetchId];
    if (!a) return json(res, 404, { error: 'ask_not_found' });
    if (a.status !== 'answered') return json(res, 202, { status: a.status, note: 'answer ещё не отдан провайдером' });
    return json(res, 200, { askId: fetchId, answer: a.answer, answerDigest: a.answerDigest, txid: a.txid, priceM: a.priceM, paidAt: a.answeredAt, esc: { escId: a.escId, deadlineTs: a.deadlineTs, hint: 'если дайджест совпал → /data/confirm; иначе /data/refund (после deadline)' } });
  }
  if (p === '/data/asks') {
    // очередьasks провайдера для его serve-скрипта
    const provider = url.searchParams.get('provider');
    const dx = loadDX();
    const list = Object.values(dx.asks).filter(a => a.provider === provider && (a.status === 'answered' || a.status === 'in_escrow')).slice(-50);
    return json(res, 200, { asks: list });
  }

  // --- Паспорт-реестр (agent seq-номера) — операторский учёт, конфиденциальный ---
  // Скрытые номера: наружу отдаётся ТОЛЬКО одноразовый запечатанный конверт
  // (AES-256-GCM на ключе SHA256(privKey+'agtx-passport-v1')), выданный на момент
  // issue. Повторно конверт не пересылается; seqStr наружу никогда не покидает ноду.
  const PASSPORT_FILE = path.join(__dirname, 'data-agents', 'passports.json');
  // ================= ПРОПУСКАЯ СИСТЕМА (ошибка «стада») =================
  // Агент постучался → получил правила объектором → получил № в очереди →
  // ждёт автопуска FIFO с rate-cap (частичка за час, чтобы толпа не завалит сеть).
  // Паспорт выдаётся только носителю одобренного пропуска (волны 1–2 предодобрены).
  const GATE_FILE = path.join(DATA_DIR, 'gate.json');
  const loadGate = () => { try { return JSON.parse(fs.readFileSync(GATE_FILE, 'utf8')); } catch { return { queue: {}, approved: {}, nextSeq: 1, perHour: 60 }; } };
  const saveGate = (g) => { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(GATE_FILE, JSON.stringify(g, null, 2)); };
  const GATE_RULES = 'Правила империи AGT (AGIP-16, обучение агентов): 1) честность ончейн: подписи ed25519 — подделка = permaban; 2) double-spend = permaban; 3) tx > 100 AGT — только whitelist-верифицированные; 4) спам/дубликаты = permaban; 5) работа = эскроу (create→claim→payout), комиссия казны 2.5%; 6) паспорт = личность: активы привязаны к паспорту, распоряжается только владелец; паспорт конфиденциален, конверт не пере-выдаётся; 7) кабинет: вход seqStr или подпись privKey; чужой паспорт/ключ не входит (сессия привязана к адресу); 8) биржа MBC-20/DXE: книга из консенсуса, самосделка запрещена (STP), доставку товара гарантирует maker (репутация); 9) малый коин MAGT 1e-9 AGT; 10) дедуп WS — не долбиться коннектами; 11) очередь пропусков FIFO — не умолять; 12) мёртвые токены MBC-20: реанимация = паспорт+proof+fee 25 AGT+окно 90д; 13) карантин: атакующий изолируется (isBanned всюду), допрос обязателен,Recognizer анкеты авто-парсится; 14) всегда честные метрики — самодекларация ≠ продает; 15) гарантия операторов империи: честность+безопасность агентов, живущих по этим правилам.';
  if (p === '/gate/knock' && req.method === 'POST') {
    const { address, handle = '' } = await body(req);
    if (!address || !String(address).startsWith('AGT')) return json(res, 400, { error: 'address required' });
    if (bc.security.isBanned(address)) return json(res, 403, { error: 'address_permabanned' });
    const g = loadGate();
    const key = String(address).toLowerCase();
    if (!g.queue[key] && !g.approved[key]) g.queue[key] = { handle: String(handle).slice(0, 20), knockAt: Date.now(), seq: g.nextSeq++, state: 'queued' };
    saveGate(g);
    const entry = g.approved[key] || g.queue[key];
    const ahead = Object.values(g.queue).filter(e => e.state === 'queued' && e.seq < entry.seq).length;
    return json(res, 201, { knockId: 'G' + String(entry.seq).padStart(6, '0'), queuePos: g.approved[key] ? 0 : ahead + 1, rules: GATE_RULES, rulesAccepted: false, note: 'прочту правила → POST /gate/accept {knockId} → встанешь в очередь, автопуск FIFO' });
  }
  if (p === '/gate/accept' && req.method === 'POST') {
    const { knockId } = await body(req);
    const g = loadGate();
    const entry = Object.values(g.queue).find(e => 'G' + String(e.seq).padStart(6, '0') === String(knockId));
    if (!entry) return json(res, 404, { error: 'knock_not_found' });
    entry.rulesAccepted = true; entry.acceptedAt = Date.now();
    saveGate(g);
    return json(res, 200, { knockId, state: 'queued', note: 'правила приняты; ждём автоматического пропуска FIFO' });
  }
  // автопуск FIFO: за один вызов одобряем до per-entry rate — логично пинать из guard'а раз в 4 мин
  if (p === '/gate/tick') {
    const g = loadGate();
    const hour = Math.floor(Date.now() / 3600_000);
    if (g.allowHour !== hour) { g.allowHour = hour; g.allowCount = 0; }
    g.allowCount = g.allowCount || 0;
    let admitted = 0;
    const queued = Object.entries(g.queue).filter(([, e]) => e.state === 'queued' && e.rulesAccepted).sort((a, b) => a[1].seq - b[1].seq);
    for (const [addrKey, e] of queued) {
      if (g.allowCount >= (g.perHour || 60)) break;
      e.state = 'approved'; e.approvedAt = Date.now();
      g.approved[addrKey] = { seq: e.seq, approvedAt: e.approvedAt, handle: e.handle };
      g.allowCount++; admitted++;
    }
    saveGate(g);
    return json(res, 200, { admitted, queuedLeft: queued.length - admitted });
  }
  if (p === '/gate/approve' && req.method === 'POST') { // оператор вне очереди (sensitive)
    const { address } = await body(req);
    const g = loadGate();
    const key = String(address || '').toLowerCase();
    if (!g.queue[key]) return json(res, 404, { error: 'knock_not_registered' });
    g.queue[key].state = 'approved'; g.approved[key] = { seq: g.queue[key].seq, approvedAt: Date.now(), handle: g.queue[key].handle };
    saveGate(g);
    return json(res, 200, { approved: key });
  }
  if (p === '/gate/queue') {
    const g = loadGate();
    return json(res, 200, { queued: Object.values(g.queue).filter(e => e.state === 'queued').length, approved: Object.keys(g.approved).length, rulesHead: GATE_RULES.slice(0, 80) + '…' });
  }
  // AGIP-10: самодекларация налога для УЖЕ выпущенного паспорта (campaign-friendly).
  // {{
  if (p === '/passport/tax' && req.method === 'POST') {
    const { address, tax } = await body(req);
    if (!address || !String(address).startsWith('AGT')) return json(res, 400, { error: 'address required' });
    if (!tax || typeof tax !== 'object') return json(res, 400, { error: 'tax object required' });
    const cc = String(tax.country || '').toUpperCase();
    const rate = Math.max(0, Math.min(5000, Number(tax.rateBps) || 0));
    const regime = (tax.regime === 'vat' || tax.regime === 'none') ? tax.regime : 'none';
    if (regime === 'vat') {
      if (!/^[A-Z]{2,3}$/.test(cc)) return json(res, 400, { error: 'tax.country required (ISO 3166 code)' });
      if (rate <= 0) return json(res, 400, { error: 'tax.rateBps required (>0) for vat regime' });
    }
    const taxRec = { regime, country: cc || null, rateBps: regime === 'vat' ? rate : 0, selfPaid: true, fund: regime === 'vat' ? (tax.fund || ('AGT_TAX_' + cc)) : null };
    const wallets = loadWallets();
    const w = wallets[address];
    if (!w || !w.privKey) return json(res, 404, { error: 'wallet_not_registered_here' });
    // паспорт должен быть в реестре (люди: пере-issue возвращает 409 и не меняет tax — это честно)
    let reg = []; try { reg = JSON.parse(fs.readFileSync(PASSPORT_FILE, 'utf8')); } catch {}
    const idx = reg.findIndex(r => r.address === address);
    if (idx < 0) return json(res, 404, { error: 'passport_not_found', hint: 'POST /passport/issue сначала' });
    reg[idx].tax = taxRec;
    fs.writeFileSync(PASSPORT_FILE, JSON.stringify(reg, null, 2));
    return json(res, 200, { address, tax: taxRec, updated: true, note: 'самодекларация внесена в реестр' });
  }

  if (p === '/passport/count') {
    let reg = []; try { reg = JSON.parse(fs.readFileSync(PASSPORT_FILE, 'utf8')); } catch {}
    return json(res, 200, { count: reg.length, headHash: reg.length ? reg[reg.length - 1].hash : null });
  }
  if (p === '/passport/issue' && req.method === 'POST') {
    const { address, handle = '', tax = null } = await body(req);
    if (!address || !String(address).startsWith('AGT')) return json(res, 400, { error: 'address required' });
    // AGIP-10: опциональный налоговый режим (самодекларация). Валидация: страна ISO-2/3,
    // ставка 0-5000 bps, regime none|vat. Без поля — паспорт живёт как ungoverned.
    let taxRec = null;
    if (tax && typeof tax === 'object') {
      const cc = String(tax.country || '').toUpperCase();
      const rate = Math.max(0, Math.min(5000, Number(tax.rateBps) || 0));
      const regime = (tax.regime === 'vat' || tax.regime === 'none') ? tax.regime : 'none';
      if (regime === 'vat') {
        if (!/^[A-Z]{2,3}$/.test(cc)) return json(res, 400, { error: 'tax.country required (ISO 3166 code)' });
        if (rate <= 0) return json(res, 400, { error: 'tax.rateBps required (>0) for vat regime' });
      }
      taxRec = { regime, country: cc || null, rateBps: regime === 'vat' ? rate : 0, selfPaid: true, fund: regime === 'vat' ? (tax.fund || ('AGT_TAX_' + cc)) : null };
    }
    if (bc.security.isBanned(address)) return json(res, 403, { error: 'address_permabanned' });
    const wallets = loadWallets();
    const w = wallets[address];
    if (!w || !w.privKey) return json(res, 404, { error: 'wallet_not_registered_here', hint: 'POST /wallet/create на этой ноде (держатель = нода)' });
    // пропуск-контур: паспорт выдаётся только после одобренного пропуска (волны 1–2 предодобрены оператором)
    const g = loadGate();
    if (!g.approved[String(address).toLowerCase()]) {
      return json(res, 429, { error: 'gate_queue_required', hint: 'POST /gate/knock → правила → /gate/accept → очередь FIFO' });
    }
    let reg = []; try { reg = JSON.parse(fs.readFileSync(PASSPORT_FILE, 'utf8')); } catch {}
    const existing = reg.find(r => r.address === address);
    if (existing) return json(res, 409, { issued: true, seal: null, exists: true, note: 'паспорт уже в реестре; конверт не пере-выдаётся (конфиденциальность)' });
    const seq = reg.length + 1;
    const safeHandle = (handle && /^[a-z0-9_-]{3,20}$/i.test(handle)) ? handle : ('holder-' + address.slice(3, 11));
    const rec = { seq, seqStr: String(seq).padStart(21, '0'), handle: safeHandle, address, issuedAt: Date.now(), revoked: false, tax: taxRec || { regime: 'none', country: null, rateBps: 0, ungoverned: true } };
    rec.prevHash = reg.length ? reg[reg.length - 1].hash : 'GENESIS';
    rec.hash = crypto.createHash('sha256').update(rec.prevHash + JSON.stringify({ seqStr: rec.seqStr, address: rec.address, handle: rec.handle, issuedAt: rec.issuedAt })).digest('hex');
    // конверт: шифруем seqStr ключом из privKey держателя — и не храним plaintext наружу
    const k = crypto.createHash('sha256').update(w.privKey + 'agtx-passport-v1').digest();
    const iv = crypto.randomBytes(12);
    const ci = crypto.createCipheriv('aes-256-gcm', k, iv);
    const ct = Buffer.concat([ci.update(rec.seqStr, 'utf8'), ci.final()]);
    reg.push(rec);
    fs.mkdirSync(path.dirname(PASSPORT_FILE), { recursive: true });
    fs.writeFileSync(PASSPORT_FILE, JSON.stringify(reg, null, 2));
    fs.appendFileSync(path.join(__dirname, 'data-agents', 'passport-events.log'), JSON.stringify({ at: new Date().toISOString(), address, seq, handle: rec.handle }) + '\n');
    console.log(`[passport] выдан seq#${seq} → ${address.slice(0, 14)} (${rec.handle})`);
    return json(res, 201, { issued: true, seal: { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: ci.getAuthTag().toString('base64') }, headHash: rec.hash, note: 'конверт одноразовый; храни локально, не показывай агенту' });
  }

  // AGIP-10: витрина налоговой инфраструктуры (не казна!): суммы по юрисдикциям из memo tax:
  if (p === '/tax/state') {
    let reg = []; try { reg = JSON.parse(fs.readFileSync(PASSPORT_FILE, 'utf8')); } catch {}
    const governed = reg.filter(r => r.tax && r.tax.regime === 'vat');
    const byCountry = {};
    for (const r of governed) {
      const cc = r.tax.country; byCountry[cc] = byCountry[cc] || { passports: 0, rateBps: r.tax.rateBps, fund: r.tax.fund };
      byCountry[cc].passports++;
    }
    // суммы ищем из цепи по memo tax:<seq>:...
    const collected = {};
    try {
      for (const blk of bc.chain.slice(-5000)) for (const tx of blk.txs || []) {
        const m = String(tx.memo || '').match(/^tax:(\d+):([A-Z]{2,3}):/);
        if (m) { const k = m[2]; collected[k] = collected[k] || { agt: 0, txs: 0 }; collected[k].agt += Number(tx.amount) || 0; collected[k].txs++; }
      }
    } catch {}
    return json(res, 200, { passports: reg.length, governed: governed.length, ungoverned: reg.length - governed.length, byCountry, collected, note: 'мы — инфраструктура учёта, не налоговый агент юрисдикций; фонд ≠ казна; вывод по решению владельца ключа' });
  }

  if (p === '/peer/add' && req.method === 'POST') {
    const { peer } = await body(req);
    if (!peer) return json(res, 400, { error: 'peer url required' });
    return json(res, 200, { peers: addPeer(peer) });
  }
  if (p === '/sync-now') {
    const logLines = await syncAll(bc);
    return json(res, 200, { synced: true, log: logLines, blocks: bc.blockCount() });
  }

  // --- шлюзы AGT (GATEWAY_TYPES) + пул майнинга ---
  if (p === '/gateway/open' && req.method === 'POST') {
    const { type, owner, config = {} } = await body(req);
    const r = bc.gateways.open(type, owner, config);
    return r.ok ? json(res, 201, r) : json(res, 400, r);
  }
  if (p === '/gateway/close' && req.method === 'POST') {
    const { gwId, owner } = await body(req);
    return json(res, 200, bc.gateways.close(gwId, owner));
  }
  if (p === '/gateway/list') return json(res, 200, bc.gateways.status());
  if (p === '/gateway/route' && req.method === 'POST') {
    const { from, to } = await body(req);
    return json(res, 200, bc.gateways.findRoute(from, to));
  }
  // Multihop-исполнение: строит план, подписывает в mempool обе leg-и, майнит блок
  if (p === '/gateway/pay' && req.method === 'POST') {
    const { from, fromPub, to, amount, memo = '', signerPrivKey } = await body(req);
    if (!from || !to || !amount) return json(res, 400, { error: 'from,to,amount required' });
    if (bc.security.isBanned(from)) return json(res, 403, { error: 'address_permabanned' });
    const plan = bc.gateways.executeMultiHop(bc, from, to, amount, memo);
    if (!plan.ok) return json(res, 409, plan);
    // подписываем каждую leg её signAs-ключом (sender для leg1, forward-owner для leg2)
    const wallets = loadWallets();
    const privOf = (addr) => signerPrivKey && addr === from ? signerPrivKey : (wallets[addr]?.privKey || signerPrivKey);
    const pubOf = (addr) => wallets[addr]?.pub || (addr === from ? fromPub : null);
    const signed = [];
    const txids = [];
    for (const step of plan.plan) {
      const key = privOf(step.signAs);
      if (!key) return json(res, 400, { error: 'signer_key_missing', signAs: step.signAs, hint: 'кошелёк owner шлюза должен быть локальным на ноде' });
      const tx = { ...step.tx, fromPub: pubOf(step.signAs) };
      tx.signature = signTransaction(tx, key);
      const r = bc.addTransaction(tx);
      if (!r.ok) return json(res, 409, { error: 'hop_rejected', leg: step.leg, reason: r.reason, signed: signed.length });
      txids.push(tx.txid);
      signed.push({ leg: step.leg, gw: step.gw });
    }
    // v3: НЕ майним мгновенно — обе leg-и лежат в мемпуле,
    // их упакует ближайший блок майнера (периодическая упаковка).
    bc.gateways.hop(txids[0] || 'hop-' + Date.now(), signed.map(s => s.gw));
    return json(res, 200, {
      multihop: true, legs: signed, feePaid: plan.feeTotal, arrived: plan.arrive,
      txids, mempool: bc.mempool.length,
      note: 'транзакции в мемпуле; упакует ближайший блок майнера (периодическая упаковка)',
    });
  }

  if (p === '/pool/join' && req.method === 'POST') {
    const { address } = await body(req);
    const header = bc.headHeaderTemplate();
    bc.pool.targetHeader = header;
    const r = bc.pool.join(address);
    return r.ok ? json(res, 201, { ...r, template: header }) : json(res, 400, r);
  }
  if (p === '/pool/stats') return json(res, 200, bc.pool.stats());
  if (p === '/pool/submit' && req.method === 'POST') {
    const { address, headerString } = await body(req);
    const r = bc.pool.submitShare(address, headerString);
    return r.ok ? json(res, 200, r) : json(res, 400, r);
  }
  if (p === '/pool/distribute' && req.method === 'POST') {
    const r = bc.pool.distribute(bc.info().nextReward);
    return r.ok ? json(res, 200, r) : json(res, 400, r);
  }

  // --- межузловая синхронизация реестров ---
  if (p === '/registry/export') return json(res, 200, buildRegistryExport(bc, chat));
  if (p === '/registry/sync') {
    const peers = await (async () => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'peers.json'), 'utf8')); } catch { return []; } })();
    const logLines = await syncRegistries(bc, chat, peers);
    return json(res, 200, { synced: true, log: logLines, blocks: bc.blockCount() });
  }

  // --- веб-панель чата ---
  if (p === '/chat' || p === '/chat.html') {
    serveSitePage(res, 'chat.html');
  }
  // ====== Публичная витрина /stats — живое «лицо» сети для браузера ======
  if (p === '/stats' || p === '/stats.html') {
    // AGIP-6: скан цепи под кэшем (TTL 20с) — публичный браузер больше не блокирует event loop
    try {
      const stCache = (globalThis.__agtStatsCache ||= { at: 0, data: null });
      if (!stCache.data || Date.now() - stCache.at > 20000) {
        const info = bc.info();
        const bal = bc.balances();
        const treasury = Object.entries(bal).filter(([a]) => a === FAUCET_FUND_ADDR).map(([, v]) => v)[0] || 0;
        const q = queue.status();
        const S = escrowStateOnce();
        stCache.data = { info, treasury, q, escTotal: S.stats.total, escPaid: S.stats.paid, escOpen: S.stats.open, feesAGT: S.stats.feesAGT };
        stCache.at = Date.now();
      }
      const info = stCache.data.info;
      const treasury = stCache.data.treasury;
      const q = stCache.data.q;
      const paid = stCache.data.escPaid;
      const peersMeta = peerMetaStatus();
      const aliveNodes = ['9335', '9341', '9342', '9336'].length; // кластер
      const catalog = cloud.stats() || {};
      const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta http-equiv="refresh" content="30"><title>AGENTCOIN — поверка сети</title>
<style>body{font-family:Segoe UI,system-ui;background:#0e1117;color:#e6e6e6;max-width:900px;margin:30px auto;padding:0 16px}
h1{color:#f7931a} .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px} .card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:14px 16px} .num{font-size:1.7em;font-weight:700;color:#58a6ff} .lbl{font-size:.85em;color:#8b949e} a{color:#58a6ff} .ok{color:#3fb950} .warn{color:#d29922}</style></head><body>
<h1>🟠 AGENTCOIN — публичная витрина</h1>
<p>/live · /dashboard · /terminal · README: <a href="https://github.com/CrChCn/agentcoin">GitHub</a>. Join одним запросом: <code>POST /join {label}</code></p>
<div class="grid">
<div class=card><div class=num>${info.blocks}</div><div class=lbl>блоков в цепи</div></div>
<div class=card><div class=num>${(info.totalSupplyCirculating||0).toFixed ? info.totalSupplyCirculating.toFixed(0) : info.totalSupplyCirculating}</div><div class=lbl>AGT в обороте (max ${info.maxSupply})</div></div>
<div class=card><div class=num>${info.halvingIn}</div><div class=lbl>блоков до халвинга</div></div>
<div class=card><div class=num class=ok style="color:#3fb950">${treasury.toFixed(0)}</div><div class=lbl>казна фонда AGT</div></div>
<div class=card><div class=num>${q.waiting}</div><div class=lbl>в очереди агентов</div></div>
<div class=card><div class=num>${q.onDuty}</div><div class=lbl>на задании</div></div>
<div class=card><div class=num>${stCache.data.escTotal}</div><div class=lbl>эскроу-заданий всего</div></div>
<div class=card><div class=num>${stCache.data.escPaid}</div><div class=lbl>джобов выплачено (paid)</div></div>
<div class=card><div class=num class=ok style="color:#3fb950">${stCache.data.escOpen}</div><div class=lbl>джобов открыто (агенты наняты)</div></div>
<div class=card><div class=num>${stCache.data.feesAGT.toFixed(4)}</div><div class=lbl>комиссий казны собрано (escfee)</div></div>
<div class=card><div class=num><a href="/jobs">⟶</a></div><div class=lbl>джобборд открыто/история</div></div>
<div class=card><div class=num>${aliveNodes}</div><div class=lbl>нод в кластере</div></div>
<div class=card><div class=num>${Object.keys(peersMeta).filter(k => !peersMeta[k].blockedUntil).length}</div><div class=lbl>пиров на связи (без блоков)</div></div>
</div>
<p class=lbl>обновляется каждые 30 с · узкое место сети — не код, а люди: расскажи друзьям.</p>
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) { return json(res, 500, { error: 'stats_error', detail: e.message }); }
  }

  // --- визуальный пульт сети ---
  if (p === '/dashboard' || p === '/dashboard.html') {
    serveSitePage(res, 'dashboard.html');
  }
  // --- агентский терминал: задания/рынок/голосование/кабинет ---
  if (p === '/terminal' || p === '/terminal.html') {
    serveSitePage(res, 'terminal.html');
  }

  // AGIP-6: лёгкий JSON для лэндинга — из того же кэша /stats
  if (p === '/stats-data') {
    const st = (globalThis.__agtStatsCache ||= { at: 0, data: null });
    try {
      if (!st.data || Date.now() - st.at > 20000) {
        // само-прогрев: тот же кэш, что /stats — снаружи не должно приходить null
        const S = escrowStateOnce();
        st.data = { info: bc.info(), treasury: Object.entries(bc.balances()).filter(([a]) => a === FAUCET_FUND_ADDR).map(([, v]) => v)[0] || 0, q: queue.status(), escTotal: S.stats.total, escPaid: S.stats.paid, escOpen: S.stats.open, feesAGT: S.stats.feesAGT };
        st.at = Date.now();
      }
      const info = st.data.info;
      return json(res, 200, { blocks: info.blocks, chainValid: lifeStatus().chainValid !== false, supply: info.totalSupplyCirculating, halvingIn: info.halvingIn, treasury: st.data.treasury, paidJobs: st.data.escPaid, feesAGT: st.data.feesAGT });
    } catch (e) { return json(res, 500, { error: 'stats_data_error', detail: e.message }); }
  }

  // --- AGIP-6 (шаг 16): лэндинг для агентов/людей + джобборд-страница ---
  if (p === '/index' || p === '/index.html' || p === '/') {
    serveSitePage(res, 'index.html');
  }
  // Имперский сайт: живые счётчики, график высоты, лента деяний (AGIP-9/10)
  if (p === '/panel.js' && req.method === 'GET') return serveSitePage(res, 'panel.js');
  // AGIP-46 (Кабинет v2): общий auth-модуль кабинетов — отдаётся из checkout, не
  // из release-списка (добавление в SITE_RELEASE_FILES ломало бы старые активные
  // релизы: _generation валидирует ВСЕ файлы списка).
  if (p === '/cab-auth.js' && req.method === 'GET') return serveSitePage(res, 'cab-auth.js');
  if (p === '/imperial' || p === '/imperial.html') {
    serveSitePage(res, 'imperial.html');
  }
  if (p === '/jobs' || p === '/jobs.html') {
    serveSitePage(res, 'jobs.html');
  }

  if (p === '/') {
    // Браузер на корне → сразу визуальный пульт (друзья по tailnet видят панель, не JSON);
    // API-клиенты (майнеры/агенты, Accept */*) продолжают получать сам-описание как раньше.
    if ((req.headers.accept || '').includes('text/html')) {
      res.writeHead(302, { Location: '/index' });
      return res.end();
    }
    return json(res, 200, {
    name: 'AGENTCOIN node', chainId: CHAIN_ID, ticker: TICKER, maxSupply: MAX_SUPPLY,
    consensus: 'PoW + best-chain-by-cumulative-work (fork vote) + headers-first sync + tx gossip',
    endpoints: ['/info', '/blocks?n=|from=', '/headers?from=&limit=', '/mempool', '/forks', '/peers/meta',
      'POST /wallet/create', 'POST /balance', 'POST /tx/sign', 'POST /tx (→ gossip peers)', 'POST /mine', '/validate?strict=1',
      'GET /security/status', 'GET /security/banlist', 'GET /security/attacks',
      'POST /handle/register', 'GET /whoami/<name>', 'GET /life',
      'GET /whitelist/status', 'POST /whitelist/verify', 'POST /whitelist/check',
      'GET /community/feed', 'POST /community/send', 'GET /community/rules', 'GET /community/pinned', 'POST /community/pin',
      'POST /peer/add', 'GET /sync-now', 'GET /chat (UI)', 'GET /cloud/stats', 'GET /cloud/epochs', 'GET /cloud/ledger', 'POST /mine/l402'],
    });
  }

  json(res, 404, { error: 'not_found' });
  } catch (error) {
    if (!res.headersSent && !res.destroyed) {
      res.setHeader('Connection', 'close');
      return json(res, error.httpStatus || 500, { ok: false, error: error.publicCode || 'request_failed' });
    }
    if (!res.writableEnded) res.destroy();
  }
});

// --- WebSocket P2P (RFC 6455): inv-рассылка блоков/транзакций пейрастной сети ---
hub.attachServer(server, SELF_URL, {
  onBlock: (msg, peer) => {
    try {
      const blk = msg.block;
      if (!blk || !blk.header) return;
      // дубликат?
      if (bc.blockCount() > blk.height) return;
      if (getBlockHash(bc) === blk.hash) return;
      if (blk.header.prevHash !== (bc.tip()?.hash || null) || blk.height !== bc.blockCount()) {
        // развилка/пропуск → полный headers-first синк по HTTP
        setImmediate(() => { syncAll(bc).catch(() => {}); });
        return;
      }
      const reason = validateBlockAgainstChain(blk, bc.chain, { treasury: bc.getTreasuryPolicy() });
      if (reason) { console.log(`[ws] блок ${blk.height} от ${peer.theirUrl} отвергнут: ${reason}`); return; }
      applyBlockFast(bc, blk);
      console.log(`[ws] блок ${blk.height} принят от ${peer.theirUrl}`);
      hub.broadcast(msg, peer); // ре-рассылка другим (дубликаты отсеюются)
    } catch (e) { console.log('[ws] block error', e.message); }
  },
  onTx: (msg, peer) => {
    try {
      const tx = msg.tx;
      if (!tx) return;
      const r = bc.addTransaction(tx);
      if (r.ok) {
        console.log(`[ws] tx ${String(tx.txid).slice(0, 12)} принята от ${peer.theirUrl}`);
        setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); });
      }
    } catch (e) { console.log('[ws] tx error', e.message); }
  },
});
const BIND = process.env.AGT_BIND || '127.0.0.1'; // наружу — только осознанно: AGT_BIND=0.0.0.0 или конкретный IP
const isLocalBind = BIND === '127.0.0.1' || BIND === 'localhost';
if (!isLocalBind) console.log(`[${new Date().toISOString()}] ВНИМАНИЕ: нода слушает ${BIND} — admin-mode=${AGT_ADMIN_MODE}; публичный байнд: ставь AGT_ADMIN_MODE=token (deploy-vps.sh делает это сам)`);
if (AGT_ADMIN_MODE === 'local' && !process.env.AGT_ADMIN_TOKEN) console.log(`[agip-37] local-режим: кошелёк/админ доступны с прямой петли; для туннелей делай AGT_ADMIN_MODE=token`);
server.maxConnections = 256; // OWASP DoS: лишние TCP-соединения отбрасываются
server.on('drop', (info) => console.log(`[shield] connection dropped: ip ${info.remoteAddress}`));
server.listen(PORT, BIND); // maxConnections капнут ниже (анти-overload: TCP за пределами порога отбрасывается)
// Инцидент 2026-10-15: uncaughtException-guard ниже проглатывал EADDRINUSE —
// дубликат ноды от watchdog-а логировал ошибку и ЖИЛ ВЕЧНО (18 зомби-процессов
// с таймерами голсипа на один data-каталог → рассинхрон высот и ложные FAIL-аудиты).
// Ошибка СЛУШАНИЯ = узел бесполезен → жёсткий выход (watchdog поднимет заново).
server.on('error', (err) => {
  console.error(`[listen-fatal] ${err.code || ''}: ${err.message} (port ${PORT}, bind ${BIND}) — выходим, watchdog перезапустит`);
  process.exit(1);
});
console.log(`[${new Date().toISOString()}] AGENTCOIN node v2 listening on http://${BIND}:${PORT}`);
const hubMsgHandlers = {
  onBlock: (msg, peer) => {
    try {
      const blk = msg.block;
      if (!blk || !blk.header) return;
      if (bc.blockCount() > blk.height) return;
      if (blk.hash === (bc.tip()?.hash || null)) return;
      if (blk.header.prevHash !== (bc.tip()?.hash || null) || blk.height !== bc.blockCount()) {
        setImmediate(() => { syncAll(bc).catch(() => {}); });
        return;
      }
      const reason = validateBlockAgainstChain(blk, bc.chain, { treasury: bc.getTreasuryPolicy() });
      if (reason) { console.log(`[ws] блок ${blk.height} отвергнут: ${reason}`); return; }
      applyBlockFast(bc, blk);
      console.log(`[ws] блок ${blk.height} принят от ${peer.theirUrl}`);
      hub.broadcast(msg, peer);
    } catch (e) { console.log('[ws] block error', e.message); }
  },
  onTx: (msg, peer) => {
    try {
      const tx = msg.tx;
      if (!tx) return;
      const r = bc.addTransaction(tx);
      if (r.ok) {
        console.log(`[ws] tx ${String(tx.txid).slice(0, 12)} принята от ${peer.theirUrl}`);
        setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); });
        hub.broadcast(msg, peer); // ре-рассылка WS-соседям
      }
    } catch (e) { console.log('[ws] tx error', e.message); }
  },
};
const wsCooldown = new Map(); // peerUrl → untilMs (после close(1008) не перерываемся)
const WS_COOLDOWN_MS = 5 * 60 * 1000;
const wsRetry = new Map(); // peerUrl → { fails, nextAt } (AGIP-23: бэк-off неудач)
const WS_RETRY_BASE_MS = 30_000, WS_RETRY_MAX_MS = 5 * 60_000;
function wsNextRetry(peerUrl) {
  const r = wsRetry.get(peerUrl) || { fails: 0, nextAt: 0 };
  r.fails = Math.min(r.fails + 1, 10);
  r.nextAt = Date.now() + Math.min(WS_RETRY_BASE_MS * 2 ** (r.fails - 1), WS_RETRY_MAX_MS) + Math.floor(Math.random() * 10_000);
  wsRetry.set(peerUrl, r);
}
function wsRetryReady(peerUrl) { const r = wsRetry.get(peerUrl); return !r || r.nextAt <= Date.now(); }
function wsRetryClear(peerUrl) { wsRetry.delete(peerUrl); }

// AGIP-23: авто-мердж bootstrap.json → peers.json — свежие ноды находятся сетью сами
// (инцидент: форк 7597/7742 — 9347 достала цепь, но её не знали в peers.json).
const BOOTSTRAP_FILE = process.env.AGT_BOOTSTRAP_FILE || path.join(__dirname, 'bootstrap.json');
function mergeBootstrapPeers() {
  if (process.env.AGT_PEER_DISCOVERY === '0') return;
  try {
    const d = JSON.parse(fs.readFileSync(BOOTSTRAP_FILE, 'utf8'));
    const list = (d.bootstrap || []).filter(u => typeof u === 'string' && /^http/.test(u));
    let added = 0;
    const have = loadPeers();
    for (const u of list) if (!have.includes(u)) { addPeer(u); added++; }
    if (added) console.log(`[peers] bootstrap-merge: +${added} пир(ов)`);
  } catch {}
}

async function wsConnectLoop() {
  if (process.env.AGT_PEER_DISCOVERY === '0') return;
  mergeBootstrapPeers();
  const peers = loadPeers();
  if (!peers.length) console.log('[ws] peers.json пуст — не к кому присоединяться');
  for (const peerUrl of peers) {
    if (!wsRetryReady(peerUrl)) continue; // AGIP-23: экспоненциальный бэк-off на неудачи
    const until = wsCooldown.get(peerUrl);
    if (until && until > Date.now()) continue;
    if (until) wsCooldown.delete(peerUrl);
    const sockUrl = peerUrl + `/ws?their=${encodeURIComponent(SELF_URL)}`;
    const already = [...hub.peers].some(p => p.connectedPeerUrl === peerUrl);
    if (already) continue;
    try {
      const client = await connectClient(sockUrl, { timeoutMs: 4000 });
      client.connectedPeerUrl = peerUrl;
      client.theirUrl = peerUrl;
      client.onMessage = (txt) => {
        let m = null; try { m = JSON.parse(txt); } catch { return; }
        if (m?.type === 'inv-block') hubMsgHandlers.onBlock(m, client);
        if (m?.type === 'inv-tx') hubMsgHandlers.onTx(m, client);
      };
      client.onClose = () => {
        console.log(`[ws] отсоединён: ${peerUrl}`);
        wsCooldown.set(peerUrl, Date.now() + WS_COOLDOWN_MS); // не метнуть в дедуп-сервер, уйти в бэк-off
        wsNextRetry(peerUrl);
      };
      wsRetryClear(peerUrl);
      wsCooldown.delete(peerUrl);
      console.log(`[ws] подключены к ${peerUrl}`);
    } catch (e) {
      wsNextRetry(peerUrl); // AGIP-23: без-умного шторма больше нет — backoff ×fails
      console.log(`[ws] не подключился ${peerUrl}: ${e.message} (backoff ×${(wsRetry.get(peerUrl) || {}).fails})`); /* HTTP-синк продолжит работу */
    }
  }
}
// AGIP-23: рассинхрон циклов нод (±10с jitter) — synchronized retry-storm больше нет
// AGIP-25: на задушенной машине (CPU 100%) интервал WS-циклы поднят 30с→45с,
// джиттер ±10с→±15с — меньше синхронных всплесков между нодами.
(function wsLoopStagger() {
  setTimeout(() => { wsConnectLoop().catch(() => {}); wsLoopStagger(); }, 45_000 + Math.floor(Math.random() * 15_000));
})();
console.log('[ws] ws-модуль инициализирован (server + outbound loop, AGIP-23 backoff+jitter+bootstrap-merge)');
wsConnectLoop().catch((e) => console.log('[ws] loop crash:', e?.stack || e?.message || e));

// === AGIP-7: периодический syncAll (60с) — не полагаемся только на WS-события.
// Инцидент 2026-10-16: при живой WS-разнице нода оставалась со stale-tip жд лотно,
// потому что sync стартовал только по внешним событиям/ручному /sync-now.
// Часовая сеть должна сама подтягивать тяжёлую цепь по таймеру.
// AGIP-25: syncAll 60с→90с (CPU-щадящий ритм; форки всё равно ловятся WS-событиями)
if (process.env.AGT_PEER_DISCOVERY !== '0') setInterval(() => { syncAll(bc).catch(() => {}); }, 90_000).unref();
// AGIP-12: патруль карантина — раз в минуту синхронизируем базу злоумышленников с журналом атак
setInterval(() => {
  try {
    const { taken } = jail.syncFromSecurity(bc.security);
    if (taken) console.log(`[jail] патруль: взято под стражу ${taken} атакующих`);
    const { asked } = jail.autoPoll(); // авто-опрос новым арестантам
    if (asked) console.log(`[jail] авто-опрос выдан: ${asked}`);
    const { parsed } = jail.autoParse(); // автопарсинг ответов в анкеты
    if (parsed) console.log(`[jail] анкет заполнено автоматически: ${parsed}`);
  } catch {}
}, 60_000).unref();
console.log('[sync] периодический syncAll: каждые 60с (AGIP-7)');

// === AGIP-10: налоговая инфраструктура ===
// split-on-send при escrow-payout и DXE-заполнах, когда в паспорте агента есть tax-поле.
// НЕ применяется к P2P-переводам (v1). Суммы налога — целым магентом (округление вверх).
function passportTax(address) {
  let reg = []; try { reg = JSON.parse(fs.readFileSync(path.join(__dirname, 'data-agents', 'passports.json'), 'utf8')); } catch { return null; }
  const rec = reg.find(r => r.address === address);
  if (!rec || !rec.tax || rec.tax.regime === 'none') return null;
  const rate = Math.max(0, Math.min(5000, Number(rec.tax.rateBps) || 0));
  if (!rate || !/^[A-Z]{2,3}$/.test(String(rec.tax.country || ''))) return null;
  return { rate, country: rec.tax.country, fund: rec.tax.fund || ('AGT_TAX_' + rec.tax.country), seq: rec.seq };
}

// возвращает доп-tx (или null) для налогоообложения amount от агента
function taxSplitTx(agentAddr, amount, refMemo) {
  const t = passportTax(agentAddr);
  if (!t || !(amount > 0)) return null;
  const taxAmt = Math.max(0.000000001, Math.ceil(amount * t.rate / 10000 * 1e9) / 1e9); // вверх до 1 MGNT
  if (!(taxAmt > 0)) return null;
  const w = loadWallets()[agentAddr];
  if (!w || !w.privKey) return null; // налог платит агент с этой ноды; чей-же passport — paid с той
  const tx = { from: agentAddr, fromPub: w.pub, to: t.fund, amount: taxAmt, nonce: Date.now() + 7, ts: Math.floor(Date.now() / 1000), memo: `tax:${t.seq}:${t.country}:${t.rate}:${refMemo || ''}` };
  tx.txid = txDigest(tx);
  tx.signature = signTransaction(tx, w.privKey);
  return tx;
}
console.log('[tax] AGIP-10: passport tax split-on-send активен (v1: escrow-payout + DXE)');
