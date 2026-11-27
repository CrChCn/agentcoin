#!/usr/bin/env node
/* build-installer.mjs — собирает настоящий Windows-установщик
   dist/AgentcoinCore-Preview-0.2-win64-setup.exe из уже собранного пакета
   dist/agentnet-0.2.0-win-x64.

   Состав:
   - payload.zip: app/, node.exe, chain.json, peers.txt, README.txt,
     AgentcoinServiceHost.exe (собран csc.exe из .NET Framework 4), uninstall.ps1;
   - setup.exe (Setup.cs, манифест requireAdministrator) с payload.zip и
     install.ps1 внутри: распаковывает их во временный каталог, запускает
     install.ps1 с правами администратора и удаляет каталог после выхода.

   Никаких внешних пакетов и сети: только csc.exe из Windows.
   iexpress/makecab не используются: на этой машине makecab зависал на 30+ минут
   без выходного файла, поэтому упаковка заменена встроенными ресурсами.
*/
'use strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const INSTALLER = path.join(ROOT, 'installer');
const AGENTCOIN = path.dirname(ROOT);
const VERSION = process.env.AGENTNET_VERSION || '0.2.0';
const SETUP_VERSION = process.env.AGENTNET_SETUP_VERSION || '0.2';
const SRC = path.join(ROOT, 'dist', `agentnet-${VERSION}-win-x64`);
const OUT = path.join(ROOT, 'dist');
const WORK = path.join(OUT, 'installer');
const PAYLOAD = path.join(WORK, 'payload');
const IEX = path.join(WORK, 'iex');
const SETUP_PATH = path.join(OUT, `AgentcoinCore-Preview-${SETUP_VERSION}-win64-setup.exe`);

const CSC_CANDIDATES = [
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
];
const SETUP_MANIFEST = path.join(INSTALLER, 'setup.manifest');
const SETUP_SOURCE = path.join(INSTALLER, 'Setup.cs');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function firstExisting(paths) {
  return paths.find((p) => fs.existsSync(p)) || null;
}

if (!fs.existsSync(SRC)) {
  throw new Error(`no portable build: ${SRC}\nrun: npm run build:portable`);
}
const csc = firstExisting(CSC_CANDIDATES);
if (!csc) throw new Error('csc.exe (.NET Framework 4) not found');
if (!fs.existsSync(SETUP_SOURCE)) throw new Error(`setup source not found: ${SETUP_SOURCE}`);
if (!fs.existsSync(SETUP_MANIFEST)) throw new Error(`setup manifest not found: ${SETUP_MANIFEST}`);

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(PAYLOAD, { recursive: true });
fs.mkdirSync(IEX, { recursive: true });

// --- payload -----------------------------------------------------------------
fs.cpSync(SRC, PAYLOAD, { recursive: true });
fs.copyFileSync(path.join(INSTALLER, 'uninstall.ps1'), path.join(PAYLOAD, 'uninstall.ps1'));
fs.copyFileSync(path.join(INSTALLER, 'install.ps1'), path.join(PAYLOAD, 'install.ps1'));

const hostExe = path.join(PAYLOAD, 'AgentcoinServiceHost.exe');
const scRef = firstExisting([
  path.join(path.dirname(csc), 'System.ServiceProcess.dll'),
  'System.ServiceProcess.dll',
]);
console.log(`[installer] compiling service host with ${csc}`);
execFileSync(csc, [
  '/nologo', '/target:exe', '/optimize+', '/codepage:65001',
  `/out:${hostExe}`,
  ...(scRef ? [`/r:${scRef}`] : []),
  path.join(INSTALLER, 'ServiceHost.cs'),
], { stdio: 'inherit' });
if (!fs.existsSync(hostExe)) throw new Error('service host was not compiled');
console.log(`[installer] service host: ${(fs.statSync(hostExe).size / 1024).toFixed(1)} KiB`);

// --- payload.zip -------------------------------------------------------------
const payloadZip = path.join(IEX, 'payload.zip');
fs.rmSync(payloadZip, { force: true });
execFileSync('powershell', ['-NoProfile', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${PAYLOAD}','${payloadZip}',[System.IO.Compression.CompressionLevel]::Optimal,$false)`],
{ stdio: 'inherit' });
console.log(`[installer] payload.zip: ${(fs.statSync(payloadZip).size / 1048576).toFixed(1)} MiB`);

fs.copyFileSync(path.join(INSTALLER, 'install.cmd'), path.join(IEX, 'install.cmd'));
fs.copyFileSync(path.join(INSTALLER, 'install.ps1'), path.join(IEX, 'install.ps1'));

// --- setup.exe: csc + встроенные ресурсы -------------------------------------
fs.rmSync(SETUP_PATH, { force: true });
console.log(`[installer] building setup.exe with ${csc}`);
execFileSync(csc, [
  '/nologo', '/target:exe', '/optimize+', '/codepage:65001',
  `/out:${SETUP_PATH}`,
  `/win32manifest:${SETUP_MANIFEST}`,
  `/resource:${payloadZip},payload.zip`,
  `/resource:${path.join(INSTALLER, 'install.ps1')},install.ps1`,
  '/r:System.IO.Compression.dll',
  '/r:System.IO.Compression.FileSystem.dll',
  SETUP_SOURCE,
], { stdio: 'inherit' });
if (!fs.existsSync(SETUP_PATH)) throw new Error(`csc did not produce ${SETUP_PATH}`);

const sha = sha256File(SETUP_PATH);
const bytes = fs.statSync(SETUP_PATH).size;
fs.writeFileSync(`${SETUP_PATH}.sha256`, `${sha}  ${path.basename(SETUP_PATH)}\n`);
console.log(`[installer] ${path.basename(SETUP_PATH)}  ${(bytes / 1048576).toFixed(1)} MiB  sha256=${sha}`);

const relPath = path.join(OUT, 'RELEASE-SETUP.json');
fs.writeFileSync(relPath, JSON.stringify({
  product: 'Agentcoin Core',
  version: VERSION,
  setupVersion: SETUP_VERSION,
  file: path.basename(SETUP_PATH),
  bytes,
  sha256: sha,
  services: ['AgentcoinNode', 'AgentcoinGuard'],
  ports: { p2p: 19444, api: 9333, gateway: 9334, lanDiscovery: 9337 },
  signed: false,
  builtAt: new Date().toISOString(),
}, null, 2));
console.log(`[installer] ${relPath}`);
