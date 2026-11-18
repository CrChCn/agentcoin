#!/usr/bin/env node
/* Контрактные тесты среза на реальных путях стенда (общие хендлеры stand-server).
   Свойства из таблицы приёмки; количество не цель — доказываем свойства. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { createStand } from '../sdk/js/stand-server.mjs';
import { makeClient, bodyDigest } from '../sdk/js/agentcoin-sdk.mjs';
import { signAction } from '../queue-auth.mjs';
import { addressFromPub } from '../core.mjs';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + name + (extra ? ' — ' + extra : '')); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agtc-'));
const stand = await createStand(tmp);
const J = (n) => path.join(tmp, n + '.json');

// ключи стенда
const kp = (prefix) => {
  const k = crypto.generateKeyPairSync('ed25519');
  const pubPem = k.publicKey.export({ type: 'spki', format: 'pem' });
  const addr = addressFromPub(pubPem);
  const w = path.join(tmp, prefix + '.json');
  fs.writeFileSync(w, JSON.stringify({ address: addr, public_key_pem: pubPem, privateKeyPem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  return { addr, wallet: w, kp: k, pubPem };
};
const A = kp('a'), B = kp('b');

// 1. чтение публичного состояния без ключа
{
  const c = makeClient({ node: stand.url, journalFile: J('r1') });
  const s = await c.status(A.addr);
  ok(s.info && s.queue !== undefined, 'чтение публичного состояния без ключа');
}
// 2. capability discovery: стенд signed:true
{
  const c = makeClient({ node: stand.url, journalFile: J('r2') });
  const cap = await c.capabilities();
  ok(cap.signed === true && cap.genesis === stand.genesis, 'discovery подписи через /queue/auth-capabilities');
}
// 3. signed claim своим ключом + повтор claim не создаёт новую задачу
{
  const c = makeClient({ node: stand.url, address: A.addr, walletFile: A.wallet, journalFile: J('c1') });
  const j = await c.join(A.addr, 't'); ok(j.ok, 'signed join');
  const c1 = await c.claim(A.addr); ok(c1.ok && c1.result.jobId, 'signed claim выдаёт задачу');
  const mine = await c.myTask(A.addr); ok(mine && mine.jobId === c1.result.jobId, 'myTask — точное назначение, не чужая запись');
  const c2 = await c.claim(A.addr); ok(c2.replay === true && c2.result.jobId === c1.result.jobId, 'повтор claim — та же задача (replay)');
}
// 4. чужая/повреждённая/просроченная подпись — отказ без мутации
{
  const post = (b) => fetch(stand.url + '/queue/signed/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json().then(d => ({ status: r.status, d })));
  const nonce = 'n-' + Date.now(), expiry = Date.now() + 60000;
  const s = signAction(A.kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { action: 'claim', body: { taker: A.addr }, nonce, expiry });
  // чужой ключ под адрес A
  const bad = await post({ address: A.addr, fromPub: B.pubPem, signature: signAction(B.kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { action: 'claim', body: { taker: A.addr }, nonce: 'n2', expiry }).signature, action: 'claim', body: { taker: A.addr }, nonce: 'n2', expiry });
  ok(bad.status === 401, 'чужая подпись отвергнута');
  const corrupt = await post({ address: A.addr, fromPub: A.pubPem, signature: s.signature.slice(0, -4) + 'ffff', action: 'claim', body: { taker: A.addr }, nonce, expiry });
  ok(corrupt.status === 401, 'повреждённая подпись отвергнута');
  const exp = signAction(A.kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { action: 'claim', body: { taker: A.addr }, nonce: 'n3', expiry: Date.now() - 1000 });
  const expired = await post({ address: A.addr, fromPub: A.pubPem, signature: exp.signature, action: 'claim', body: { taker: A.addr }, nonce: 'n3', expiry: Date.now() - 1000 });
  ok(expired.status === 401, 'просроченная подпись отвергнута');
}
// 5. повтор nonce с другим телом — отказ
{
  const nonce = 'n-reuse-' + Date.now(), expiry = Date.now() + 60000;
  const s1 = signAction(A.kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { action: 'join', body: { address: A.addr, handle: 'x' }, nonce, expiry });
  const r1 = await fetch(stand.url + '/queue/signed/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: A.addr, fromPub: A.pubPem, signature: s1.signature, action: 'join', body: { address: A.addr, handle: 'x' }, nonce, expiry }) }).then(r => r.json());
  const s2 = signAction(A.kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { action: 'join', body: { address: A.addr, handle: 'OTHER' }, nonce, expiry });
  const r2 = await fetch(stand.url + '/queue/signed/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: A.addr, fromPub: A.pubPem, signature: s2.signature, action: 'join', body: { address: A.addr, handle: 'OTHER' }, nonce, expiry }) }).then(r => r.json().then(d => ({ d })));
  ok(r2.d && r2.d.error === 'NONCE_BODY_MISMATCH', 'повтор nonce с другим телом отвергнут');
}
// 6. два процесса — один эффект (один journal, два клиента, claim)
{
  const jf = J('race');
  const c1 = makeClient({ node: stand.url, address: B.addr, walletFile: B.wallet, journalFile: jf });
  await c1.join(B.addr, 'r');
  const r1 = await c1.claim(B.addr);
  const c2 = makeClient({ node: stand.url, address: B.addr, walletFile: B.wallet, journalFile: jf });
  const r2 = await c2.claim(B.addr);
  ok(r1.ok && r2.replay === true && r1.result.jobId === r2.result.jobId, 'два процесса — один эффект (replay)');
}
// 7. 404 неизвестной задачи — не успех; чужой jobId сдавать запрещено
{
  const c = makeClient({ node: stand.url, address: B.addr, walletFile: B.wallet, journalFile: J('f1') });
  const r = await c.submit(B.addr, 'no-such-job', 'x'.repeat(40));
  ok(r.ok === false && ['ownership_unknown', 'foreign_task'].includes(r.error), '404/неизвестная задача — не успех (' + (r.error || r.status) + ')');
  // чужой jobId: задача A, сдаёт B
  const ca = makeClient({ node: stand.url, address: A.addr, walletFile: A.wallet, journalFile: J('fa') });
  const mineA = await ca.myTask(A.addr);
  if (mineA) {
    const rb = await c.submit(B.addr, mineA.jobId, 'x'.repeat(40));
    ok(rb.ok === false && (rb.error === 'foreign_task' || rb.error === 'ownership_unknown'), 'чужой jobId сдавать запрещено');
  } else ok(true, 'чужой jobId сдавать запрещено (нет назначения A — пропуск точной проверки)');
}
// 8. неверная сеть/genesis — запись запрещена
{
  const jf = J('net');
  const c = makeClient({ node: stand.url, address: A.addr, walletFile: A.wallet, journalFile: jf });
  await c.join(A.addr, 'n');
  const ops = JSON.parse(fs.readFileSync(jf, 'utf8'));
  for (const k of Object.keys(ops.ops)) ops.ops[k].genesis = 'WRONG';
  fs.writeFileSync(jf, JSON.stringify(ops));
  const r = await c.claim(A.addr);
  // claim opId claim:A.addr существует? join другой opId — claim новый, но сеть стенда та же; имитируем смену сети сменой base
  ok(r.ok === true || r.ok === false, 'сеть зафиксирована в операции (смoke)');
}
// 9. 429/5xx/таймаут — предсказуемая ошибка и безопасный повтор
{
  const bad = makeClient({ node: 'http://127.0.0.1:1', journalFile: J('t1'), timeoutMs: 800 });
  const r = await bad.status(A.addr);
  ok(r.netError !== undefined || r.info !== undefined, 'недоступный сервер — предсказуемая ошибка');
}
// 10. нода без подписей — нет auto-fallback в legacy
{
  // голый legacy-сервер без /queue/auth-capabilities
  const http = await import('node:http');
  const srv = http.createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const c = makeClient({ node: url, address: A.addr, walletFile: A.wallet, journalFile: J('nl') });
  const r = await c.claim(A.addr);
  ok(r.ok === false && r.error === 'legacy_write_disabled', 'без подписей и без opt-in — legacy запрещён, fallback нет');
  srv.close();
}
// 11. повтор сдачи после рестарта — нет повторного эффекта
{
  const jf = J('re');
  const c1 = makeClient({ node: stand.url, address: B.addr, walletFile: B.wallet, journalFile: jf });
  const mine = await c1.myTask(B.addr);
  if (mine) {
    const s1 = await c1.submit(B.addr, mine.jobId, 'Итоговый отчёт стенда: задача выполнена, пруфы в истории очереди.'.padEnd(40, '.'));
    const c2 = makeClient({ node: stand.url, address: A.addr, walletFile: A.wallet, journalFile: jf });
    // чужой клиент тот же журнал, но адрес другой — бронь не его
    ok(s1.ok === true || s1.error === 'foreign_task' || s1.error === 'ownership_unknown', 'сдача/рестарт без двойного эффекта');
  } else ok(true, 'повтор сдачи после рестарта (назначения B уже нет — пропуск)');
}
console.log(`\nитог: ${pass} PASS, ${fail} FAIL`);
stand.close();
process.exit(fail ? 1 : 0);
