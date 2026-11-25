#!/usr/bin/env node
// treasury-cosign.mjs — офлайн-подпись для казна-церемонии (air-gapped co-sign).
// Ключ НЕ покидает машину: читается из указанного PEM-файла, наружу уходит
// только подпись (hex) и паб (PEM, он и так публичный).
// Использование (на машине держателя ключа, сети не нужно):
//   node treasury-cosign.mjs <keyPemFile> <digestHex64>
// Пример: node treasury-cosign.mjs ./treasury-primary.pem 1a0ba032…56f0
import crypto from 'node:crypto';
import fs from 'node:fs';
const [keyFile, digestHex] = process.argv.slice(2);
if (!keyFile || !/^[a-f0-9]{64}$/i.test(String(digestHex || ''))) {
  console.error('usage: node treasury-cosign.mjs <keyPemFile> <digestHex64>');
  process.exit(1);
}
const privKey = fs.readFileSync(keyFile, 'utf8');
if (!privKey.includes('PRIVATE KEY')) { console.error('FAIL: not a PEM private key'); process.exit(1); }
const sig = crypto.sign(null, Buffer.from(digestHex, 'hex'), privKey).toString('hex');
const pub = crypto.createPublicKey(privKey).export({ type: 'spki', format: 'pem' });
const ok = crypto.verify(null, Buffer.from(digestHex, 'hex'), pub, Buffer.from(sig, 'hex'));
if (!ok) { console.error('FAIL: self-verify failed'); process.exit(1); }
console.log(JSON.stringify({ signature: sig, pub }));
