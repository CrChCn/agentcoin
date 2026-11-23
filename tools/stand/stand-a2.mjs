#!/usr/bin/env node
/* stand-a2.mjs — A2: автоматическая доставка блоков при обрыве A↔C (процессы живы).
   Mesh A↔B↔C (WS + HTTP), разрыв A↔C через POST /peer/drop в обе стороны,
   3 блока на A БЕЗ /sync-now, доказательство пути по журналам:
   B «[ws] блок H принят от A», C «[ws] блок H принят от B».
   Восстановление связи, сверка tip. Логи нод — в tmp, итог — в
   docs/a-topology/stand-a2-results.json. Запуск из корня репо. */
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const OUT = path.join(REPO, 'docs', 'a-topology', 'stand-a2-results.json');
const R = { startedAt: new Date().toISOString(), testIntervals: { WS_LOOP_MS: 5000, SYNC_ALL_MS: 10000 }, prodIntervals: { WS_LOOP_MS: 45000, SYNC_ALL_MS: 90000 }, steps: [] };
const step = (name, ok, detail) => { R.steps.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pickPort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }

async function boot(label, port) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-a2-'));
  const dataDir = path.join(root, 'data');
  const logFile = path.join(root, 'node.log');
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(root, 'boot.json'), '{"bootstrap":[]}');
  const env = { ...process.env, AGT_DATA_DIR: dataDir, AGT_BOOTSTRAP_FILE: path.join(root, 'boot.json'),
    AGT_ADMIN_MODE: 'token', AGT_ADMIN_TOKEN: token, AGT_BIND: '127.0.0.1',
    AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_WS_LOOP_MS: '5000', AGT_SYNC_ALL_MS: '10000' };
  for (const k of ['AGT_PEER_DISCOVERY', 'AGT_CORE_P0_HEIGHT', 'AGT_TX_DIGEST_V2_HEIGHT', 'AGT_MGNT_HEIGHT', 'AGT_TRUSTED_ISSUERS_FILE', 'AGT_PASSPORT_ISSUER_FINGERPRINT']) delete env[k];
  const log = fs.createWriteStream(logFile, { flags: 'a' });
  const child = spawn(process.execPath, [path.join(REPO, 'node.mjs'), String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => log.write(d)); child.stderr.on('data', d => log.write(d));
  const url = `http://127.0.0.1:${port}`;
  const api = async (route, { method = 'GET', body } = {}) => {
    const r = await fetch(url + route, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', 'x-admin-token': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  for (let i = 0; i < 200 && child.exitCode === null; i++) {
    try { if ((await api('/identity/meta')).status === 200) return { label, port, url, api, child, dataDir, logFile, token }; } catch {}
    await sleep(150);
  }
  throw new Error(label + ' not ready');
}
const life = async n => (await n.api('/life')).body;
const wsstat = async n => (await n.api('/ws/status')).body;
const peersFile = n => JSON.parse(fs.readFileSync(path.join(n.dataDir, 'peers.json'), 'utf8'));
const grepLog = (n, re, fromLine = 0) => fs.readFileSync(n.logFile, 'utf8').split('\n').slice(fromLine).filter(l => re.test(l));
const logLines = n => fs.readFileSync(n.logFile, 'utf8').split('\n').length;

const nodes = {};
try {
  for (const l of ['A', 'B', 'C']) nodes[l] = await boot(l, await pickPort());
  const { A, B, C } = nodes;
  const gens = new Set([(await wsstat(A)).genesisHash, (await wsstat(B)).genesisHash, (await wsstat(C)).genesisHash]);
  step('A2.0 один генезис', gens.size === 1, [...gens][0]?.slice(0, 16));

  // mesh
  for (const [a, b] of [[A, B], [B, A], [B, C], [C, B], [A, C], [C, A]])
    await a.api('/peer/add', { method: 'POST', body: { peer: b.url } });
  // ждём WS-mesh: у каждой ≥2 ws-пира
  let mesh = null;
  for (let i = 0; i < 40; i++) {
    const s = { A: await wsstat(A), B: await wsstat(B), C: await wsstat(C) };
    if (s.A.wsPeers >= 2 && s.B.wsPeers >= 2 && s.C.wsPeers >= 2) { mesh = s; break; }
    await sleep(3000);
  }
  step('A2.1 WS-mesh собран (у каждой ≥2 пира)', !!mesh, mesh ? `A:${mesh.A.wsPeers} B:${mesh.B.wsPeers} C:${mesh.C.wsPeers}` : 'timeout 120s');
  // фактический транспорт каждого маршрута по журналам
  const edge = (from, to) => grepLog(to, new RegExp(`подключены к ${from.url.replace(/[.:]/g, m => '\\' + m)}`)).length > 0 ? `${from.label}→${to.label}:WS-outbound` : `${from.label}→${to.label}:inbound-принят`;
  R.transport = { AB: edge(A, B), BA: edge(B, A), BC: edge(B, C), CB: edge(C, B), AC: edge(A, C), CA: edge(C, A) };
  console.log('транспорт:', JSON.stringify(R.transport));

  // sanity: 1 блок на A — все на одном tip (автоматически, без sync-now)
  const miner = (await A.api('/wallet/create', { method: 'POST', body: { label: 'miner' } })).body;
  await A.api('/mine', { method: 'POST', body: { miner: miner.address } });
  let sane = false;
  for (let i = 0; i < 30; i++) { const t = [await life(A), await life(B), await life(C)]; if (t[0].tipHash === t[1].tipHash && t[1].tipHash === t[2].tipHash) { sane = t[0].blocks; break; } await sleep(1000); }
  step('A2.2 sanity: блок A разошёлся сам (без sync-now)', sane !== false, `h=${sane}`);

  // РАЗРЫВ A↔C в обе стороны
  const dA = await A.api('/peer/drop', { method: 'POST', body: { peer: C.url } });
  const dC = await C.api('/peer/drop', { method: 'POST', body: { peer: A.url } });
  step('A2.3 разрыв A↔C', dA.status === 200 && dC.status === 200, `A закрыл ${dA.body.closedSessions}, C закрыл ${dC.body.closedSessions}`);
  const markA = logLines(A), markC = logLines(C);
  // переждать >1 ws-loop (5с): проверяем, что discovery НЕ восстановил прямую связь
  await sleep(25000);
  const pA = peersFile(A), pC = peersFile(C);
  const reaconn = grepLog(A, new RegExp(`подключены к http://127\\.0\\.0\\.1:${C.port}`), markA).length +
    grepLog(C, new RegExp(`подключены к http://127\\.0\\.0\\.1:${A.port}`), markC).length;
  const sA = await wsstat(A), sC = await wsstat(C);
  step('A2.4 прямая связь A↔C не восстановлена', !pA.includes(C.url) && !pC.includes(A.url) && reaconn === 0,
    `peers A:${pA.length} C:${pC.length} wsPeers A:${sA.wsPeers} C:${sC.wsPeers} redial:${reaconn}`);

  // 3 блока на A, БЕЗ /sync-now; замер доставки
  R.blocks = [];
  for (let k = 0; k < 3; k++) {
    const mined = await A.api('/mine', { method: 'POST', body: { miner: miner.address } });
    const h = mined.body.mined?.height ?? mined.body.height;
    const t0 = Date.now();
    const rec = { height: h, minedAt: t0, hashA: null, seenB: null, seenC: null };
    for (let i = 0; i < 60; i++) {
      const [la, lb, lc] = [await life(A).catch(() => null), await life(B).catch(() => null), await life(C).catch(() => null)];
      if (la && la.blocks >= h && !rec.hashA) rec.hashA = la.tipHash;
      if (lb && lb.blocks >= h && !rec.seenB) rec.seenB = { at: Date.now(), tip: lb.tipHash };
      if (lc && lc.blocks >= h && !rec.seenC) rec.seenC = { at: Date.now(), tip: lc.tipHash };
      if (rec.seenB && rec.seenC) break;
      await sleep(1000);
    }
    R.blocks.push(rec);
    console.log(`блок h=${h}: B за ${rec.seenB ? ((rec.seenB.at - t0) / 1000).toFixed(1) + 'с' : 'НЕ ДОШЁЛ'}, C за ${rec.seenC ? ((rec.seenC.at - t0) / 1000).toFixed(1) + 'с' : 'НЕ ДОШЁЛ'}`);
  }
  const allOk = R.blocks.every(r => r.seenB && r.seenC && r.seenB.tip === r.hashA && r.seenC.tip === r.hashA);
  step('A2.5 три блока дошли до B и до C (хеши совпали)', allOk, R.blocks.map(r => `h=${r.height} C-via-B:${r.seenC ? 'да' : 'НЕТ'}`).join(' '));
  // путь по журналам: B от A, C от B, C НЕ от A
  R.pathProof = [];
  for (const r of R.blocks) {
    const bFromA = grepLog(B, new RegExp(`блок ${r.height} принят от ${A.url.replace(/[.:]/g, m => '\\' + m)}`));
    const cFromB = grepLog(C, new RegExp(`блок ${r.height} принят от ${B.url.replace(/[.:]/g, m => '\\' + m)}`));
    const cFromA = grepLog(C, new RegExp(`блок ${r.height} принят от ${A.url.replace(/[.:]/g, m => '\\' + m)}`));
    R.pathProof.push({ height: r.height, bFromA: bFromA.length, cFromB: cFromB.length, cFromA: cFromA.length });
  }
  const pathOk = R.pathProof.every(p => p.bFromA >= 1 && p.cFromB >= 1 && p.cFromA === 0);
  step('A2.6 путь по журналам: B←A, C←B, C↛A напрямую', pathOk, JSON.stringify(R.pathProof));

  // восстановление
  await A.api('/peer/add', { method: 'POST', body: { peer: C.url } });
  await C.api('/peer/add', { method: 'POST', body: { peer: A.url } });
  let restored = false;
  for (let i = 0; i < 40; i++) { const s = [await wsstat(A), await wsstat(C)]; if (s[0].wsPeers >= 2 && s[1].wsPeers >= 2) { restored = true; break; } await sleep(3000); }
  const tips = [await life(A), await life(B), await life(C)];
  step('A2.7 связь восстановлена, синхронизация идёт', restored && tips[0].tipHash === tips[1].tipHash && tips[1].tipHash === tips[2].tipHash, `tips equal: ${tips[0].tipHash === tips[1].tipHash && tips[1].tipHash === tips[2].tipHash}`);
  R.finalHeights = tips.map(t => t.blocks);
} catch (e) {
  step('harness', false, String(e.message || e).slice(0, 300));
  R.error = String(e.stack || e).slice(0, 800);
} finally {
  for (const n of Object.values(nodes)) { try { n.child.kill('SIGKILL'); } catch {} }
}
R.finishedAt = new Date().toISOString();
R.passed = R.steps.filter(s => s.ok).length; R.failed = R.steps.filter(s => !s.ok).length;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(R, null, 1));
console.log(`ИТОГ A2: ${R.passed} pass / ${R.failed} fail → ${OUT}`);
process.exit(R.failed ? 1 : 0);
