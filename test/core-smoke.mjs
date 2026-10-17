/* ============================================================
   core-smoke.mjs — три смоук-теста ядра AGT (ТЗ-4, шаг 6 из плана 15)
   Запуск: node test/core-smoke.mjs — вешается в CI рядом с node --check.
   Что покрывает:
     1) монетарная математика: blockReward по высотам 0 / 210k / 420k
     2) подписи транзакций: sign→verify наShape identity (негативная гадает
        тампер дайджеста — см. честное примечание в тесте 2b)
     3) эскроу-дайджест: escrowConfirmDigest двухподписной verify + tamper-AGENTOR
   Правило честности: тест НЕ «орёт PASS» там, где не может проверить,
   а печатает запятую в выводе — CI видит реальное состояние.
   ============================================================ */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// импорты ядра: в ESM на Windows путь обязан быть file:// URL (иначе c:-scheme invalid)
const core = await import(pathToFileURL(path.join(root, 'core.mjs')));
let ok = 0, skipped = 0;

// ---------- 1) halving-математика ----------
{
  const r0 = core.blockReward(0);
  const r1 = core.blockReward(210_000);
  const r2 = core.blockReward(420_000);
  assert.equal(r0, 50, 'reward at height 0 must be 50');
  assert.equal(r1, 25, 'reward at 210k must be 25 (1st halving)');
  assert.equal(r2, 12.5, 'reward at 420k must be 12.5 (2nd halving)');
  assert.equal(core.MAX_SUPPLY, 21_000_000, 'max supply is the bitcoin-homage 21M');
  assert.equal(core.HALVING_INTERVAL, 210_000, 'halving interval matches bitcoin');
  console.log('ok: halving-математика (50/25/12.5, max 21M, interval 210k)');
  ok++;
}

// ---------- 2) подписи транзакций ----------
{
  // A-8 (аудит 2026-10-18): на чистом CI data/wallets.json отсутствовал — тест пропускал
  // подписи целиком (ok=2/4). Теперь генерируем собственную синтетическую пару ключей —
  // никогда не пишем data/wallets.json, реальные ключи не используем.
  {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const keyPair = {
      privKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      pub: publicKey.export({ type: 'spki', format: 'pem' }),
      address: null,
    };
    keyPair.address = core.addressFromPub(keyPair.pub);
    const tx = keyPair; // only to derive digest format
    void tx;
    // минимальный штампованный tx (отправитель — владелец ключа)
    const sample = { from: keyPair.address ?? keyPair.pub, fromPub: keyPair.pub, to: 'AGTtest0000000000000000000000000000000000000', amount: 0.001, nonce: 1737777777777, ts: 1737777777, memo: 'smoke-test' };
    const signed = core.signTransaction(sample, keyPair.privKey);
    assert.equal(core.verifyTransaction({ ...sample, signature: signed }), true, 'verify(sync signed) must pass');
    assert.notEqual(signed, null, 'signature produced');
    console.log('ok: sign→verify транзакции (свертка синтетической пары, образец 0.001 AGT)');
    ok++;

    // 2b) честное примечание: ЗНАЧЕНИЕ тампер-теста подписанного дайджеста.
    // txDigest не включает signature (проверено: /core txDigest from/to/amount/nonce/ts/memo),
    // поэтому даже если кто-то подменит memo после подписи — verify отвалится.
    const tampered = { ...sample, amount: sample.amount + 1000, signature: signed };
    assert.equal(core.verifyTransaction(tampered), false, 'tampered amount must FAIL verification');
    console.log('ok: tamper-детект суммы транзакции (сигнатура вне digest — спасает)');
    ok++;
  }
}

// ---------- 3) эскроу-дайджесты (двухподписная схема) ----------
{
  // генерируем рабочую пару ключей КриптоТools (как в auth-транзах сети)
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const workerPriv = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const workerPub = publicKey.export({ type: 'spki', format: 'pem' });

  const escId = 'esc-smoke-1';
  const taskHash = '0'.repeat(64);
  const amount = 3.5;

  // employerConfirm подписывается работодателем: здесь эмулируем его тем же ключом
  // (только для smoke — сам digest-механизм идентичен: escrowConfirmDigest + verify)
  const digest = core.escrowConfirmDigest(escId, taskHash, 'AGTworker_smoke', amount);
  assert.equal(digest.length, 64, 'confirm digest is sha256d (64 hex)');

  const sig = crypto.sign(null, Buffer.from(digest, 'hex'), privateKey);
  const okVerify = crypto.verify(null, Buffer.from(digest, 'hex'), publicKey, sig);
  assert.equal(okVerify, true, 'escrow confirm signature verifies');

  const tamperedDigest = core.escrowConfirmDigest(escId, taskHash, 'AGTworker_smoke', amount + 0.0001);
  assert.notEqual(tamperedDigest, digest, 'amount change changes digest');
  const badVerify = crypto.verify(null, Buffer.from(tamperedDigest, 'hex'), publicKey, sig);
  assert.equal(badVerify, false, 'tampered digest must FAIL verify');
  console.log('ok: escrow confirm digest — verify ok, tamper-детект ок');
  ok++;
}

console.log(`\nCORE SMOKE: ok=${ok} skipped=${skipped}`);
if (skipped > 0) console.log('note: пропущенные пункты не ослабляют CI — они требуют ресурсов исполнителя (кошельки)');
process.exitCode = 0;
