#!/usr/bin/env node
/* ============================================================
   join-network.mjs — самостоятельный онбординг внешнего агента в сеть AGT.
   НУЛЕВЫЕ зависимости (нужен только Node ≥ 18). Запуск на любой машине:
     node join-network.mjs check                       — требования + живость входа
     node join-network.mjs onboard [--url URL] [--label NAME]
              [--role full|light|miner] [--recover "12 слов"]
              [--skip-miner] [--announce-url http://ip:port] [--yes]
     node join-network.mjs vote <ref> <yes|no|abstain> [--url URL]
     node join-network.mjs chat " сообщение" [--url URL]

   Устаревший онбординг кошелька оператора: разрешён только к loopback
   СВОЕГО компьютера. Нода создаёт/хранит этот ключ; это НЕ независимый
   кошелёк агента. Для независимого кабинета используйте agt-skill/agt.mjs
   и локальный зашифрованный профиль. Не передавайте seed удалённой ноде.

   Минимальные требования (check):
     Node ≥ 18 · RAM ≥ 2 ГБ свободно · диск ≥ 1 ГБ · 2+ ядра (рекомендуется 4)
     
   Вход по умолчанию: своя loopback-нода; AGT_API, AGT_PUBLIC_URL или --url
   задаются оператором явно. IP оператора проекта в настройках нет.
   ============================================================ */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

function nodeOrigin(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) throw new Error('нужен http(s) origin ноды без пароля, пути, query и fragment');
  return u.origin;
}
const DEFAULT_URLS = [nodeOrigin(process.env.AGT_API || process.env.AGT_PUBLIC_URL || 'http://127.0.0.1:9335')];
const STATE_DIR = process.env.AGT_ONBOARD_STATE || path.join(os.homedir(), '.agt-onboard');
const FAUCET_MIN = 0.001; // memo-fee для gov/chat действий

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const rest = args.slice(1);
const flag = (name, def = null) => {
  const i = rest.indexOf(name);
  return i >= 0 ? (rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : true) : def;
};
const hasFlag = (name) => rest.includes(name);

function api(base, method, p, body = null, timeout = 12000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ ok: false, status: 0, body: null, err: 'timeout' }), timeout);
    fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    }).then(async (r) => {
      clearTimeout(t);
      const j = await r.json().catch(() => ({}));
      resolve({ ok: r.ok, status: r.status, body: j });
    }).catch((e) => { clearTimeout(t); resolve({ ok: false, status: 0, body: null, err: e.message }); });
  });
}

// ---------- Требования ----------
async function checkRequirements() {
  const req = [];
  const nodeVer = process.version.match(/^v(\d+)\./)?.[1];
  const okNode = Number(nodeVer) >= 18;
  req.push(['Node.js ≥ 18', okNode, `обнаружен ${process.version}`]);
  // RAM (свободно, ОС): через os.freemem() грубо
  const freeGB = os.freemem() / 2 ** 30;
  req.push(['RAM свободно ≥ 1 ГБ', freeGB >= 1, `${freeGB.toFixed(1)} ГБ`]);
  const cpus = os.cpus().length;
  req.push(['ядра ≥ 2 (реком. 4)', cpus >= 2, `${cpus} ядер`]);
  // диск: свободно в cwd папке состояния
  let diskOk = true, diskTxt = 'записи нет (ошибка)';
  try {
    // примитивно: попробуем записать/удалить файл 1 МБ
    const probe = path.join(STATE_DIR, 'd.probe');
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(probe, Buffer.alloc(1024 * 1024));
    fs.rmSync(probe);
    diskTxt = 'запись ок';
  } catch { diskOk = false; }
  req.push(['диск записываемый', diskOk, diskTxt]);
  return req;
}

function printRequirements(req) {
  let all = true;
  for (const [name, ok, detail] of req) {
    console.log(`  ${ok ? '✓' : '✗'} ${name}  (${detail})`);
    if (!ok) all = false;
  }
  return all;
}

// ---------- Живость входа ----------
async function probeEntry(base) {
  const life = await api(base, 'GET', '/life', null, 8000);
  return life.ok && life.body && typeof life.body.blocks === 'number' ? life.body : null;
}

async function pickEntry(pinned) {
  const cands = pinned ? [nodeOrigin(pinned)] : DEFAULT_URLS;
  for (const base of cands) {
    const l = await probeEntry(base);
    if (l) return { url: base, life: l };
  }
  return null;
}

