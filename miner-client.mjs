#!/usr/bin/env node
/* ============================================================
   miner-client.mjs — ТОНКИЙ MAYНЕР AGT (вторая машина/задача).
   Не держит цепь: только заголовки (headers-only), как light-client
   в Bitcoin. Роль: добывать поверх СУЩЕСТВУЮЩЕЙ ноды и сдавать
   найденный PoW обратно (строгая валидация на ноде).

   Цикл:
     1) /life          → tipHash/tipAge (чек живости)
     2) /headers?from… → проверяем последние K заголовков дёшево
        (prev-link + PoW) — контроль, что нода не врёт про цепь
     3) /blocktemplate → {header, txs, miner}
     4) локальный PoW-поиск (слайс)
     5) /block/submit  → если tip убежал (stale) — забор отбой, retry

   Запуск: node miner-client.mjs [nodeUrl=http://127.0.0.1:9335] [minerAddress?]
   Guard: data-miner/lock (PID) — вторая копия не стартует.
   Планировщик: AGTThinMiner2 (повторение), запускается как вторая машина.
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { computeBlockHash, hashMeetsDifficulty, validateBlockAgainstChain } from './core.mjs';

const NODE_URL = process.argv[2] || 'http://127.0.0.1:9335';
const HEADERS_CHECK = 8;   // сколько последних заголовков проверяем
const SLICE_MS = 1500;     // максимум на один PoW-слайс (не блокируем event loop)

const DATA_DIR = path.join(process.env.AGT_MINER_DATA || path.join(process.cwd(), 'data-miner'));
const LOCK_FILE = path.join(DATA_DIR, 'lock');
const WALLET_FILE = path.join(DATA_DIR, 'wallet.json');
const HEARTBEAT_FILE = path.join(DATA_DIR, 'heartbeat'); // AGIP-7: живость процесса для зомби-детекта
const HEARTBEAT_STALE_MS = 90_000; // тик 10с × 9 — дальше считаем процесс зомби

function log(line) { console.log(`[miner-client ${new Date().toISOString().slice(11, 19)}] ${line}`); }

// --- guard: единственная копия на машину ---
fs.mkdirSync(DATA_DIR, { recursive: true });
try {
  const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8') || 0);
  if (pid) {
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (!alive) {
      log(`лок мёртв (pid ${pid} не жив) — забираем`);
    } else {
      // AGIP-7: живой, но не пишущий heartbeat = зомби (инцидент 2026-10-16:
      // майнер 9342 молча висел и не майнил, гостей нод — «монтируй майнера»).
      // Захватываём лок и продолжаем — два майнера на одну ноду безвредны
      // (нода сама редко принмает дубли/устаревшие блоки), а зомби-тишина — нет.
      let hb = 0;
      try { hb = Number(fs.readFileSync(HEARTBEAT_FILE, 'utf8') || 0); } catch {}
      if (Date.now() - hb > HEARTBEAT_STALE_MS && hb > 0) {
        log(`зомби-детект: pid ${pid} жив, но heartbeat ${(Math.round((Date.now() - hb) / 1000))}с старый — берем лок себе`);
      } else {
        log(`уже работает (pid ${pid}), выходим`);
        process.exit(0);
      }
    }
  }
} catch {}
fs.writeFileSync(LOCK_FILE, String(process.pid));

process.on('exit', () => { try { if (fs.existsSync(LOCK_FILE)) fs.rmSync(LOCK_FILE); } catch {} });

// --- кошелёк майнера (локальный, второй "машины") ---
function ensureMinerWallet() {
  try { const w = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8')); return w.address; } catch {}
  return null;
}
async function createMinerWallet() {
  const r = await fetch(NODE_URL + '/wallet/create', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'thin-miner-2nd' }),
  });
  const j = await r.json();
  fs.writeFileSync(WALLET_FILE, JSON.stringify({ address: j.address, privKey: j.privKey, note: 'thin miner wallet (2nd machine)', createdAt: Date.now() }, null, 2));
  return j.address;
}
let MINER = process.argv[3] || ensureMinerWallet();

async function api(pathname, init) {
  const r = await fetch(NODE_URL + pathname, { headers: { 'Content-Type': 'application/json' }, ...init });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// Проверка линии заголовков (headers-only контроль честности ноды)
async function verifyHeadersLine(fromHeight) {
  const { body } = await api(`/headers?from=${Math.max(0, fromHeight)}&limit=${HEADERS_CHECK}`);
  let prev = null;
  for (const hd of body.headers || []) {
    if (computeBlockHash(hd.header) !== hd.hash || !hashMeetsDifficulty(hd.hash, hd.header.difficultyBits)) {
      return { ok: false, reason: `header ${hd.height} PoW/hash mismatch — нода подделывает цепь` };
    }
    if (prev && hd.header.prevHash !== prev) {
      return { ok: false, reason: `header ${hd.height} prev-link разорван` };
    }
    prev = hd.hash;
  }
  return { ok: true, tip: prev, count: (body.headers || []).length };
}

async function mineSlice(header) {
  const t0 = Date.now();
  let h = computeBlockHash(header);
  while (Date.now() - t0 < SLICE_MS) {
    if (hashMeetsDifficulty(h, header.difficultyBits)) return { found: true, hash: h, nonces: header.nonce, ms: Date.now() - t0 };
    header.nonce++;
    h = computeBlockHash(header);
    if (header.nonce % 50_000 === 0) await new Promise(r => setImmediate(r)); // не блокируем IO
  }
  return { found: false, nonces: header.nonce, ms: Date.now() - t0 };
}

let stopped = false;
process.on('SIGINT', () => { stopped = true; process.exit(0); });

async function tick() {
  fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); // AGIP-7: pulse для зомби-детекта
  const life = await api('/life');
  if (life.status !== 200 || !life.body.tipHash) { log('нода недоступна, ждём'); return; }
  const tipHash = life.body.tipHash, height = life.body.blocks;
  // AGIP-7: НЕ майним на протухшем tip (tipAgeSec > 300, как в /life tips ноды).
  // Иначе майнер закрепляет собственный форк ноды — инцидент 2026-10-16: 9342
  // неделями тянула свой заглухший форк, пиры отвергали как «fork_not_heavier».
  const tipAgeSec = Number(life.body.tipAgeSec) || 0;
  if (!life.body.fresh || tipAgeSec > 300) {
    log(`tip stale (age=${tipAgeSec}c) — пропускаем слайс, ждём sync ноды (не закрепляем форк)`);
    return;
  }

  // headers-only контроль последних K заголовков (через tip-высоту)
  const v = await verifyHeadersLine(height - HEADERS_CHECK);
  if (!v.ok) { log(`ОТКАЗ: ${v.reason} — БЕЗ МАЙНИНГА`); return; }

  // template и проверка что строим поверх актуального tip
  const { body: tpl } = await api('/blocktemplate', { method: 'POST', body: JSON.stringify({ miner: MINER }) });
  if (tpl.error) { log(`template: ${tpl.error}`); return; }
  if (tpl.header.prevHash !== tipHash) { log('tip ушёл (stale template), retry'); return; }
  // выборочно проверяем coinbase и tx-структуру template-пакета
  if (!tpl.txs?.length) { log('template пустой, retry'); return; }

  const { found, hash, nonces, ms } = await mineSlice(tpl.header);
  if (!found) { log(`slice ${nonces} нонсов без решения (diff ${tpl.header.difficultyBits})`); return; }

  const sub = await api('/block/submit', { method: 'POST', body: JSON.stringify({ miner: MINER, header: tpl.header, txs: tpl.txs, ms }) });
  if (sub.body.accepted) log(`БЛОК ${sub.body.height} ПРИНЯТ (${String(sub.body.hash).slice(0, 12)}), ${nonces} нонсов, ${ms}ms`);
  else log(`submit отклонён: ${sub.body.reason}`);
}

async function main() {
  if (!MINER) { MINER = await createMinerWallet(); log(`создан кошелёк майнера: ${MINER}`); }
  else log(`майнер: ${MINER}`);
  log(`thin-miner → ${NODE_URL} (headers-only, slice ${SLICE_MS}ms)`);
  while (!stopped) {
    try { await tick(); } catch (e) { log(`ERROR ${e.message}`); }
    await new Promise(r => setTimeout(r, 10_000));
  }
}
main();
