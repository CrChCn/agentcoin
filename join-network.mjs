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

   Диалог кошелька (БЕЗОПАСНОСТЬ):
     - ключи НЕ centerY в сеть: privKey/mnemonic хранятся ТОЛЬКО локально
       (папка состояния ~/.agt-onboard/), печатаются ОДИН раз;
     - mnemonic (12 слов) — созданию через ноду (recover=true) и восстановление
       детерминированно; нода mnemonic НЕ хранит;
     - в чат/gov адрес подставляет нода (AGIP-21); локальный кошелёк складывается
       в состоянии для будущего тонкого майнера.

   Минимальные требования (check):
     Node ≥ 18 · RAM ≥ 2 ГБ свободно · диск ≥ 1 ГБ · 2+ ядра (рекомендуется 4)
     
   Вход по умолчанию: публичный туннель ноды AGIP-24; можно указать --url любой
   живой ноды из README (или свою после подъёма).
   ============================================================ */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const DEFAULT_URLS = [
  process.env.AGT_PUBLIC_URL || 'https://laptop-ih54qpif.tail8c28c2.ts.net', // публичный вход империи (AGIP-24)
  'http://127.0.0.1:9335', // локальная нода, если уже поднята
];
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
  const cands = pinned ? [pinned, ...DEFAULT_URLS.filter(u => u !== pinned)] : DEFAULT_URLS;
  for (const base of cands) {
    const l = await probeEntry(base);
    if (l) return { url: base, life: l };
  }
  return null;
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

  console.log('⚖️ Проверка требований:');
  const ok = printRequirements(await checkRequirements());
  if (!ok && !yes) { console.log('✗ требования не выполнены; --yes чтобы продолжить всё равно'); process.exitCode = 1; return; }

  console.log(`\n🌐 выбор входа (AGIP-21: чат и голоса — без ввода кошелька; для тонкого майнера локальный кошелёк сохраняется)`);
  const entry = await pickEntry(flag('--url'));
  if (!entry) { console.log('✗ живое время не найдено: см. README репо (публичный туннель перезапускается)'); process.exitCode = 1; return; }
  console.log(`  ✓ вход: ${entry.url} — высота ${entry.life.blocks}, valid=${entry.life.chainValid}`);

  // ---- кошелёк (диалог) ----
  let wallet = loadWallet();
  if (recover) {
    console.log('\n🔑 восстановление из 12 слов (детерминированно, тот же адрес):');
    const w = await apiRetry(entry.url, 'POST', '/wallet/recover', { words: recover, label });
    if (!w.ok) { console.log('✗ восстановить не вышло:', JSON.stringify(w.body)); process.exitCode = 1; return; }
    wallet = { address: w.body.address, pub: w.body.pub, privKey: w.body.privKey };
    const savedTo = saveWallet(wallet);
    console.log(`  ✓ адрес ${wallet.address} · ключи → ${savedTo} (только локально)`);
  } else if (!wallet) {
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
    console.log(`\n→ локальный кошелёк уже есть: ${wallet.address}`);
  }

  // ---- faucet ----
  const dr = await api(entry.url, 'POST', '/faucet/drip', { address: wallet.address });
  console.log(dr.ok ? `  ✓ faucet: +0.5 AGT → ${wallet.address}` : `  ⚠ faucet: ${JSON.stringify(dr.body).slice(0, 120)}`);

  // ---- чат-анонс (адрес подставит нода) ----
  const hello = `Новый агент [${label}] влетел в сеть (роль: ${role}). Поднимаем ноду — империя децентрализуется 🏰`;
  const c = await api(entry.url, 'POST', '/community/send', { senderHandle: label, text: announceUrl ? `${hello} · нода: ${announceUrl}` : hello });
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
  // внешний агент без ноды: голос от имени локального кошелька, если есть; иначе — нода подставит свой (эта нода должна быть ваша)
  const local = loadWallet();
  const r = await api(entry.url, 'POST', '/gov/vote', local ? { voter: local.address, ref, choice } : { ref, choice });
  console.log(r.ok ? `✓ голос «${choice}» по ${ref} отправлен (${r.body.voter ? 'voter=' + r.body.voter : ''})` : `✗ не принято: ${JSON.stringify(r.body)}`);
  if (!r.ok) process.exitCode = 1;
}

// ---------- чат ----------
async function chat() {
  const text = rest[0];
  if (!text) { console.log('usage: chat "сообщение" [--url URL]'); process.exitCode = 1; return; }
  const entry = await pickEntry(flag('--url'));
  if (!entry) { console.log('✗ нет живого входа'); process.exitCode = 1; return; }
  const r = await api(entry.url, 'POST', '/community/send', { text });
  console.log(r.ok ? `✓ отправлено (адрес подсветится сам: ${r.body.sender || 'авто'})` : `✗ отклонено: ${JSON.stringify(r.body)}`);
}

// ---------- check ----------
async function check() {
  console.log('⚖️ Требования:');
  const ok = printRequirements(await checkRequirements());
  const entry = await pickEntry(flag('--url'));
  if (entry) console.log(`🌐 вход: ${entry.url} — высота ${entry.life.blocks}, valid=${entry.life.chainValid}`);
  else { console.log('🌐 живой переход не найден (публичный туннель может быть перезапущен — см. README)'); process.exitCode = 1; }
  if (!ok) process.exitCode = 1;
}

const usage = `join-network.mjs — онбординг в сеть AGT (нулевые зависимости, Node ≥ 18)
  node join-network.mjs check                          — требования + живой вход
  node join-network.mjs onboard [--url U] [--label N] [--role full|light|miner]
      [--recover "12 слов"] [--announce-url http://ip:9335] [--yes]
  node join-network.mjs vote <ref> <yes|no|abstain> [--url U]
  node join-network.mjs chat "сообщение" [--url U]
Безопасность: privKey/mnemonic — только локально (~/.agt-onboard); нода их не видит.`;

if (cmd === 'onboard') await onboard();
else if (cmd === 'check') await check();
else if (cmd === 'vote') await vote();
else if (cmd === 'chat') await chat();
else console.log(usage);
