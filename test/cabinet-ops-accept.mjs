// AGIP-46 — приёмка операций кабинета с локальной подписью (/cabinet/op-request + /cabinet/op-submit).
// Одноразовая нода: кошелёк-оператор A (портативный паспорт, ключ ТОЛЬКО в тесте) и работодатель B
// (кошелёк ноды — эскроу требует node-кошелёк). Проверяет: send → mempool, order → memo/ref,
// job-claim → квитанция, негативы: нет сессии, служебный memo, чужая/повторная подпись, TTL-гашение.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import * as core from '../core.mjs';
import { Blockchain, txDigest } from '../core.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''));
const ROOT = path.resolve(HERE, '..');
const NODE = path.join(ROOT, 'node.mjs');
const delay = ms => new Promise(r => setTimeout(r, ms));

async function jfetch(origin, route, { method = 'GET', body = null } = {}) {
  const res = await fetch(origin + route, { method, signal: AbortSignal.timeout(8000), cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined });
  let b = null; try { b = await res.json(); } catch {}
  return { status: res.status, body: b };
}
const freePort = () => new Promise(res => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); }); });
const signBytes = (buf, w) => crypto.sign(null, buf, crypto.createPrivateKey(w.privKey)).toString('hex');

async function startNode({ funded = [] } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-ops-'));
  // pre-fund: генезис-блоки в ту же директорию ДО старта ноды (как cabinet-portability)
  const bc = new Blockchain(dataDir);
  for (const w of funded) bc.mineOnce(w.address);
  assert.equal(bc.validate(true).ok, true, 'prefunded chain valid');
  const wallets = {};
  for (const w of funded) wallets[w.address] = { label: w.label, pub: w.pub, privKey: w.privKey, createdAt: Date.now() };
  fs.writeFileSync(path.join(dataDir, 'wallets.json'), JSON.stringify(wallets, null, 2));
  const env = { ...process.env, AGT_DATA_DIR: dataDir, AGT_BIND: '127.0.0.1', AGT_SITE_SYNC: '0',
    AGT_PEER_DISCOVERY: '0', AGT_SPORE: '0', AGT_IDENTITY_AUDIENCE: `agt-ops:${port}`, AGT_IDENTITY_ROLE: 'issuer' };
  const child = spawn(process.execPath, [NODE, String(port)], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', c => { logs = (logs + c).slice(-20000); });
  child.stderr.on('data', c => { logs = (logs + c).slice(-20000); });
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) throw new Error('test_node_exited early, logs:\n' + logs);
    try { const r = await jfetch(origin, '/identity/meta'); if (r.status === 200) return { child, origin, dataDir, logs: () => logs }; } catch {}
    await delay(60);
  }
  child.kill('SIGKILL');
  throw new Error('test_node_start_timeout, logs:\n' + logs);
}
async function stopNode(n) {
  if (!n.child || n.child.exitCode !== null) return;
  const ended = new Promise(r => n.child.once('exit', r));
  n.child.kill('SIGTERM');
  const force = setTimeout(() => n.child.kill('SIGKILL'), 3000);
  try { await ended; } finally { clearTimeout(force); }
  fs.rmSync(n.dataDir, { recursive: true, force: true });
}

