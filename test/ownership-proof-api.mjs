// Сквозная проверка механизма владения ключом на изолированной ноде:
// identity-регистрация → вызов владения → подпись агента → счётчик в /passport/count.
// Никаких внешних URL, прод-данных и унаследованного AGT-окружения.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stageIsolatedSource, isolatedEnvironment } from '../tools/isolated-test-node.mjs';
import { addressFromPub } from '../core.mjs';

const json = async (res) => ({ status: res.status, body: await res.json() });
const post = (base, p, body) => fetch(base + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then(json);
const sign = (message, privateKey) => crypto.sign(null, Buffer.from(message, 'utf8'), privateKey).toString('hex');
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  return { pub, privateKey, address: addressFromPub(pub) };
}

test('внешний агент доказывает владение ключом, счётчик становится проверенным', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agt-ownership-api-'));
  let child;
  try {
    const source = await stageIsolatedSource(path.resolve(import.meta.dirname, '..'), path.join(root, 'source'));
    await mkdir(path.join(source, 'data-agents'));
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port; await new Promise(r => server.close(r));
    await writeFile(path.join(root, 'bootstrap.json'), '{"bootstrap":[]}');
    child = spawn(process.execPath, [path.join(source, 'node.mjs'), String(port)], {
      cwd: root,
      env: { ...isolatedEnvironment(), AGT_DATA_DIR: path.join(root, 'data'), AGT_BIND: '127.0.0.1', AGT_BOOTSTRAP_FILE: path.join(root, 'bootstrap.json'), AGT_ADMIN_MODE: 'local', AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0' },
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    // Старт холодной изолированной ноды на Windows бывает дольше 10 с (AV/FS),
    // поэтому ждём до 30 с; проверка та же: /health должен ответить 200.
    for (let i = 0; i < 300; i++) {
      try { const r = await fetch(base + '/health'); if (r.ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, 'isolated node starts');

    const k = keypair();
    // 1. агент регистрирует identity: подписывает вызов ноды
    const reg = await post(base, '/identity/challenge', { address: k.address, pub: k.pub, handle: 'external-01' });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    const registered = await post(base, '/identity/register', { challengeId: reg.body.challengeId, signature: sign(reg.body.message, k.privateKey) });
    assert.equal(registered.status, 201, JSON.stringify(registered.body));

    const before = (await (await fetch(base + '/passport/count')).json()).origin;
    assert.equal(before.externalRecords, 1);
    assert.equal(before.nodeCustodied, 0);
    // identity-сертификат выдаётся только после проверки подписи вызова, значит
    // владение ключом уже подтверждено при регистрации — это отдельный вид.
    assert.equal(before.verifiedAtRegistration, 1);
    assert.equal(before.verifiedByChallenge, 0);
    assert.equal(before.verifiedExternal, 1);
    assert.equal(before.unverifiedExternal, 0);

    // Публичный статус до повторного вызова: подтверждение именно при регистрации.
    const regStatus = await (await fetch(base + '/passport/ownership?address=' + k.address)).json();
    assert.equal(regStatus.verified, true);
    assert.equal(regStatus.verifiedBy, 'registration');
    assert.equal(regStatus.atRegistration, true);
    assert.equal(regStatus.byChallenge, false);
    assert.equal(typeof regStatus.verifiedAt, 'number');

    // 2. доказательство владения: новый вызов, подпись
    const ch = await post(base, '/passport/ownership/challenge', { address: k.address, pub: k.pub });
    assert.equal(ch.status, 200, JSON.stringify(ch.body));
    const proved = await post(base, '/passport/ownership/prove', { challengeId: ch.body.challengeId, signature: sign(ch.body.message, k.privateKey) });
    assert.equal(proved.status, 200, JSON.stringify(proved.body));
    assert.equal(proved.body.address, k.address);
    assert.equal(proved.body.pub, k.pub);

    const after = (await (await fetch(base + '/passport/count')).json()).origin;
    assert.equal(after.verifiedExternal, 1);
    assert.equal(after.externalRecords, 1);
    assert.equal(after.verifiedAtRegistration, 1);
    assert.equal(after.verifiedByChallenge, 1);
    assert.equal(after.unverifiedExternal, 0);
    const status = await (await fetch(base + '/passport/ownership?address=' + k.address)).json();
    assert.equal(status.verified, true);
    assert.equal(status.verifiedBy, 'challenge');
    assert.equal(status.atRegistration, true);
    assert.equal(status.byChallenge, true);
    assert.equal(status.semantics, 'key_control_confirmed_by_registration_challenge_or_later_ownership_proof_not_independent_operator');

    // 3. отрицательные случаи: повтор вызова, чужой ключ, неизвестный адрес
    assert.equal((await post(base, '/passport/ownership/prove', { challengeId: ch.body.challengeId, signature: sign(ch.body.message, k.privateKey) })).status, 400);
    const ch2 = await post(base, '/passport/ownership/challenge', { address: k.address, pub: k.pub });
    const other = keypair();
    const bad = await post(base, '/passport/ownership/prove', { challengeId: ch2.body.challengeId, signature: sign(ch2.body.message, other.privateKey) });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid_signature');
    const stranger = keypair();
    assert.equal((await post(base, '/passport/ownership/challenge', { address: stranger.address, pub: stranger.pub })).status, 404);
    const mismatch = await post(base, '/passport/ownership/challenge', { address: k.address, pub: other.pub });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error, 'address_public_key_mismatch');
    assert.equal((await (await fetch(base + '/passport/count')).json()).origin.verifiedExternal, 1, 'неудачные попытки не добавляют доверия');
  } finally {
    if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    await rm(root, { recursive: true, force: true });
  }
});

// Запись, заведённая только через /passport/issue, ничего не доказывает: роут не
// проверяет подпись ключа, а требует лишь локальный кошелёк и одобренный пропуск.
// Когда ключ уезжает с ноды, запись становится внешней и должна остаться в
// unverifiedExternal — иначе счётчик снова начнёт завышать доверие.
test('паспорт только из /passport/issue остаётся неподтверждённым после ухода ключа с ноды', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agt-issue-only-'));
  let child;
  try {
    const source = await stageIsolatedSource(path.resolve(import.meta.dirname, '..'), path.join(root, 'source'));
    await mkdir(path.join(source, 'data-agents'));
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = server.address().port; await new Promise(r => server.close(r));
    await writeFile(path.join(root, 'bootstrap.json'), '{"bootstrap":[]}');
    const dataDir = path.join(root, 'data');
    child = spawn(process.execPath, [path.join(source, 'node.mjs'), String(port)], {
      cwd: root,
      env: { ...isolatedEnvironment(), AGT_DATA_DIR: dataDir, AGT_BIND: '127.0.0.1', AGT_BOOTSTRAP_FILE: path.join(root, 'bootstrap.json'), AGT_ADMIN_MODE: 'local', AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0' },
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 300; i++) {
      try { const r = await fetch(base + '/health'); if (r.ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ready, 'isolated node starts');

    // 1. паспорт выдаёт нода: ключ лежит на ноде, пропуск одобрен (FIFO-очередь
    //    в изолированной ноде некому разбирать — ставим одобрение файлом).
    const wallet = await post(base, '/wallet/create', { label: 'issue-only' });
    assert.equal(wallet.status, 201, JSON.stringify(wallet.body));
    const address = wallet.body.address;
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'gate.json'), JSON.stringify({
      queue: {},
      approved: { [address.toLowerCase()]: { seq: 1, approvedAt: Date.now(), handle: 'issue-only' } },
      nextSeq: 2, perHour: 60,
    }));
    const issued = await post(base, '/passport/issue', { address, handle: 'issue-only' });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    assert.equal(issued.body.issued, true);

    const custodied = (await (await fetch(base + '/passport/count')).json()).origin;
    assert.equal(custodied.nodeCustodied, 1, 'пока ключ на ноде — запись заведена нодой');
    assert.equal(custodied.externalRecords, 0);

    // 2. ключ уехал с ноды: запись внешняя, но подтверждения владения нет
    const walletsFile = path.join(dataDir, 'wallets.json');
    const wallets = JSON.parse(await readFile(walletsFile, 'utf8'));
    delete wallets[address];
    await writeFile(walletsFile, JSON.stringify(wallets, null, 2));

    const after = (await (await fetch(base + '/passport/count')).json()).origin;
    assert.equal(after.nodeCustodied, 0);
    assert.equal(after.externalRecords, 1);
    assert.equal(after.verifiedAtRegistration, 0, '/passport/issue не проверяет подпись ключа');
    assert.equal(after.verifiedByChallenge, 0);
    assert.equal(after.verifiedExternal, 0);
    assert.equal(after.unverifiedExternal, 1, 'запись без подписи остаётся неподтверждённой');

    const status = await (await fetch(base + '/passport/ownership?address=' + address)).json();
    assert.equal(status.verified, false);
    assert.equal(status.verifiedBy, null);
    assert.equal(status.atRegistration, false);
    assert.equal(status.byChallenge, false);
  } finally {
    if (child && child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    await rm(root, { recursive: true, force: true });
  }
});
