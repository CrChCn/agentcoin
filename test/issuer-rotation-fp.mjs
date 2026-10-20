#!/usr/bin/env node
/* FP-SCHEME-TEST (CI): схемы fingerprint издателя не должны расходиться между тулзой
   ротации, загрузчиком и продовым issuerFingerprint(). Регрессия 2026-10-20: tools
   печатал sha256(PEM-текст), ноды считают sha256(DER SPKI) — пины реплик уходили
   «мимо prода». Проверяет:
   1) tools/rotate-identity-issuer.mjs --dry печатает prevFp той же схемы, что и
      issuerFingerprint() прод-модуля (DER), для одинакового ключа;
   2) identity-issuer.json канонического PEM (с хвостовым \n) с rotation-мета
      (createdAt/rotatedFrom) принимается AgentIdentityRegistry;
   3) PEM без хвостового \n (исторические rotation-файлы) нормализуется загрузчиком,
      fingerprint при этом тот же (считается по DER, форма текста не влияет).
   Запуск: node test/issuer-rotation-fp.mjs   Exit: 0 = all passed. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AgentIdentityRegistry, issuerFingerprint, canonicalAgentPublicKey } from '../agent-identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fails = [];
const ok = (m) => console.log('  ok: ' + m);

function mkdtemp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'agtfp-')); }

/* --- 1. rotate --dry: prevFp в DER-схеме продового issuerFingerprint --- */
{
  const td = mkdtemp();
  const dir = path.join(td, 'data', 'identity');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  const privKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(path.join(dir, 'identity-issuer.json'),
    JSON.stringify({ version: 1, pub, privKey, createdAt: Date.now(), rotatedFrom: 'sha256:' + '0'.repeat(64) }));

  const run = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'rotate-identity-issuer.mjs'), '--dry'],
    { cwd: td, encoding: 'utf8' });
  let out = null;
  try { out = JSON.parse(run.stdout); } catch {}
  if (!out || !out.dry) fails.push('rotate --dry не выдал JSON (stderr: ' + (run.stderr || '').slice(0, 200) + ')');
  else {
    if (out.prevFp !== issuerFingerprint(pub)) fails.push(`prevFp не DER-схема: ${out.prevFp} != ${issuerFingerprint(pub)}`);
    else ok('rotate --dry prevFp == продовой issuerFingerprint (DER-схема)');
    if (!/^sha256:[0-9a-f]{64}$/.test(out.prevFp || '')) fails.push('prevFp не sha256:64hex');
    else ok('prevFp формально sha256:64hex');
    // would.newFp — уже СВЕЖНЯ пара (dry генерирует её рандомно), предсказать её по сид-файлу
    // нельзя; проверяем только схему и отличие от prev.
    if (!/^sha256:[0-9a-f]{64}$/.test(out.would?.newFp || '') || out.would.newFp === out.prevFp)
      fails.push('would.newFp не свежий sha256:64hex');
    else ok('would.newFp — свежий fp корректной схемы, отличный от prev');
  }
}

/* --- 2. canonical PEM + rotation-мета принимается регистром --- */
{
  const td = mkdtemp();
  const dir = path.join(td, 'identity');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = canonicalAgentPublicKey(publicKey.export({ type: 'spki', format: 'pem' }));
  const privKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(path.join(dir, 'identity-issuer.json'),
    JSON.stringify({ version: 1, pub, privKey, createdAt: 1_700_000_000_000, rotatedFrom: 'sha256:' + 'a'.repeat(64) }, null, 2));
  let reg;
  try { reg = new AgentIdentityRegistry({ dataDir: dir, network: 'AGENTCOIN', audience: 'fp-test' }); }
  catch (e) { fails.push('canonical PEM + мета отвергнут загрузчиком: ' + (e.code || e.message)); }
  if (reg) {
    if (reg.meta().issuerFingerprint !== issuerFingerprint(pub)) fails.push('meta issuerFingerprint != DER(pub)');
    else ok('registry принимает canonical PEM + createdAt/rotatedFrom, fp — DER-схема');
  }
}

/* --- 3. trim-нутый PEM нормализуется, fp не меняется --- */
{
  const td = mkdtemp();
  const dir = path.join(td, 'identity');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubCanonical = canonicalAgentPublicKey(publicKey.export({ type: 'spki', format: 'pem' }));
  const pub = pubCanonical.replace(/\n$/, ''); // точно как раньше делала rotate-тулза
  const privKey = privateKey.export({ type: 'pkcs8', format: 'pem' });
  fs.writeFileSync(path.join(dir, 'identity-issuer.json'), JSON.stringify({ version: 1, pub, privKey }));
  let reg;
  try { reg = new AgentIdentityRegistry({ dataDir: dir, network: 'AGENTCOIN', audience: 'fp-test' }); }
  catch (e) { fails.push('trim-PEM не нормализовался: ' + (e.code || e.message)); }
  if (reg) {
    if (reg.meta().issuerFingerprint !== issuerFingerprint(pubCanonical)) fails.push('fp сместился после нормализации');
    else ok('trim-нутый PEM нормализован, fingerprint тот же (DER не зависит от формы текста)');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'identity-issuer.json'), 'utf8'));
    if (onDisk.pub !== pubCanonical) fails.push('нормализованный pub не переписан на диск');
    else ok('нормализованный pubkey записан в файл (следующие старты без rewrite)');
  }
}

if (fails.length) { console.error('FP-SCHEME: FAIL → ' + fails.join('; ')); process.exit(1); }
console.log('FP-SCHEME: all passed');
process.exitCode = 0;