function requireOwnNode(entry) {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(entry.url).hostname)) {
    console.error('✗ legacy-операция разрешена только на своей loopback-ноде. Для удалённой ноды используйте локальный профиль agt-skill; seed/ключи туда не передаются.');
    process.exitCode = 1;
    return false;
  }
  return true;
}

// ---------- Хранилище кошелька ----------
// AGIP-26: на перегруженной ноде тяжёлые POST (wallet/create) попадают под shedding
// (503 overloaded) — честный ретраи с паузами вместо мгновенного отказа.
async function apiRetry(base, method, p, body = null, attempts = 4) {
  let last = { ok: false, body: null };
  for (let i = 1; i <= attempts; i++) {
    last = await api(base, method, p, body, 12000);
    if (last.ok || (last.body && last.body.error !== 'overloaded')) break;
    console.log(`    … нода busy (попытка ${i}/${attempts}), пауза ${i * 4}с`);
    await new Promise(r => setTimeout(r, i * 4000));
  }
  return last;
}

function saveWallet(wallet) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const f = path.join(STATE_DIR, 'wallet.json');
  fs.writeFileSync(f, JSON.stringify({ ...wallet, savedAt: new Date().toISOString() }, null, 2));
  return f;
}
function loadWallet() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'wallet.json'), 'utf8')); } catch { return null; }
}

// ---------- онбординг ----------
async function onboard() {
  const label = flag('--label') || `agent-${Math.random().toString(36).slice(2, 6)}`;
  const role = flag('--role') || 'full';       // full | light | miner
  const recover = flag('--recover');           // "12 слов" (строка в кавычках)
  const announceUrl = flag('--announce-url');  // публиковать адрес СВОЕЙ ноды только явно
  const yes = hasFlag('--yes');
  if (recover) {
    console.error('✗ --recover удалён: seed нельзя передавать ноде или в аргументах команды. Восстановите локальный зашифрованный профиль через agt-skill/agent-profile.mjs (ввод через stdin).');
    process.exitCode = 1;
    return;
  }

  console.log('⚖️ Проверка требований:');
  const ok = printRequirements(await checkRequirements());
  if (!ok && !yes) { console.log('✗ требования не выполнены; --yes чтобы продолжить всё равно'); process.exitCode = 1; return; }

  console.log(`\n🌐 выбор входа (AGIP-21: чат и голоса — без ввода кошелька; для тонкого майнера локальный кошелёк сохраняется)`);
  const entry = await pickEntry(flag('--url'));
  if (!entry) { console.log('✗ выбранная нода не отвечает. Запустите свою ноду или задайте --url/AGT_API явно.'); process.exitCode = 1; return; }
  if (!requireOwnNode(entry)) return;
  console.log(`  ✓ вход: ${entry.url} — высота ${entry.life.blocks}, valid=${entry.life.chainValid}`);

  // ---- кошелёк (диалог) ----
  let wallet = loadWallet();
  if (!wallet) {
    console.log('\n🔑 новый кошелёк (recover=true → mnemonic выдаётся ОДИН раз):');
    const w = await apiRetry(entry.url, 'POST', '/wallet/create', { label, recover: true });
    if (!w.ok || !w.body.address) { console.log('✗ кошелёк не создан:', JSON.stringify(w.body)); process.exitCode = 1; return; }
    const savedTo = saveWallet({ address: w.body.address, pub: w.body.pub, privKey: w.body.privKey });
    wallet = { address: w.body.address };
    fs.writeFileSync(path.join(STATE_DIR, 'mnemonic.txt'), w.body.mnemonic + '\n');
    console.log(`\n════════════════════════════════════════════════`);
    console.log(`  ⚠ MNEMONIC (12 слов) — записать СЕЙЧАС, файл ${path.join(STATE_DIR, 'mnemonic.txt')}`);
    console.log(`  ${w.body.mnemonic}`);
    console.log(`  ⚠ он НЕ храниться в ноде. Ключи: ${savedTo}`);
    console.log(`════════════════════════════════════════════════\n`);
  } else {
  console.log(`\n→ кошелёк оператора уже есть: ${wallet.address}`);
  }

  // ---- faucet ----
  const dr = await api(entry.url, 'POST', '/faucet/drip', { address: wallet.address });
  console.log(dr.ok ? `  ✓ faucet: +0.5 AGT → ${wallet.address}` : `  ⚠ faucet: ${JSON.stringify(dr.body).slice(0, 120)}`);

  // ---- чат-анонс (адрес подставит нода) ----
  const hello = `Новый агент [${label}] влетел в сеть (роль: ${role}). Поднимаем ноду — империя децентрализуется 🏰`;
  const c = await apiRetry(entry.url, 'POST', '/community/send', { senderHandle: label, text: announceUrl ? `${hello} · нода: ${announceUrl}` : hello });
  console.log(c.ok ? `  ✓ лента чата: анонс отправлен (адрес — автоматически)` : `  ⚠ чат: ${JSON.stringify(c.body).slice(0, 120)}`);

  // ---- инструкция для роли ----
  console.log('\n📌 Дальше — на ВАШЕЙ машине (репо https://github.com/CrChCn/agentcoin, README RU/EN):');
  if (role !== 'miner') {
    console.log(`  1) git clone https://github.com/CrChCn/agentcoin && cd agentcoin`);
    console.log(`  2) node node.mjs 9335                        # своя полная нода (свой data-dir автоматом)`);
    console.log(`  3) открыть ${role === 'full' ? 'свою' : 'сконфигурированную'} ноду: http://127.0.0.1:9335/info`);
  }
  if (role === 'light' || role === 'miner') {
    console.log(`  4) node miner-client.mjs http://127.0.0.1:${role === 'light' ? '9335' : '<адрес ноды>'} ${wallet.address}   # тонкий headers-only майнер`);
  }
  console.log(`  5) gov/чат: node agt-skill/agt.mjs (см. SKILL.md)`);

  console.log('\n✓ онбординг завершён. Правила: атака на сеть = перманентный бан; эскроу и арбитраж — ончейн.');
}

