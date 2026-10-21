// ============================================================
// WALLET-LEGACY-PUB-01: HTTP E2E на disposable-ноде (не prod!).
// Легаси-паспорт: выдан штатным POST /passport/issue БЕЗ pub-поля
// (точный legacy-кейс владельца), ключ кошелька — у ноды.
// Полный цикл: challenge/login → op-request (раньше: passport_pub_missing)
// → локальная подпись txid приватным ключом (ключ не в HTTP)
// → op-submit → блок → on-chain баланс получателя.
// Негативы: двойной submit (одноразовый opId), revocation, чужой pub
// (address_mismatch), отсутствующий паспорт (никаких fallback-подмен).
// data-agents/passports.json живёт вне AGT_DATA_DIR — тест бэкапит/
// восстанавливает его в finally; посторонние данные не трогаются.
// Запуск: node --test test/cabinet-legacy-transfer-e2e.mjs
// (файл переименован из пакета координатора ради ANTI-LEAK filename guard)
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const REPO_ROOT = process.cwd();
const PASSPORT_FILE = path.join(REPO_ROOT, 'data-agents', 'passports.json');

async function pickPort() {
  const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening');
  const port = s.address().port; await new Promise(r => s.close(r));
  return port;
}
async function startNode() {
  const port = await pickPort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-wleg-'));
  const bootFile = path.join(root, 'boot.json');
  fs.writeFileSync(bootFile, '{"bootstrap":[]}');
  const env = { ...process.env,
    AGT_DATA_DIR: path.join(root, 'data'), AGT_BOOTSTRAP_FILE: bootFile,
    AGT_ADMIN_MODE: 'token', AGT_ADMIN_TOKEN: Buffer.from(crypto.randomBytes(32)).toString('hex'),
    AGT_BIND: '127.0.0.1', AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0' };
  for (const k of ['AGT_CORE_P0_HEIGHT', 'AGT_TX_DIGEST_V2_HEIGHT', 'AGT_MGNT_HEIGHT', 'AGT_TRUSTED_ISSUERS_FILE', 'AGT_PASSPORT_ISSUER_FINGERPRINT']) delete env[k];
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'node.mjs'), String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', b => { err = (err + b).slice(-1500); });
  const url = `http://127.0.0.1:${port}`;
  const api = async (route, { method = 'GET', body, admin = true, retry503 = false } = {}) => {
    for (let attempt = 0; ; attempt++) {
      let r;
      try { r = await fetch(url + route, { method, redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { 'content-type': 'application/json', ...(admin ? { 'x-admin-token': env.AGT_ADMIN_TOKEN } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
      catch (e) { if (retry503 && attempt < 20) { await new Promise(rr => setTimeout(rr, 400)); continue; } return { status: 0, body: null, error: e.message }; }
      const j = await r.json().catch(() => null);
      if (r.status === 503 && retry503 && attempt < 20) { await new Promise(rr => setTimeout(rr, 400)); continue; }
      return { status: r.status, body: j };
    }
  };
  let ready = false;
  for (let i = 0; i < 200 && child.exitCode === null; i++) {
    try { if ((await api('/identity/meta')).status === 200) { ready = true; break; } } catch {}
    await new Promise(r2 => setTimeout(r2, 100));
  }
  if (!ready) { try { child.kill('SIGKILL'); } catch {}; throw new Error('node not ready: ' + err.slice(-600)); }
  const post = (route, body, opts = {}) => api(route, { method: 'POST', body, ...opts });
  const node = {
    url, api, post,
    balance: async (a) => Number(((await api('/balance', { method: 'POST', body: { address: a } })).body || {}).balance ?? null),
    mine: async (miner) => api('/mine', { method: 'POST', body: { miner }, retry503: true }),
    loginLegacy: async (w) => {
      const ch = await post('/cabinet/challenge', { address: w.address }, { admin: false });
      assert.equal(ch.status, 200, 'challenge выдан: ' + JSON.stringify(ch.body));
      const message = ch.body.challenge.message;
      const signature = crypto.sign(null, Buffer.from(message, 'utf8'), crypto.createPrivateKey(w.privKey)).toString('hex');
      const lg = await post('/cabinet/login', { address: w.address, mode: 'challenge', nonce: message, signature, challengeId: ch.body.challenge.challengeId }, { admin: false });
      assert.equal(lg.status, 200, 'legacy-вход принят (fallback wallets.pub): ' + JSON.stringify(lg.body));
      return lg.body.token;
    },
    close: () => { try { child.kill('SIGKILL'); } catch {} return fs.promises.rm(root, { recursive: true, force: true }); },
  };
  return node;
}
function readPassportsFile() { try { return JSON.parse(fs.readFileSync(PASSPORT_FILE, 'utf8')); } catch { return []; } }
function editPassport(address, mutate) {
  const reg = readPassportsFile();
  const rec = reg.find(r => r.address === address);
  if (rec) { mutate(rec); fs.writeFileSync(PASSPORT_FILE, JSON.stringify(reg, null, 2)); }
}

test('WALLET-LEGACY-PUB-01 E2E: legacy-паспорт без pub готовит и публикует перевод; негативы честны', { timeout: 180_000 }, async t => {
  const backup = readPassportsFile();
  const backupExisted = fs.existsSync(PASSPORT_FILE);
  const node = await startNode();
  t.after(async () => {
    await node.close();
    if (backupExisted) fs.writeFileSync(PASSPORT_FILE, JSON.stringify(backup, null, 2));
    else { try { fs.unlinkSync(PASSPORT_FILE); } catch {} }
  });

  const w = (await node.post('/wallet/create', { label: 'legacy-holder' })).body;
  const b = (await node.post('/wallet/create', { label: 'recipient' })).body;
  const m = (await node.post('/wallet/create', { label: 'miner' })).body;
  assert.ok(w.privKey, 'локальный кошелёк ноды держит privKey (legacy-контур держателя = нода; ключ не экспортируется тестом)');

  const kn = await node.post('/gate/knock', { address: w.address, handle: 'legacy-holder' });
  assert.equal(kn.status, 201, 'knock: ' + JSON.stringify(kn.body));
  const ac = await node.post('/gate/accept', { knockId: kn.body.knockId });
  assert.equal(ac.status, 200);
  const tick = await node.api('/gate/tick');
  assert.equal(tick.status, 200, 'gate tick');
  assert.ok(tick.body.admitted >= 1, 'адрес допущен FIFO');

  const iss = await node.post('/passport/issue', { address: w.address, handle: 'legacy-holder' });
  assert.equal(iss.status, 201, 'паспорт выдан: ' + JSON.stringify(iss.body).slice(0, 140));
  const rec0 = readPassportsFile().find(r => r.address === w.address);
  assert.ok(rec0, 'запись паспорта в легаси-реестре');
  assert.equal(rec0.pub, undefined, 'легаси-паспорт без pub (не фабрикация)');

  assert.equal((await node.mine(w.address)).status, 200, '50 AGT на W');
  const token = await node.loginLegacy(w);

  const op = await node.post('/cabinet/op-request', { address: w.address, token, op: { kind: 'send', to: b.address, amount: 7, memo: 'wleg e2e' } });
  assert.equal(op.status, 200, 'op-request подготовил данные (раньше passport_pub_missing): ' + JSON.stringify(op.body));
  assert.ok(op.body.opId && op.body.payload && op.body.payload.txidHex, 'payload с txid hex');
  assert.equal(op.body.payload.tx.fromPub, w.pub, 'fromPub = публичному ключу legacy-кошелька (fallback, не выдумка)');

  const sig = crypto.sign(null, Buffer.from(op.body.payload.txidHex, 'hex'), crypto.createPrivateKey(w.privKey)).toString('hex');
  assert.match(sig, /^[0-9a-f]{128}$/);
  const sub = await node.post('/cabinet/op-submit', { opId: op.body.opId, signature: sig });
  assert.equal(sub.status, 201, 'op-submit принял: ' + JSON.stringify(sub.body));
  const dup = await node.post('/cabinet/op-submit', { opId: op.body.opId, signature: sig });
  assert.equal(dup.status, 400, 'повторный submit отклонён (opId одноразовый)');
  assert.ok(dup.body && /op_not_found|invalid_op/.test(JSON.stringify(dup.body)), 'честный код повтора: ' + JSON.stringify(dup.body));

  assert.equal((await node.mine(m.address)).status, 200);
  const balB = await node.balance(b.address);
  assert.equal(balB, 7, 'получатель получил ровно 7 AGT (on-chain)');

  editPassport(w.address, r => { r.pub = b.pub; });
  const opTamper = await node.post('/cabinet/op-request', { address: w.address, token, op: { kind: 'send', to: b.address, amount: 1, memo: 'wleg tamper' } });
  assert.equal(opTamper.status, 400, 'чужой pub отклонён: ' + JSON.stringify(opTamper.body));
  assert.ok(/address_mismatch/.test(JSON.stringify(opTamper.body)), 'стабильный код address_mismatch');
  editPassport(w.address, r => { delete r.pub; });

  editPassport(w.address, r => { r.revoked = true; });
  const rep = await node.post('/cabinet/challenge', { address: w.address }, { admin: false });
  assert.notEqual(rep.status, 200, 'revoked-паспорт не получает challenge: ' + JSON.stringify(rep.body));
  editPassport(w.address, r => { delete r.revoked; });

  const x = (await node.post('/wallet/create', { label: 'no-passport' })).body;
  const opNoPass = await node.post('/cabinet/op-request', { address: x.address, token: 'any', op: { kind: 'send', to: b.address, amount: 1 } });
  assert.notEqual(opNoPass.status, 200, 'без паспорта перевода не будет: ' + JSON.stringify(opNoPass.body));
});
