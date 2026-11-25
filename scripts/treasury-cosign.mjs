#!/usr/bin/env node
// treasury-cosign.mjs — офлайн-подпись для казна-церемонии (air-gapped co-sign).
// Ключ НЕ покидает машину: читается из указанного PEM-файла, наружу уходит
// только подпись (hex) и паб (PEM, он и так публичный).
// Использование (на машине держателя ключа, сети не нужно):
//   node treasury-cosign.mjs <keyPemFile> <digestHex64> [<digestHex64> ...]
// Пример (K1 — обе подписи церемонии одной командой):
//   node treasury-cosign.mjs ./k1.pem 9060927e… c58a3606…
import crypto from 'node:crypto';
import fs from 'node:fs';
const [keyFile, ...digests] = process.argv.slice(2);
if (!keyFile || digests.length === 0 || !digests.every((d) => /^[a-f0-9]{64}$/i.test(String(d)))) {
  console.error('usage: node treasury-cosign.mjs <keyPemFile> <digestHex64> [<digestHex64> ...]');
  process.exit(1);
}
const privKey = fs.readFileSync(keyFile, 'utf8');
if (!privKey.includes('PRIVATE KEY')) { console.error('FAIL: not a PEM private key'); process.exit(1); }
const pub = crypto.createPublicKey(privKey).export({ type: 'spki', format: 'pem' });
const results = digests.map((d) => {
  const digest = String(d).toLowerCase();
  const sig = crypto.sign(null, Buffer.from(digest, 'hex'), privKey).toString('hex');
  const ok = crypto.verify(null, Buffer.from(digest, 'hex'), pub, Buffer.from(sig, 'hex'));
  if (!ok) { console.error('FAIL: self-verify failed for ' + digest); process.exit(1); }
  return { digest, signature: sig };
});
console.log(JSON.stringify({ pub, results }, null, 1));