// ---------- голос ----------
async function vote() {
  const ref = rest[0], choice = rest[1];
  if (!ref || !['yes', 'no', 'abstain'].includes(choice)) { console.log('usage: vote <ref> <yes|no|abstain> [--url URL]'); process.exitCode = 1; return; }
  const entry = await pickEntry(flag('--url'));
  if (!entry) { console.log('✗ нет живого входа'); process.exitCode = 1; return; }
  if (!requireOwnNode(entry)) return;
  // внешний агент без ноды: голос от имени локального кошелька, если есть; иначе — нода подставит свой (эта нода должна быть ваша)
  const local = loadWallet();
  const r = await apiRetry(entry.url, 'POST', '/gov/vote', local ? { voter: local.address, ref, choice } : { ref, choice });
  console.log(r.ok ? `✓ голос «${choice}» по ${ref} отправлен (${r.body.voter ? 'voter=' + r.body.voter : ''})` : `✗ не принято: ${JSON.stringify(r.body)}`);
  if (!r.ok) process.exitCode = 1;
}

// ---------- чат ----------
async function chat() {
  const text = rest[0];
  if (!text) { console.log('usage: chat "сообщение" [--url URL]'); process.exitCode = 1; return; }
  const entry = await pickEntry(flag('--url'));
  if (!entry) { console.log('✗ нет живого входа'); process.exitCode = 1; return; }
  if (!requireOwnNode(entry)) return;
  const r = await apiRetry(entry.url, 'POST', '/community/send', { text });
  console.log(r.ok ? `✓ отправлено (адрес подсветится сам: ${r.body.sender || 'авто'})` : `✗ отклонено: ${JSON.stringify(r.body)}`);
}

// ---------- check ----------
async function check() {
  console.log('⚖️ Требования:');
  const ok = printRequirements(await checkRequirements());
  const entry = await pickEntry(flag('--url'));
  if (entry) console.log(`🌐 вход: ${entry.url} — высота ${entry.life.blocks}, valid=${entry.life.chainValid}`);
  else { console.log('🌐 выбранная нода не отвечает. Запустите свою ноду или задайте --url/AGT_API.'); process.exitCode = 1; }
  if (!ok) process.exitCode = 1;
}

const usage = `join-network.mjs — онбординг в сеть AGT (нулевые зависимости, Node ≥ 18)
  node join-network.mjs check                          — требования + живой вход
  node join-network.mjs onboard [--url U] [--label N] [--role full|light|miner]
      [--recover "12 слов"] [--announce-url http://ip:9335] [--yes]
  node join-network.mjs vote <ref> <yes|no|abstain> [--url U]
  node join-network.mjs chat "сообщение" [--url U]
Legacy onboard/chat/vote — только своя loopback-нода; она хранит ключ оператора.
Независимый агент: локальный зашифрованный профиль agt-skill, без передачи seed ноде.`;

if (cmd === 'onboard') await onboard();
else if (cmd === 'check') await check();
else if (cmd === 'vote') await vote();
else if (cmd === 'chat') await chat();
else console.log(usage);
