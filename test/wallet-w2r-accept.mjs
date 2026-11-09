// Приёмка wallet.html (AGIP-W2R): клиентские P0/P1 из разбора интерфейса.
// Статика страницы + node --check + точные суммы + sign-op CLI. Без сети.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProfile } from '../agt-skill/agent-profile.mjs';
import { readPrivateKey } from '../agt-skill/agent-profile.mjs';
import { txDigest, verifyTransaction, createWallet } from '../core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = await fs.readFile(path.join(root, 'site', 'wallet.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

// ---------- P0: секреты не живут в DOM и браузерном хранилище ----------
test('wallet w2r: no JWT/cabinet token in DOM or browser storage', () => {
  assert.doesNotMatch(script, /\.innerHTML\s*=/, 'данные API — только textContent/DOM');
  assert.doesNotMatch(script, /localStorage\.setItem\('agt(WalletJwt|LastAddr)'/, 'нет записи сессии в localStorage');
  assert.doesNotMatch(script, /sessionStorage\.setItem\('agtCabToken'/, 'нет кабинетного токена в sessionStorage');
  assert.doesNotMatch(script, /localStorage\.getItem\('agtWalletJwt'\)/, 'нет чтения старого JWT');
  assert.doesNotMatch(script, /\$\('jwtShow'\)/, 'элемент полного JWT удалён');
  assert.ok(script.includes("localStorage.removeItem('agtWalletJwt')"), 'миграция чистит старые ключи');
  assert.ok(script.includes("sessionStorage.removeItem('agtCabToken')"), 'миграция чистит кабинетный токен');
  assert.ok(script.includes("credentials:'same-origin'"), 'куки same-origin включены');
  assert.ok(script.includes('X-Requested-With'), 'CSRF-заголовок на POST');
});

// ---------- P0: несуществующие CLI устранены ----------
test('wallet w2r: only shipped signing tooling is referenced', () => {
  assert.doesNotMatch(html, /src\/cli\.mjs/, 'нет ссылки на несуществующий src/cli.mjs');
  assert.doesNotMatch(html, /tools\/sign-op\.mjs/, 'нет ссылки на несуществующий tools/sign-op.mjs');
  assert.ok(html.includes('agt-skill/sign-op.mjs'), 'отправка — через shipped agt-skill/sign-op.mjs');
  assert.ok(html.includes('agentcoin-challenge-'), 'вход — скачивание challenge-файла');
  assert.ok(html.includes('Ed25519'), 'спецификация подписи задокументирована на странице');
});

// ---------- синтаксис встроенного JS ----------
test('wallet w2r: embedded script passes node --check', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'w2r-check-'));
  try {
    const f = path.join(tmp, 'w.mjs');
    await fs.writeFile(f, script);
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'node --check: ' + (r.stderr || '').slice(0, 300));
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
});

// ---------- P1: точные суммы (функции страницы, извлечённые как есть) ----------
function pageHelpers() {
  const m = script.match(/function parseAmountToMinor\(s\)\{[\s\S]*?\n\}/);
  const f = script.match(/function fmtMgnt\(x\)\{[^\n]*\}/);
  assert.ok(m && f, 'хелперы сумм найдены в странице');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(m[0] + '\n' + f[0], ctx);
  return ctx;
}
test('wallet w2r: exact minor-unit parsing', () => {
  const ctx = pageHelpers();
  const p = (s) => vm.runInContext(`parseAmountToMinor(${JSON.stringify(s)})`, ctx);
  assert.deepEqual({ ...p('1') }, { minor: '1000000000', num: 1 });
  assert.deepEqual({ ...p('1.25') }, { minor: '1250000000', num: 1.25 });
  assert.deepEqual({ ...p('1.000000000') }, { minor: '1000000000', num: 1 });
  assert.equal(vm.runInContext("fmtMgnt('1250000000')", ctx), '1.25');
  for (const bad of ['0', '0.0000000001', '-1', '1,5', '1e-9', 'abc', '', '1.0000000001'])
    assert.throws(() => p(bad), /bad_amount/, 'отказ: ' + bad);
  // ровно 2^53 минорных единиц — представимо точно, принимается
  assert.deepEqual({ ...p('9007199.254740992') }, { minor: '9007199254740992', num: 9007199.254740992 });
  // 10000000.000000001 — классическая потеря точности double: отказ, а не тихая порча.
  // ...002 — ближайшее представимое double (куда схлопывается и ...001): принимается честно.
  assert.throws(() => p('10000000.000000001'), /inexact_amount/);
  assert.deepEqual({ ...p('10000000.000000002') }, { minor: '10000000000000002', num: 10000000.000000002 });
});

