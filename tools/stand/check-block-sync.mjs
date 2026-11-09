#!/usr/bin/env node
// Сверка auth-блока в 3 копиях.
// build-node-v4.py BLOCK (вычисленный) обязан совпадать с tools/node.mjs.v4 побайтово
// (modulo переводы строк): v4 собирается из этого источника.
// apply-wallet-auth-router2.py — старый ревизионный стиль блока: проверяем наличие всех
// поведенческих маркеров + JS-синтаксис, полное тождество — отдельной задачей ресинка.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PY_EXTRACT = String.raw`import io,sys; src = io.open(PY, encoding='utf-8').read()
pre, rest = src.split('BLOCK = u"""', 1)
end = rest.find('"""' + chr(10))
lit = 'u"""' + rest[:end] + '"""'
pre = chr(10).join(l for l in pre.split(chr(10)) if not l.startswith('fetched'))
ns = {}
exec(pre + 'BLOCK = ' + lit, ns)
sys.stdout.buffer.write(ns['BLOCK'].encode('utf-8'))`;
function blockOf(pyFile) {
  return execFileSync('python3', ['-c', PY_EXTRACT.replaceAll('PY', JSON.stringify(pyFile))],
    { cwd: root, encoding: 'utf8' });
}
const v4 = fs.readFileSync(path.join(root, 'tools', 'node.mjs.v4'), 'utf8');
const a = v4.indexOf('/* ==================== AGIP-W2R: /auth/');
const endMark = '/* ==================== конец AGIP-W2R ==================== */';
const v4b = v4.slice(a, v4.indexOf(endMark) + endMark.length);
const norm = (s) => s.replace(/\r\n?/g, '\n').trimEnd();
let fail = 0;
{
  const eb = blockOf('tools/build-node-v4.py');
  const same = norm(eb) === norm(v4b);
  console.log('tools/build-node-v4.py', same ? 'BLOCK_MATCH' : 'BLOCK_DIFF');
  if (!same) fail = 1;
}
{
  const eb = blockOf('tools/apply-wallet-auth-router2.py');
  const markers = ['pin_locked_try_later', 'S.pinFails', 'webauthn_challenge_rate_limited',
    '_live >= 20', 'cabinet_revoked', 'cabinet.revokeAll', 'webauthn_mode_mismatch',
    'all_sessions_invalidated', 'X-Requested-With'];
  const missing = markers.filter((m) => !eb.includes(m));
  // JS-синтаксис вычисленного блока
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blk-sync-'));
  const f = path.join(tmp, 'b.mjs');
  fs.writeFileSync(f, 'async function handleWalletAuth(req, res, p) {\n' + eb + '\n}\n');
  let jsOk = true;
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch { jsOk = false; }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('tools/apply-wallet-auth-router2.py',
    missing.length === 0 && jsOk ? 'BLOCK_MARKERS_OK' : `BLOCK_GAP missing=[${missing.join(',')}] jsOk=${jsOk}`);
  if (missing.length !== 0 || !jsOk) fail = 1;
}
process.exit(fail);