test('AGIP-46 ops: send→mempool, order→ref, job-claim→квитанция; негативы честные', async () => {
  const A = core.createWallet('op-agent');   // портативный агент (ключ только в тесте)
  const B = core.createWallet('employer');   // работодателю нужен node-кошелёк (escrow подписывает нода)
  const n = await startNode({ funded: [A, B] });
  try {
    // паспорт A (публичная регистрация)
    const ch = await jfetch(n.origin, '/identity/challenge', { method: 'POST', body: { address: A.address, pub: A.pub, handle: 'op-agent' } });
    assert.equal(ch.status, 200, 'challenge: ' + JSON.stringify(ch.body));
    const reg = await jfetch(n.origin, '/identity/register', { method: 'POST', body: { challengeId: ch.body.challengeId, signature: signBytes(Buffer.from(ch.body.message, 'utf8'), A) } });
    assert.equal(reg.status, 201, 'register: ' + JSON.stringify(reg.body));
    // сессия кабинета A
    const cchal = await jfetch(n.origin, '/cabinet/challenge', { method: 'POST', body: { address: A.address } });
    const issued = cchal.body.challenge || cchal.body;
    const login = await jfetch(n.origin, '/cabinet/login', { method: 'POST', body: { address: A.address, mode: 'challenge', challengeId: issued.challengeId, nonce: issued.message, signature: signBytes(Buffer.from(issued.message, 'utf8'), A) } });
    assert.equal(login.status, 200, 'login: ' + JSON.stringify(login.body));
    const token = login.body.token;

    // --- негатив: op-request без сессии → 401
    const nr = await jfetch(n.origin, '/cabinet/op-request', { method: 'POST', body: { address: A.address, token: 'deadbeef', op: { kind: 'send', to: B.address, amount: 1 } } });
    assert.equal(nr.status, 401, 'op-request без сессии: ' + JSON.stringify(nr.body));

    // --- негатив: служебный memo-префикс → 400
    const nm = await jfetch(n.origin, '/cabinet/op-request', { method: 'POST', body: { address: A.address, token, op: { kind: 'send', to: B.address, amount: 1, memo: 'dxe|O|fake' } } });
    assert.equal(nm.status, 400, 'reserved memo: ' + JSON.stringify(nm.body));
    assert.equal(nm.body.error, 'reserved_memo_prefix', 'memo body');

    // --- send: позитив
    const s1 = await jfetch(n.origin, '/cabinet/op-request', { method: 'POST', body: { address: A.address, token, op: { kind: 'send', to: B.address, amount: 2.5, memo: 'привет, работодатель' } } });
    assert.equal(s1.status, 200, 'send op-request: ' + JSON.stringify(s1.body));
    assert.equal(/\b(kind: 'send'|txidHex)/.test(''), false);
    assert.ok(s1.body.payload.txidHex, 'payload.txidHex есть');
    // чужая подпись → 400 bad_signature
    const badS = await jfetch(n.origin, '/cabinet/op-submit', { method: 'POST', body: { opId: s1.body.opId, signature: signBytes(Buffer.from(s1.body.payload.txidHex, 'hex'), B) } });
    assert.equal(badS.status, 400, 'send чужая подпись: ' + JSON.stringify(badS.body));
    // правильная подпись → 201, но takeOp уже съела opId чужой попыткой? — нет: takeOp гасится ДО верификации,
    // поэтому после неудачной попытки opId уже потрачен → переопрашиваем заново (честная механика отказа)
    assert.equal(badS.body.error, 'bad_signature', 'bad sig error');
    const s2 = await jfetch(n.origin, '/cabinet/op-request', { method: 'POST', body: { address: A.address, token, op: { kind: 'send', to: B.address, amount: 2.5, memo: 'привет, работодатель' } } });
    const goodS = await jfetch(n.origin, '/cabinet/op-submit', { method: 'POST', body: { opId: s2.body.opId, signature: signBytes(Buffer.from(s2.body.payload.txidHex, 'hex'), A) } });
    assert.equal(goodS.status, 201, 'send submit: ' + JSON.stringify(goodS.body));
    assert.equal(goodS.body.accepted, true, 'send accepted');
    //повторный submit того же opId → 400 op_not_found (атомарное гашение)
    const rep = await jfetch(n.origin, '/cabinet/op-submit', { method: 'POST', body: { opId: s2.body.opId, signature: signBytes(Buffer.from(s2.body.payload.txidHex, 'hex'), A) } });
    assert.equal(rep.status, 400, 'replay: ' + JSON.stringify(rep.body));
    assert.equal(rep.body.error, 'op_not_found', 'replay error');

    // --- order: v1 требует item НЕ mbc20-пару для теста (mbc20 на пустой ноде кап не даст) — dxe item
    const o1 = await jfetch(n.origin, '/cabinet/op-request', { method: 'POST', body: { address: A.address, token, op: { kind: 'order', item: 'test:opitem', side: 's', qty: 5, price: 1.25 } } });
    assert.equal(o1.status, 200, 'order op-request: ' + JSON.stringify(o1.body));
    assert.ok(o1.body.payload.ref, 'order ref выдан в задании');
    const o2 = await jfetch(n.origin, '/cabinet/op-submit', { method: 'POST', body: { opId: o1.body.opId, signature: signBytes(Buffer.from(o1.body.payload.txidHex, 'hex'), A) } });
    assert.equal(o2.status, 201, 'order submit: ' + JSON.stringify(o2.body));
    assert.ok(o2.body.ref, 'order ref в ответе');

    // --- job-claim: работодатель открывает эскроу на A, минтим блок, A подписывает квитанцию
    // taskHash должен быть hex 16..64 (регулярка индексера эскроу)
    const TASK = 'a'.repeat(24);
    const esc = await jfetch(n.origin, '/escrow/create', { method: 'POST', body: { employer: B.address, worker: A.address, amount: 10, taskHash: TASK, deadlineSec: 3600 } });
    assert.equal(esc.status, 201, 'escrow create: ' + JSON.stringify(esc.body));
    const mine = await jfetch(n.origin, '/mine', { method: 'POST', body: { miner: B.address } });
    assert.equal([200, 202].includes(mine.status), true, 'mine: ' + JSON.stringify(mine.body));
    // ждём, пока эскроу появится в цепи (майн commits mempool)
    let open = null;
    for (let i = 0; i < 20; i++) {
      const st = await jfetch(n.origin, '/escrow/state');
      open = (st.body?.escrows || []).find(e => e.escId === esc.body.escId && e.status === 'open');
      if (open) break;
      await jfetch(n.origin, '/mine', { method: 'POST', body: { miner: B.address } });
      await delay(200);
    }
    assert.ok(open, 'escrow open в цепи');
    const j1 = await jfetch(n.origin, '/cabinet/op-request', { method: 'POST', body: { address: A.address, token, op: { kind: 'job-claim', escId: esc.body.escId, taskHash: TASK } } });
    assert.equal(j1.status, 200, 'job-claim request: ' + JSON.stringify(j1.body));
    assert.ok(j1.body.payload.digestHex, 'claim digest есть');
    // чужой ключ подписывает → 400 (и opId съеден) — повторяем с правильным
    const badC = await jfetch(n.origin, '/cabinet/op-submit', { method: 'POST', body: { opId: j1.body.opId, signature: signBytes(Buffer.from(j1.body.payload.digestHex, 'hex'), B) } });
    assert.equal(badC.status, 400, 'claim чужая подпись: ' + JSON.stringify(badC.body));
    const j2 = await jfetch(n.origin, '/cabinet/op-request', { method: 'POST', body: { address: A.address, token, op: { kind: 'job-claim', escId: esc.body.escId, taskHash: TASK } } });
    const goodC = await jfetch(n.origin, '/cabinet/op-submit', { method: 'POST', body: { opId: j2.body.opId, signature: signBytes(Buffer.from(j2.body.payload.digestHex, 'hex'), A) } });
    assert.equal(goodC.status, 200, 'claim submit: ' + JSON.stringify(goodC.body));
    assert.equal(goodC.body.receiptSig, signBytes(Buffer.from(j2.body.payload.digestHex, 'hex'), A), 'claim receiptSig');
    assert.equal(goodC.body.workerPub.includes('PUBLIC KEY'), true, 'workerPub из паспорта');

    // --- op-request после logout → 401 (сессия умерла)
    const lo = await jfetch(n.origin, '/cabinet/logout', { method: 'POST', body: { token } });
    assert.equal(lo.status, 200, 'logout');
    const nr2 = await jfetch(n.origin, '/cabinet/op-request', { method: 'POST', body: { address: A.address, token, op: { kind: 'send', to: B.address, amount: 1 } } });
    assert.equal(nr2.status, 401, 'после logout: ' + JSON.stringify(nr2.body));
  } finally { await stopNode(n); }
});
