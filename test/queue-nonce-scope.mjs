/* queue-nonce-scope — область уникальности nonce = адрес подписанта (изолированно).
   Один и тот же текст nonce у РАЗНЫХ адресов не конфликтует; у одного адреса —
   идемпотентность по digest (повтор = replay, чужое тело = MISMATCH).
   Exit 0 = ok. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeIdempotentExecutor, actionDigest, nonceKey } from '../queue-auth.mjs';
import { authorizedRun } from '../queue-guards.mjs';
import { signAction } from '../queue-auth.mjs';
import { addressFromPub } from '../core.mjs';

const fails = [];
const ok = (m) => console.log('  ok: ' + m);
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${m}: ждали ${JSON.stringify(b)}, получили ${JSON.stringify(a)}`); else ok(m); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-nscope-'));
const T0 = 1_700_000_000_000;

// ключ адреса в ключе журнала
eq(nonceKey('n1', 'AGTAbC'), 'agtabc|n1', 'nonce-scope: ключ включает адрес нижним регистром');
eq(nonceKey('n1', null), 'n1', 'nonce-scope: без scope — legacy-ключ');

// два адреса, один текст nonce — оба резервируют независимо
{
  const ex = makeIdempotentExecutor(path.join(dir, 'ns.json'));
  const dA = actionDigest({ action: 'claim', body: { t: 'A' }, nonce: 'same', expiry: T0 });
  const dB = actionDigest({ action: 'claim', body: { t: 'B' }, nonce: 'same', expiry: T0 });
  const a1 = ex.begin({ nonce: 'same', digest: dA, expiry: T0, scope: 'AGTAAA' });
  const b1 = ex.begin({ nonce: 'same', digest: dB, expiry: T0, scope: 'AGTBBB' });
  eq(a1.reserved, true, 'nonce-scope: адрес A резервирует same');
  eq(b1.reserved, true, 'nonce-scope: адрес B тем же текстом same — без конфликта');
  ex.commit('same', { by: 'A' }, 'AGTAAA');
  ex.commit('same', { by: 'B' }, 'AGTBBB');
  eq(ex.get('same', 'AGTAAA').result.by, 'A', 'nonce-scope: результаты раздельные (A)');
  eq(ex.get('same', 'AGTBBB').result.by, 'B', 'nonce-scope: результаты раздельные (B)');
  // тот же адрес + тот же nonce + то же тело = replay
  const a2 = ex.begin({ nonce: 'same', digest: dA, expiry: T0, scope: 'AGTAAA' });
  eq(a2.replay, true, 'nonce-scope: повтор своим телом — replay');
  // тот же адрес + тот же nonce + чужое тело = MISMATCH
  const a3 = ex.begin({ nonce: 'same', digest: dB, expiry: T0, scope: 'AGTAAA' });
  eq(a3.error, 'NONCE_BODY_MISMATCH', 'nonce-scope: чужое тело под своим nonce — MISMATCH');
}

// сквозной guard: два пользователя через authorizedRun одним текстом nonce — оба ок
{
  const ex = makeIdempotentExecutor(path.join(dir, 'ns2.json'));
  const mkUser = () => {
    const kp = crypto.generateKeyPairSync('ed25519');
    const priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const pub = kp.publicKey.export({ type: 'spki', format: 'pem' });
    return { priv, pub, addr: addressFromPub(pub) };
  };
  const A = mkUser(), B = mkUser();
  let effects = 0;
  const h = () => { effects++; return { ok: true, n: effects }; };
  const sA = signAction(A.priv, { action: 'claim', body: { t: 1 }, nonce: 'dup', expiry: T0 + 60000 });
  const sB = signAction(B.priv, { action: 'claim', body: { t: 2 }, nonce: 'dup', expiry: T0 + 60000 });
  const rA = authorizedRun({ action: 'claim', address: A.addr, fromPub: A.pub, signature: sA.signature, body: { t: 1 }, nonce: 'dup', expiry: T0 + 60000, now: T0 }, ex, h);
  const rB = authorizedRun({ action: 'claim', address: B.addr, fromPub: B.pub, signature: sB.signature, body: { t: 2 }, nonce: 'dup', expiry: T0 + 60000, now: T0 }, ex, h);
  eq(rA.ok, true, 'nonce-scope: guard A исполнил');
  eq(rB.ok, true, 'nonce-scope: guard B тем же nonce — исполнил (без DoS)');
  eq(effects, 2, 'nonce-scope: два независимых эффекта');
}

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('queue-nonce-scope: ALL GREEN');
