#!/usr/bin/env node
// РОТАЦИЯ ИЗДАТЕЛЯ ИДЕНТИЧНОСТЕЙ (agent-identity.mjs слой):
// генерирует свежий ed25519-ключ издателя, заменяет dataDir/identity/identity-issuer.json,
// архивирует старую версию (forensic), печатает до/после fingerprint.
// После ротации ВСЕ прежние паспорта этого издателя становятся untrusted.
// Использование: node tools/rotate-identity-issuer.mjs [dataDir] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dataDir = process.argv[2] && !process.argv.includes('--dry') ? path.resolve(process.argv[2]) : path.join(process.cwd(), 'data');
const dry = process.argv.includes('--dry');
const issuerFile = path.join(dataDir, 'identity', 'identity-issuer.json');
const archiveFile = path.join(dataDir, 'identity', `identity-issuer.rotated-${Date.now()}.json`);

// fingerprint той же схемой, что идёт в проде — DER SPKI (agent-identity.mjs issuerFingerprint),
// НЕ sha256(PEM-текст): иначе пины реплик не совпадают с /identity/meta после ротации.
const fpOf = (pub) => 'sha256:' + crypto.createHash('sha256').update(crypto.createPublicKey(pub).export({ type: 'spki', format: 'der' })).digest('hex');
fs.mkdirSync(path.join(dataDir, 'identity'), { recursive: true, mode: 0o700 });
const prev = fs.existsSync(issuerFile) ? JSON.parse(fs.readFileSync(issuerFile, 'utf8')) : null;
const prevFp = prev ? fpOf(prev.pub) : '(none)';

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ type: 'spki', format: 'pem' }); // canonical PEM (с хвостовым \n)! .trim() ломал noncanonical_public_key при старте ноды
const privKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).trim();
const newFp = fpOf(pub);

const fresh = { version: 1, pub, privKey, createdAt: Date.now(), rotatedFrom: prevFp };
if (dry) {
  console.log(JSON.stringify({ dry: true, would: { archive: archiveFile, newFp }, prevFp }, null, 2));
} else {
  if (prev) fs.writeFileSync(archiveFile, JSON.stringify(prev, null, 2) + '\n');
  fs.writeFileSync(issuerFile, JSON.stringify(fresh, null, 2) + '\n');
  console.log(JSON.stringify({ rotated: true, prevFp, newFp, archivedTo: prev ? archiveFile : null, issuerFile }, null, 2));
}