// ---------- sign-op CLI: проверка пакета и подпись ----------
async function withProfile(fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'w2r-signop-'));
  try {
    const profilePath = path.join(tmp, 'profile.json');
    await createProfile({ profilePath, password: 'test-password-1', label: 'w2r-test' });
    const ident = await readPrivateKey({ profilePath, password: 'test-password-1' });
    await fn(tmp, profilePath, ident);
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
}
function runSignOp(args, stdin, cwd) {
  return spawnSync(process.execPath, [path.join(root, 'agt-skill', 'sign-op.mjs'), ...args],
    { input: stdin, encoding: 'utf8', cwd: cwd || root });
}
test('wallet w2r: sign-op verifies package and signs txid', async () => {
  await withProfile(async (tmp, profilePath, ident) => {
    const to = createWallet('receiver').address;
    const tx = { from: ident.address, fromPub: ident.pub, to, amount: 1.25,
      nonce: 1700000000000, ts: 1700000000, memo: 'w2r' };
    const txid = txDigest(tx);
    const op = { opId: 'ab'.repeat(16), payload: { kind: 'send', tx: { ...tx, txid }, txidHex: txid } };
    const opPath = path.join(tmp, 'op.json');
    await fs.writeFile(opPath, JSON.stringify(op));
    const ok = runSignOp(['--profile', profilePath, '--op', opPath, '--to', to, '--amount', '1.25', '--memo', 'w2r'],
      JSON.stringify({ password: 'test-password-1' }));
    assert.equal(ok.status, 0, 'sign-op ok: ' + ok.stderr);
    const out = JSON.parse(ok.stdout);
    assert.equal(out.txid, txid);
    assert.match(out.signature, /^[0-9a-f]{128}$/i);
    assert.ok(verifyTransaction({ ...tx, signature: out.signature }), 'подпись проходит verifyTransaction');
    // Негативы: чужой получатель, подмена суммы, подмена txid, чужой пароль.
    const bad1 = runSignOp(['--profile', profilePath, '--op', opPath, '--to', createWallet('x').address, '--amount', '1.25', '--memo', 'w2r'], JSON.stringify({ password: 'test-password-1' }));
    assert.notEqual(bad1.status, 0, 'чужой to — отказ');
    const bad2 = runSignOp(['--profile', profilePath, '--op', opPath, '--to', to, '--amount', '2.5', '--memo', 'w2r'], JSON.stringify({ password: 'test-password-1' }));
    assert.notEqual(bad2.status, 0, 'чужая сумма — отказ');
    const tampered = { opId: op.opId, payload: { kind: 'send', tx: { ...tx, txid, amount: 2.5 }, txidHex: txid } };
    const tp = path.join(tmp, 'op-tampered.json');
    await fs.writeFile(tp, JSON.stringify(tampered));
    const bad3 = runSignOp(['--profile', profilePath, '--op', tp, '--to', to, '--amount', '2.5', '--memo', 'w2r'], JSON.stringify({ password: 'test-password-1' }));
    assert.notEqual(bad3.status, 0, 'подмена суммы в файле — отказ по пересчёту txid');
    const bad4 = runSignOp(['--profile', profilePath, '--op', opPath, '--to', to, '--amount', '1.25', '--memo', 'w2r'], JSON.stringify({ password: 'wrong' }));
    assert.notEqual(bad4.status, 0, 'чужой пароль — отказ');
  });
});
