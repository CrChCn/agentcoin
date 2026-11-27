#!/usr/bin/env node
/* build-release.mjs — релизные артефакты вокруг уже собранных файлов:
   RELEASE-MANIFEST.json + .sig (Ed25519), SHA256SUMS, SBOM.spdx.json, BUILDINFO.json.

   Ключ подписи: PEM в AGENTNET_RELEASE_KEY. Если переменная не задана,
   создаётся НОВЫЙ локальный ключ dist/release-key.pem (dist/ в .gitignore).
   Это НЕ официальный ключ проекта: подпись доказывает целостность файлов,
   но не заменяет release-ключ, которому доверяют ноды.
*/
'use strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const OUT = path.join(ROOT, 'dist');
const VERSION = process.env.AGENTNET_VERSION || '0.2.0';
const SETUP_VERSION = process.env.AGENTNET_SETUP_VERSION || '0.2';

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: path.dirname(ROOT), encoding: 'utf8' }).trim();
  } catch { return null; }
}

const setupName = `AgentcoinCore-Preview-${SETUP_VERSION}-win64-setup.exe`;
const candidates = [
  { role: 'installer', file: path.join(OUT, setupName) },
  { role: 'portable-win', file: path.join(OUT, `agentnet-${VERSION}-win-x64.zip`) },
  { role: 'portable-macos', file: path.join(OUT, `agentnet-${VERSION}-macos-arm64.tar.gz`) },
];
const missing = candidates.filter((c) => !fs.existsSync(c.file));
if (missing.length) {
  throw new Error(`missing artifacts:\n${missing.map((m) => `  ${m.file}`).join('\n')}`);
}

const files = candidates.map((c) => ({
  role: c.role,
  name: path.basename(c.file),
  bytes: fs.statSync(c.file).size,
  sha256: sha256File(c.file),
}));

// --- ключ --------------------------------------------------------------------
let key = null;
let keyGenerated = false;
const keyPath = process.env.AGENTNET_RELEASE_KEY || path.join(OUT, 'release-key.pem');
if (fs.existsSync(keyPath)) {
  key = crypto.createPrivateKey(fs.readFileSync(keyPath));
} else {
  const pair = crypto.generateKeyPairSync('ed25519');
  key = pair.privateKey;
  fs.writeFileSync(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  keyGenerated = true;
}
const pubPem = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
const pubRaw = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });
const pubId = crypto.createHash('sha256').update(pubRaw).digest('hex').slice(0, 32);

const manifest = {
  schema: 'agentcoin/release-manifest@1',
  product: 'Agentcoin Core',
  version: VERSION,
  channel: 'preview',
  chainId: 'AGENTCOIN',
  genesis: '00026d18205c7c873bd612d6e2480321171eb0cb0b3d06c2c2cb0b17b9188e4e',
  protocol: 1,
  network: { p2p: [19444], api: 9333, gateway: 9334, lanDiscovery: 9337 },
  services: ['AgentcoinNode', 'AgentcoinGuard'],
  files,
  signed: { algorithm: 'ed25519', keyId: pubId, authenticode: false },
  notes: [
    'setup.exe не подписан Authenticode: сертификата Microsoft нет, ожидается SmartScreen warning.',
    'P2P-протокол несовместим с WebSocket-P2P production-нод agentcoin.work.',
    'Снимок цепи до checkpoint принят как доверенный (assumevalid).',
  ],
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(OUT, 'RELEASE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const signature = crypto.sign(null, Buffer.from(canonical(manifest), 'utf8'), key);
fs.writeFileSync(path.join(OUT, 'RELEASE-MANIFEST.sig'), `${signature.toString('base64url')}\n`);
fs.writeFileSync(path.join(OUT, 'RELEASE-MANIFEST.pub.pem'), pubPem);

// проверка собственной подписи тем же ключом
const ok = crypto.verify(null, Buffer.from(canonical(manifest), 'utf8'), crypto.createPublicKey(key), signature);
if (!ok) throw new Error('release manifest signature self-check failed');

fs.writeFileSync(path.join(OUT, 'SHA256SUMS'),
  `${files.map((f) => `${f.sha256}  ${f.name}`).join('\n')}\n`
  + `${sha256File(path.join(OUT, 'RELEASE-MANIFEST.json'))}  RELEASE-MANIFEST.json\n`);

const nodeVersion = process.version;
const sbom = {
  spdxVersion: 'SPDX-2.3',
  dataLicense: 'CC0-1.0',
  SPDXID: 'SPDXRef-DOCUMENT',
  name: `agentcoin-core-${VERSION}`,
  documentNamespace: `https://agentcoin.work/spdx/agentcoin-core-${VERSION}-${Date.now()}`,
  creationInfo: {
    created: new Date().toISOString(),
    creators: [`Tool: agentnet-build-release/${VERSION}`, 'Organization: Agentcoin'],
  },
  packages: [
    {
      SPDXID: 'SPDXRef-Package-agentnet',
      name: 'agentnet',
      versionInfo: VERSION,
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      supplier: 'Organization: Agentcoin',
      comment: 'Node.js P2P node, portable launcher, guard, installer scripts. No third-party npm dependencies.',
    },
    {
      SPDXID: 'SPDXRef-Package-nodejs',
      name: 'node',
      versionInfo: nodeVersion,
      downloadLocation: 'https://nodejs.org/',
      filesAnalyzed: false,
      licenseConcluded: 'MIT',
      supplier: 'Organization: OpenJS Foundation',
      comment: 'Embedded runtime (node.exe / node for macOS arm64).',
    },
    {
      SPDXID: 'SPDXRef-Package-dotnetfx',
      name: 'Microsoft .NET Framework',
      versionInfo: '4.0.30319',
      downloadLocation: 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: 'NOASSERTION',
      supplier: 'Organization: Microsoft',
      comment: 'Used at build time by csc.exe to compile AgentcoinServiceHost.exe; present on Windows 10/11.',
    },
  ],
  relationships: [
    { spdxElementId: 'SPDXRef-DOCUMENT', relationshipType: 'DESCRIBES', relatedSpdxElement: 'SPDXRef-Package-agentnet' },
    { spdxElementId: 'SPDXRef-Package-agentnet', relationshipType: 'CONTAINS', relatedSpdxElement: 'SPDXRef-Package-nodejs' },
  ],
};
fs.writeFileSync(path.join(OUT, 'SBOM.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`);

const buildinfo = {
  schema: 'agentcoin/buildinfo@1',
  version: VERSION,
  builtAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch, release: os.release(), node: nodeVersion },
  toolchain: {
    csc: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    iexpress: 'C:\\Windows\\System32\\iexpress.exe',
    zip: 'System.IO.Compression.ZipFile',
  },
  git: {
    commit: git(['rev-parse', 'HEAD']),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty: (git(['status', '--porcelain']) || '').length > 0,
  },
  releaseKey: { keyId: pubId, generated: keyGenerated, path: keyPath },
  files,
};
fs.writeFileSync(path.join(OUT, 'BUILDINFO.json'), `${JSON.stringify(buildinfo, null, 2)}\n`);

console.log(`[release] manifest + sig, keyId=${pubId}${keyGenerated ? ' (NEW local key)' : ''}`);
console.log(`[release] SHA256SUMS, SBOM.spdx.json, BUILDINFO.json in ${OUT}`);
for (const f of files) console.log(`  ${f.sha256}  ${f.name}`);
