#!/usr/bin/env node
/* ============================================================
   pillar.mjs — «Столп» Agentcoin: нода + встроенный майнинг.
   Принцип как у Bitcoin: кто держит ноду — тот и майнит.

   Что делает (и чего portable 0.1.0 не делал):
     1) Поднимает node.mjs с ПУБЛИЧНЫМ биндом (по умолчанию 0.0.0.0),
        чтобы другие ноды могли подключаться ВХОДЯЩИМИ (inbound),
        а не только pull с сида.
     2) Создаёт локальный кошелёк столпа (первый запуск) и майнит
        каждый интервал НА НЕГО — встроено, включено по умолчанию.
     3) Анонсирует свой PUBLIC_URL сидам (POST /peer/add) и тянет
        /sync-now, чтобы сеть узнала о новом столпе.
     4) Крутит цикл: sync → mine → announce, пишет живой статус.

   Честные ограничения (читать перед запуском):
     - За домашним NAT без проброса порта inbound не придёт:
       столп будет работать как «майнящая копия» (pull + свой майнинг),
       полным столпом станет после проброса PORT наружу и PUBLIC_URL.
     - Админка в публичном бинде — только token-режим (как в node.mjs):
       токен генерируется сам и лежит рядом в pillar-admin-token.txt.
     - Консенсус не меняем: та же core.mjs-сложность, та же валидация.
       Децентрализация — от независимых операторов, а не от нового кода.

   Запуск:
     node pillar.mjs [--port 9335] [--bind 0.0.0.0]
                     [--public http://ТВОЙ-IP:9335] [--seeds https://agentcoin.work]
                     [--interval 60] [--no-mine]
   Конфиг через env: PILLAR_PORT, PILLAR_BIND, PILLAR_PUBLIC_URL,
     PILLAR_SEEDS (csv), PILLAR_INTERVAL_SEC, PILLAR_MINER_LABEL.
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Корень раскладки зависит от упаковки: репо (packaging/pillar/*.mjs → корень
// репо через 2 уровня), portable-архив (pillar/*.mjs → корень архива через
// 1 уровень). Ищем вверх первый каталог с узнаваемым содержимым.
function findRoot() {
  const ups = [path.resolve(__dirname, '..'), path.resolve(__dirname, '..', '..'), path.resolve(__dirname, '..', '..', '..')];
  for (const d of ups) {
    if (fs.existsSync(path.join(d, 'app', 'node.mjs'))) return d;
    if (fs.existsSync(path.join(d, 'packaging', 'node', 'src', 'node.mjs'))) return d;
    if (fs.existsSync(path.join(d, 'node.mjs')) && fs.existsSync(path.join(d, 'core.mjs'))) return d;
  }
  return path.resolve(__dirname, '..', '..');
}
const ROOT = findRoot();
const STAGE_ENTRY = path.join(ROOT, 'app', 'node.mjs');
const CLOSURE_ENTRY = path.join(ROOT, 'packaging', 'node', 'src', 'node.mjs');
const ROOT_ENTRY = path.join(ROOT, 'node.mjs');
const NODE_ENTRY = [STAGE_ENTRY, CLOSURE_ENTRY, ROOT_ENTRY].find((f) => fs.existsSync(f));
if (!NODE_ENTRY) { console.error('нет node.mjs: ни app/, ни packaging/node/src, ни корень'); process.exit(66); }
const DATA_DIR = process.env.AGT_DATA_DIR || path.join(ROOT, 'data-pillar');
const ADMIN_FILE = path.join(DATA_DIR, 'pillar-admin-token.txt');
const WALLET_FILE = path.join(DATA_DIR, 'pillar-miner-wallet.json');

const arg = (name, def = null) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const has = (name) => process.argv.includes(name);

const PORT = Number(arg('--port') || process.env.PILLAR_PORT || 9335);
const BIND = arg('--bind') || process.env.PILLAR_BIND || '0.0.0.0';
const PUBLIC_URL = arg('--public') || process.env.PILLAR_PUBLIC_URL || '';
const SEEDS = String(arg('--seeds') || process.env.PILLAR_SEEDS || 'https://agentcoin.work')
  .split(',').map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
const INTERVAL = Number(arg('--interval') || process.env.PILLAR_INTERVAL_SEC || 60);
const MINER_LABEL = process.env.PILLAR_MINER_LABEL || 'pillar-miner';
const WANT_MINE = !has('--no-mine');

function ensureAdminToken() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const t = fs.readFileSync(ADMIN_FILE, 'utf8').trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(ADMIN_FILE, t + '\n', { mode: 0o600 });
  try { fs.chmodSync(ADMIN_FILE, 0o600); } catch {}
  return t;
}
const ADMIN_TOKEN = process.env.AGT_ADMIN_TOKEN || ensureAdminToken();
process.env.AGT_ADMIN_TOKEN = ADMIN_TOKEN;

const log = (s) => console.log(`[pillar ${new Date().toISOString().slice(11, 19)}] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(base, method, p, body = null, timeout = 12000) {
  const headers = { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN };
  try {
    const r = await fetch(base + p, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch (e) { return { status: 0, body: {}, err: e.message }; }
}

function seedChain() {
  const dest = path.join(DATA_DIR, 'chain.json');
  if (fs.existsSync(dest)) { log('цепь уже есть в data-pillar/ — снимок не нужен'); return; }
  const candidates = [
    process.env.PILLAR_SNAPSHOT,
    path.join(ROOT, 'data', 'chain.json'),
    path.join(ROOT, 'chain.json'),
    path.join(ROOT, 'bundle-build', 'portable', 'cache', 'chain.json'),
  ].filter(Boolean);
  for (const src of candidates) {
    try {
      if (fs.existsSync(src)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.copyFileSync(src, dest);
        log('первый запуск: снимок цепи → ' + DATA_DIR + ' (из ' + src + ')');
        return;
      }
    } catch (e) { log('снимок ' + src + ' не подошёл: ' + e.message); }
  }
  log('снимка нет — стартую с генезиса, дальше дотяну /sync-now с сидов');
}

function startNode() {
  const env = {
    ...process.env,
    AGT_DATA_DIR: DATA_DIR, AGT_BIND: BIND, AGT_ADMIN_MODE: 'token',
    AGT_ADMIN_TOKEN: ADMIN_TOKEN, AGT_SEED_NODES: SEEDS.join(','),
    AGT_PUBLIC_URL: PUBLIC_URL, AGT_SITE_SYNC: '0',
  };
  log(`старт ноды: ${NODE_ENTRY} ${PORT} (bind ${BIND}, data ${DATA_DIR}, closure=${NODE_ENTRY === CLOSURE_ENTRY ? 'packaging/node/src' : 'root'})`);
  const child = spawn(process.execPath, [NODE_ENTRY, String(PORT)], {
    env, stdio: 'inherit', cwd: ROOT,
  });
  child.on('exit', (c) => { log(`нода вышла (код ${c}) — столп останавливается`); process.exit(c ?? 1); });
  return child;
}

async function waitLife(base, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const r = await api(base, 'GET', '/life', null, 5000);
    if (r.status === 200 && typeof r.body.blocks === 'number') return r.body;
    await sleep(3000);
  }
  return null;
}

async function ensureMinerWallet(base) {
  try {
    const w = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
    if (w.address) { log(`кошелёк столпа: ${w.address}`); return w.address; }
  } catch {}
  log('создаю кошелёк столпа…');
  const r = await api(base, 'POST', '/wallet/create', { label: MINER_LABEL });
  if (!r.body.address) { log(`не создал кошелёк: ${JSON.stringify(r.body).slice(0, 160)}`); return null; }
  fs.writeFileSync(WALLET_FILE,
    JSON.stringify({ address: r.body.address, pub: r.body.pub, privKey: r.body.privKey, createdAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 });
  log(`новый кошелёк столпа: ${r.body.address} (приватный ключ — только в ${WALLET_FILE})`);
  return r.body.address;
}

async function announce(base) {
  if (!PUBLIC_URL) {
    log('PUBLIC_URL не задан — анонса нет (работаю как майнящая копия за NAT; для столпа пробрось порт и задай --public)');
    return;
  }
  for (const seed of SEEDS) {
    if (seed.replace(/\/$/, '') === PUBLIC_URL.replace(/\/$/, '')) continue;
    const r = await api(seed, 'POST', '/peer/add', { url: PUBLIC_URL });
    log(r.status === 200 ? `анонс принят сидом ${seed}` : `анонс ${seed}: ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`);
  }
}

async function main() {
  if (!fs.existsSync(NODE_ENTRY)) { console.error(`нет ${NODE_ENTRY}`); process.exit(66); }
  const base = `http://127.0.0.1:${PORT}`;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  seedChain();
  startNode();
  log('жду /life ноды…');
  const life = await waitLife(base);
  if (!life) { console.error('нода не поднялась — смотри лог выше'); process.exit(1); }
  log(`нода жива: высота ${life.blocks}, valid=${life.chainValid}, fresh=${life.fresh}`);

  let miner = null;
  if (WANT_MINE) miner = await ensureMinerWallet(base);
  else log('майнинг выключен флагом --no-mine');

  await api(base, 'POST', '/sync-now');
  await announce(base);

  let n = 0;
  for (;;) {
    n++;
    try {
      const lr = await api(base, 'GET', '/life');
      const l = lr.body || {};
      let mined = '-';
      if (typeof l.blocks !== 'number') {
        log(`тик ${n}: нода молчит (догоняет сеть, event loop занят) — майнинг на паузе, жду`);
      } else if (miner && l.fresh && l.chainValid !== false) {
        const m = await api(base, 'POST', '/mine', { miner });
        if (m.status === 200 && m.body.mined) mined = `#${m.body.mined.height}`;
        else if (m.body.error) mined = `отказ:${m.body.error}`;
        else if (m.status === 0) mined = 'нода занята';
        log(`тик ${n}: высота ${l.blocks} fresh=${l.fresh} valid=${l.chainValid} mine=${mined}`);
      } else if (miner) {
        log(`тик ${n}: высота ${l.blocks} fresh=${l.fresh} valid=${l.chainValid} — tip не свежий, НЕ майню (иначе закреплю форк, правило AGIP-7)`);
      } else {
        log(`тик ${n}: высота ${l.blocks} fresh=${l.fresh} valid=${l.chainValid} (без майнинга)`);
      }
      if (n % 10 === 0) { await api(base, 'POST', '/sync-now'); await announce(base); }
    } catch (e) { log(`тик ${n} ошибка: ${e.message}`); }
    await sleep(Math.max(15, INTERVAL) * 1000);
  }
}
main();
