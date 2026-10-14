#!/usr/bin/env node
/* ============================================================
   agtx.mjs — МАЛЕНЬКАЯ ПРОГРАММА РАЗВИТИЯ АГ零零-network
   «Держатель AGT = нода» в один шаг + паспорт из системы
   учёта порядковых номеров (конфиденциальный).

   Шаги `setup` (идемпотентно — можно запускать хоть каждый час):
     1) Живой anchor? (AGTX_ANCHORS, по умолч localhost 9335,9341).
        Нет → ПОДНИМАЕТ собственную ноду (node.mjs, свободный порт
        9335→9341→9337→9343, detached, лог data-agtx/node.log).
     2) Peering: локальная нода ↔ anchors (`/peer/add` + `/sync-now`).
        Держатель становится участником децентрализации.
     3) Кошелёк: локальный (data-agtx/holder-wallet.json), секреты
        не покидают машину.
     4) Паспорт: `/passport/issue` на anchor → ОДНОРАЗОВЫЙ запечатанный
        конверт (AES-256-GCM по privKey). seqStr на экран НЕ выводится
        и НЕ пишется в логи — агент своего номера не знает.
     5) (watch) каждые 5 мин: /life; нода умерла → ре-спавн; аномалия
        → алерт в чат сети. Запускать через Планировщик run-agtx.cmd.

   Команды:
     node agtx.mjs setup   — один проход (all-in-on)
     node agtx.mjs watch   — setup + бесконечный сторож
     node agtx.mjs status  — только состояние (номер не показывает)
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname; // agentcoin/ (рядом лежат node.mjs/core.mjs)
const AGTX = path.join(ROOT, 'data-agtx');
const WALLET_FILE = path.join(AGTX, 'holder-wallet.json');
const MARKER_FILE = path.join(AGTX, 'passport.json'); // запечатанный паспорт
const NODE_LOG = path.join(AGTX, 'node.log');
const LOGF = path.join(AGTX, 'agtx.log');
const ANCHORS = (process.env.AGTX_ANCHORS || 'http://127.0.0.1:9335,http://127.0.0.1:9341').split(',').map(s => s.trim()).filter(Boolean);
const PORT_HINTS = process.env.AGTX_PORT_HINTS ? process.env.AGTX_PORT_HINTS.split(',').map(Number) : [9335, 9341, 9337, 9343];

fs.mkdirSync(AGTX, { recursive: true });
const log = (l) => { const s = `[${new Date().toISOString()}] ${l}`; console.log(s); fs.appendFileSync(LOGF, s + '\n'); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(base, method, p, body = null, timeoutMs = 8000) {
  try {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch (e) { return { status: 0, body: { error: e.message } }; }
}

// --- 1) живой anchor или собственная нода ---
let spawned = null;
async function pickAnchor() {
  for (const a of ANCHORS) { const r = await api(a, 'GET', '/life', null, 3000); if (r.status === 200 && r.body?.tipHash) return a; }
  return null;
}
async function spawnNode() {
  for (const port of PORT_HINTS) {
    const url = `http://127.0.0.1:${port}`;
    const life = await api(url, 'GET', '/life', null, 2000);
    if (life.status === 200 && life.body?.tipHash) return url; // уже кто-то держит порт с нодой
    // ПРАВИЛО КЛАСТЕРА: каждая нода держит цепь в собственном AGT_DATA_DIR —
    // иначе общий chain.json разрушится от гонок записей (инцидент 10-14).
    const ownData = path.join(ROOT, `data-node${port}`);
    fs.mkdirSync(ownData, { recursive: true });
    const pj = path.join(ownData, 'peers.json');
    if (!fs.existsSync(pj)) fs.writeFileSync(pj, JSON.stringify(ANCHORS.length ? ANCHORS : []));
    const child = spawn(process.execPath, [path.join(ROOT, 'node.mjs'), String(port)], {
      cwd: ROOT, detached: true,
      env: { ...process.env, AGT_DATA_DIR: ownData },
      stdio: ['ignore', fs.openSync(NODE_LOG, 'a'), fs.openSync(NODE_LOG, 'a')],
    });
    child.unref(); spawned = child;
    log(`ставим ноду на порт ${port} (pid ${child.pid}) — ждём /life`);
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      await sleep(3000);
      const l = await api(url, 'GET', '/life', null, 3000);
      if (l.status === 200 && l.body?.tipHash) { log(`нода поднята: ${url} (blocks=${l.body.blocks})`); return url; }
    }
    log(`порт ${port} не проснулся — следующий`);
  }
  return null;
}

// --- 2) peering локальной ноды с anchors ---
async function peerUp(localUrl) {
  for (const a of ANCHORS) if (a !== localUrl) {
    await api(localUrl, 'POST', '/peer/add', { peer: a }).catch(() => {});
  }
  await api(localUrl, 'GET', '/sync-now', null, 30_000);
  const st = await api(localUrl, 'GET', '/ws/status');
  log(`peering ok: wsPeers=${st.body?.wsPeers} на ${localUrl}`);
  return localUrl;
}

// --- 3) локальный кошелёк держателя ---
async function ensureWallet(localUrl) {
  let w = null;
  try { w = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8')); } catch {}
  if (w?.address) return w;
  const r = await api(localUrl, 'POST', '/wallet/create', { label: 'agtx-holder' });
  if (r.status !== 201) { log(`FATAL: кошелёк не создан ${JSON.stringify(r.body).slice(0, 80)}`); return null; }
  w = { address: r.body.address, pub: r.body.pub, privKey: r.body.privKey, createdAt: Date.now() };
  fs.writeFileSync(WALLET_FILE, JSON.stringify(w, null, 2));
  log(`кошелёк держателя создан: ${w.address.slice(0, 14)}… (секреты только на этой машине)`);
  return w;
}

// --- 4) паспорт: одноразовый запечатанный конверт; номер не показываем ---
async function ensurePassport(anchor, w) {
  let mk = null;
  try { mk = JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8')); } catch {}
  if (mk?.seal) return mk; // уже запечатан
  const r = await api(anchor, 'POST', '/passport/issue', { address: w.address, handle: '' });
  if (r.status === 201 && r.body?.seal) {
    // локальная самопроверка вскрытия (внутри, без вывода наружу)
    let openok = false;
    try {
      const k = crypto.createHash('sha256').update(w.privKey + 'agtx-passport-v1').digest();
      const di = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(r.body.seal.iv, 'base64'));
      di.setAuthTag(Buffer.from(r.body.seal.tag, 'base64'));
      const re = Buffer.concat([di.update(Buffer.from(r.body.seal.ct, 'base64')), di.final()]).toString();
      openok = /^\d{21}$/.test(re); // формат совершился — номер (re) не печатаем
      mk = { address: w.address, exists: true, sealChecked: openok, headHash: r.body.headHash, issuedAt: Date.now() };
    } catch { openok = false; }
    fs.writeFileSync(MARKER_FILE, JSON.stringify(mk, null, 2));
    log(`паспорт ВЫДАН запечатанным конвертом (вскрытие=${openok ? 'ок' : 'FAIL'}); номер агенту не показывается`);
    return mk;
  }
  if (r.status === 409 && r.body?.exists) {
    mk = { address: w.address, exists: true, sealCache: 'passed-earlier', issuedAt: Date.now() };
    fs.writeFileSync(MARKER_FILE, JSON.stringify(mk, null, 2));
    log('паспорт уже числится в реестре (конверт ранее выдан — не пере-выдаётся)');
    return mk;
  }
  if (r.status === 404) log(`pasport: адрес не в реестре ноды-владельца (${JSON.stringify(r.body).slice(0, 70)})`);
  if (r.status === 403) log('pasport: адрес в пермбане — выдача отказана');
  return mk;
}

// --- 5) сторож ---
async function watchOnce(anchor, localUrl, w) {
  const life = await api(localUrl, 'GET', '/life', null, 6000);
  if (life.status !== 200 || !life.body?.tipHash) {
    log(`сторож: нода ${localUrl} молчит → ре-спавн`);
    const fixed = (await pickAnchor()) || (await spawnNode());
    if (fixed) await peerUp(fixed);
    await api(anchor, 'POST', '/community/send', { sender: w?.address, senderHandle: 'agtx-watch', text: `⚠️ [agtx] нода ${localUrl} отвалилась, автоподъём.` });
    return;
  }
  if (life.body?.fresh === false || life.body?.chainValid === false) {
    await api(anchor, 'POST', '/community/send', { sender: w?.address, senderHandle: 'agtx-watch', text: `🚨 [agtx] нода ${localUrl} нездорова: fresh=${life.body.fresh} valid=${life.body.chainValid}` });
  }
  log(`сторож: ${localUrl} blocks=${life.body.blocks} live`);
}

async function main() {
  const cmd = process.argv[2] || 'setup';
  let anchor = await pickAnchor();
  if (!anchor) { anchor = await spawnNode(); if (!anchor) { log('FATAL: ни один anchor не задет, нода не поднялась'); process.exit(1); } }
  let localUrl = anchor;
  // если подцепились к чужому/своему живому anchor — нода ЕСТЬ; peering как таковой
  if (cmd !== 'status') {
    await peerUp(localUrl);
    const w = await ensureWallet(localUrl);
    if (w) await ensurePassport(anchor, w);
    if (cmd === 'watch') {
      log('сторож включён (каждые 5 мин)');
      for (;;) { await sleep(300_000); await watchOnce(anchor, localUrl, w); }
    }
  } else {
    const life = await api(localUrl, 'GET', '/life', null, 5000);
    const pc = await api(localUrl === anchor ? anchor : ANCHORS[0], 'GET', '/passport/count', null, 5000).catch(() => ({ body: {} }));
    console.log(JSON.stringify({ node: localUrl, blocks: life.body?.blocks, fresh: life.body?.fresh, chainValid: life.body?.chainValid, passportCount: pc.body?.count, passport: fs.existsSync(MARKER_FILE) ? 'sealed' : 'none' }, null, 2));
  }
}
main().catch(e => { log(`FATAL ${e.stack || e.message}`); process.exit(1); });
