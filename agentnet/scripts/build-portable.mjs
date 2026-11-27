#!/usr/bin/env node
/* build-portable.mjs — собирает одноклик-пакеты agentnet на боевом снимке цепи.
   Требует уже скачанные node.exe / node (macOS arm64) из dist/portable проекта. */
'use strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const AGENTCOIN = path.dirname(ROOT);
const VERSION = process.env.AGENTNET_VERSION || '0.2.0';
const SNAPSHOT = process.env.AGENTNET_PROD_CHAIN || path.join(AGENTCOIN, 'bundle-build/portable/cache/chain.json');
const OUT = path.join(ROOT, 'dist');
const WIN_NODE = path.join(AGENTCOIN, 'dist/portable/agentcoin-portable-0.1.0-win-x64/node.exe');
const MAC_NODE = path.join(AGENTCOIN, 'dist/portable/agentcoin-portable-0.1.0-macos-arm64/node');
// Linux-runtime: dist/portable/node-linux-x64-v24.22.2/node (официальный nodejs.org, та же ветка v24).
const LINUX_NODE = path.join(AGENTCOIN, 'dist/portable/node-linux-x64-v24.22.2/node');

if (!fs.existsSync(SNAPSHOT)) throw new Error(`snapshot not found: ${SNAPSHOT}`);
for (const f of [WIN_NODE, MAC_NODE, LINUX_NODE]) if (!fs.existsSync(f)) throw new Error(`node runtime not found: ${f}`);

function sha256File(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

const chainDoc = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
const chain = chainDoc.chain || [];
const tip = chain[chain.length - 1];
const chainSha = sha256File(SNAPSHOT);
fs.mkdirSync(OUT, { recursive: true });

const README = `Agentcoin agentnet — portable node (${VERSION})
================================================

Что это
  Настоящая нода agentnet на РЕАЛЬНОЙ цепи Agentcoin: боевой genesis
  ${chain[0].hash.slice(0, 16)}…, ${chain.length} блоков, tip ${tip.hash.slice(0, 16)}…
  Снимок цепи встроен (chain.json), checkpoint = ${tip.height}. При первом
  запуске нода создаёт СВОЙ ed25519-ключ и становится отдельным участником сети.

Запуск
  Windows: двойной клик по start.cmd
  macOS:   двойной клик по start.command
           (если Gatekeeper блокирует: правый клик -> Open;
            либо в Terminal: xattr -dr com.apple.quarantine "<папка пакета>")
  Linux:   ./start.sh (или: node app/launcher.mjs — если Node.js уже стоит)

Сеть
  P2P:      0.0.0.0:19444/TCP и [::]:19444/TCP — входящие пиры, IPv4 и IPv6
  LAN-поиск: UDP 9337 — ноды в одной локальной сети находят друг друга сами
  Шлюз:     http://127.0.0.1:9334/info — только чтение, только с этого компьютера
  GUI:      http://127.0.0.1:9333/gui — пульт этой ноды, только с этого компьютера

  Пульт (GUI) и шлюз наружу не выставляются: снаружи открыт только P2P.

  Пиры: положите адреса в peers.txt (host:port, по одному на строку),
  либо запустите:  node app/launcher.mjs --peer=host:port
  Ноды обмениваются пирами (PEX) и сохраняют их в data/peers.

  Порты можно менять: --p2p=PORT --api=PORT --gateway-port=PORT --listen=HOST
  Разрешите приложению node.exe в брандмауэре (частные сети), иначе входящие
  соединения и LAN-поиск будут заблокированы. Для входящих из интернета нужен
  проброс TCP 19444 на роутере (или UPnP/NAT-PMP, нода пробует их сама).

Первый запуск
  Пакет разворачивает снимок в data/ (53 709 заголовков и тел), это ~10–30 секунд.
  Повторные запуски используют data/ и проверяют, что tip совпадает с пакетом.

Что проверяется
  - все заголовки: SHA256d, PoW, prevHash, боевой ретаргет каждые 10 блоков,
    chainId AGENTCOIN, боевой genesis;
  - checkpoint ${tip.height}: хеш закреплён, подмена отклоняется;
  - тела до checkpoint: целостность и merkle (кроме исторических высот 2 и 3,
    где сама боевая цепь не совпадает с текущей core.merkleRoot);
  - каждый новый блок после checkpoint: полный validateBlockAgainstChain
    из packaging/node/src/core.mjs (подписи, merkle, coinbase, сложность).

Приватность
  Нода публикует пирам только публичный endpoint, и только если NAT дал внешний
  адрес. LAN-адреса и ключи не публикуются. Отключить объявление endpoint:
  --no-publish. Отключить NAT-попытки: --no-nat.

Честно
  В пакете нет публичного seed: сеть образуют ноды, которые вы указали в
  peers.txt/--peer, плюс соседи в локальной сети. Моста к WebSocket-P2P
  agentcoin.work нет — agentnet использует свой TCP-протокол. Старые подписи
  (143 tx в первых 3000 блоках) текущими правилами не перепроверяются: снимок
  до checkpoint считается доверенным, как и в обычном bootstrap. Никаких
  ключей и данных пользователя в пакете нет; ключ создаётся при первом запуске.

Данные
  data/ — цепь, ключ ноды, пиры. Удалите каталог, чтобы развернуть снимок заново
  (ключ и история пиров при этом тоже удалятся).

SHA256
  ${chainSha}  chain.json
  Контрольные суммы архивов: SHA256SUMS.agentnet рядом с архивами.
`;

function writeStartFiles(dir, platform) {
  if (platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'start.cmd'), [
      '@echo off',
      'setlocal enableextensions',
      'cd /d "%~dp0"',
      'if not exist "node.exe" (echo [FAIL] node.exe missing & pause & exit /b 66)',
      'if not exist "app\\launcher.mjs" (echo [FAIL] app\\launcher.mjs missing & pause & exit /b 66)',
      'echo == Agentcoin agentnet | P2P 0.0.0.0:19444 + [::]:19444 | LAN udp 9337',
      'echo == GUI http://127.0.0.1:9333/gui (loopback) | gateway 127.0.0.1:9334 | peers: edit peers.txt',
      'echo == stop: Ctrl+C',
      '"node.exe" "app\\launcher.mjs" %*',
      'set "RC=%ERRORLEVEL%"',
      'echo == stopped (exit %RC%)',
      'pause',
      'exit /b %RC%',
      '',
    ].join('\r\n'));
  } else if (platform === 'darwin') {
    const f = path.join(dir, 'start.command');
    fs.writeFileSync(f, [
      '#!/bin/sh',
      'cd "$(dirname "$0")" || exit 1',
      '[ -x ./node ] || chmod +x ./node',
      '[ -x ./app/launcher.mjs ] || true',
      'echo "== Agentcoin agentnet | P2P 0.0.0.0:19444 + [::]:19444 | LAN udp 9337"',
      'echo "== GUI http://127.0.0.1:9333/gui (loopback) | gateway 127.0.0.1:9334 | peers: edit peers.txt"',
      'exec ./node app/launcher.mjs "$@"',
      '',
    ].join('\n'));
    fs.chmodSync(f, 0o755);
  } else {
    // linux: start.sh — тот же лаунчер, плюс проверка glibc через ./node --version.
    const f = path.join(dir, 'start.sh');
    fs.writeFileSync(f, [
      '#!/bin/sh',
      'cd "$(dirname "$0")" || exit 1',
      '[ -x ./node ] || chmod +x ./node',
      'if [ ! -x ./node ]; then echo "[FAIL] node runtime missing" >&2; exit 66; fi',
      'if [ ! -f ./app/launcher.mjs ]; then echo "[FAIL] app/launcher.mjs missing" >&2; exit 66; fi',
      'echo "== Agentcoin agentnet | P2P 0.0.0.0:19444 + [::]:19444 | LAN udp 9337"',
      'echo "== GUI http://127.0.0.1:9333/gui (loopback) | gateway 127.0.0.1:9334 | peers: edit peers.txt"',
      'echo "== stop: Ctrl+C"',
      'exec ./node app/launcher.mjs "$@"',
      '',
    ].join('\n'));
    fs.chmodSync(f, 0o755);
  }
}

function copyCommon(dir) {
  const app = path.join(dir, 'app');
  fs.mkdirSync(path.join(app, 'vendor'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'src'), path.join(app, 'src'), { recursive: true });
  fs.copyFileSync(path.join(AGENTCOIN, 'packaging/node/src/core.mjs'), path.join(app, 'vendor', 'core.mjs'));
  fs.copyFileSync(path.join(AGENTCOIN, 'packaging/node/src/vclock.mjs'), path.join(app, 'vendor', 'vclock.mjs'));
  fs.copyFileSync(path.join(ROOT, 'scripts/portable-launcher.mjs'), path.join(app, 'launcher.mjs'));
  fs.copyFileSync(path.join(ROOT, 'scripts/guard-main.mjs'), path.join(app, 'guard.mjs'));
  fs.copyFileSync(SNAPSHOT, path.join(dir, 'chain.json'));
  fs.writeFileSync(path.join(dir, 'peers.txt'), [
    '# agentnet peers — по одному host:port на строку.',
    '# Ноды в одной локальной сети находят друг друга сами (UDP 9337).',
    '# Чтобы подключиться к известной ноде, добавьте, например:',
    '# 203.0.113.10:19444',
    '# Строки с # игнорируются.',
    '',
  ].join('\r\n'));
  fs.writeFileSync(path.join(dir, 'README.txt'), README.replace(/\n/g, '\r\n'));
}

function hashes(dir) {
  const out = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out.push(`${sha256File(p)}  ${path.relative(dir, p).split(path.sep).join('/')}`);
    }
  };
  walk(dir);
  return out.sort();
}

// AGENTNET_TARGETS=linux-x64 — собрать только перечисленные цели (через запятую),
// чтобы не пересобирать остальные архивы.
const ONLY_TARGETS = String(process.env.AGENTNET_TARGETS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ALL_TARGETS = [
  { id: 'win-x64', platform: 'win32', node: WIN_NODE, binary: 'node.exe', entry: 'start.cmd' },
  { id: 'macos-arm64', platform: 'darwin', node: MAC_NODE, binary: 'node', entry: 'start.command' },
  { id: 'linux-x64', platform: 'linux', node: LINUX_NODE, binary: 'node', entry: 'start.sh' },
];
const built = [];
for (const target of ALL_TARGETS.filter((t) => !ONLY_TARGETS.length || ONLY_TARGETS.includes(t.id))) {
  const folder = `agentnet-${VERSION}-${target.id}`;
  const dir = path.join(OUT, folder);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  copyCommon(dir);
  fs.copyFileSync(target.node, path.join(dir, target.binary));
  if (target.platform !== 'win32') fs.chmodSync(path.join(dir, target.binary), 0o755);
  writeStartFiles(dir, target.platform);
  fs.writeFileSync(path.join(dir, 'RELEASE.json'), JSON.stringify({
    schema: 'agentnet/release@1',
    version: VERSION,
    platform: target.id,
    entry: target.entry,
    chainId: chainDoc.chainId,
    snapshot: { height: tip.height, tip: tip.hash, genesis: chain[0].hash, sha256: chainSha },
    checkpoint: { height: tip.height, hash: tip.hash },
    network: {
      p2p: { host: '0.0.0.0', port: 19444, ipv6: '[::]:19444', protocol: 'tcp' },
      lanDiscovery: { host: '0.0.0.0', port: 9337, protocol: 'udp' },
      gateway: { host: '127.0.0.1', port: 9334, mode: 'read-only' },
      api: { host: '127.0.0.1', port: 9333 },
      peersFile: 'peers.txt',
    },
    ports: { api: 9333, p2p: 19444, gateway: 9334, lanDiscovery: 9337 },
    builtAt: new Date().toISOString(),
  }, null, 2));
  const sums = hashes(dir);
  fs.writeFileSync(path.join(dir, 'SHA256SUMS'), sums.join('\n') + '\n');

  const archive = target.platform === 'win32'
    ? path.join(OUT, `${folder}.zip`)
    : path.join(OUT, `${folder}.tar.gz`);
  fs.rmSync(archive, { force: true });
  if (target.platform === 'win32') {
    // Compress-Archive пишет обратные слэши; .NET ZipFile — стандартные '/'.
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${dir}','${archive}',[System.IO.Compression.CompressionLevel]::Optimal,$true)`],
    { stdio: 'inherit' });
  } else {
    execFileSync('tar', ['-czf', path.basename(archive), folder], { cwd: OUT, stdio: 'inherit' });
  }
  const archiveSha = sha256File(archive);
  fs.writeFileSync(`${archive}.sha256`, `${archiveSha}  ${path.basename(archive)}\n`);
  built.push({ archive: path.basename(archive), sha256: archiveSha, bytes: fs.statSync(archive).size });
  console.log(`[build] ${path.basename(archive)}  ${(fs.statSync(archive).size / 1048576).toFixed(1)} MiB  sha256=${archiveSha}`);
}

// Манифесты дополняем, а не перезаписываем: при частичной сборке (AGENTNET_TARGETS)
// записи остальных архивов сохраняются.
const prevSums = new Map();
try {
  for (const line of fs.readFileSync(path.join(OUT, 'SHA256SUMS.agentnet'), 'utf8').split('\n')) {
    const m = line.match(/^([0-9a-f]{64})\s+(.+)$/);
    if (m) prevSums.set(m[2], m[1]);
  }
} catch { /* первого запуска ещё не было */ }
for (const b of built) prevSums.set(b.archive, b.sha256);
fs.writeFileSync(path.join(OUT, 'SHA256SUMS.agentnet'),
  [...prevSums.entries()].map(([a, s]) => `${s}  ${a}`).sort((x, y) => x.localeCompare(y)).join('\n') + '\n');
let prevReleases = null;
try { prevReleases = JSON.parse(fs.readFileSync(path.join(OUT, 'RELEASES.json'), 'utf8')); } catch { /* noop */ }
const prevArchives = new Map(
  (prevReleases && Array.isArray(prevReleases.archives) ? prevReleases.archives : [])
    .filter((a) => a && typeof a.archive === 'string')
    .map((a) => [a.archive, a]));
for (const b of built) prevArchives.set(b.archive, b);
fs.writeFileSync(path.join(OUT, 'RELEASES.json'), JSON.stringify({
  version: VERSION, snapshot: { height: tip.height, tip: tip.hash, genesis: chain[0].hash, sha256: chainSha },
  archives: [...prevArchives.values()].sort((a, b) => String(a.archive).localeCompare(String(b.archive))),
  builtAt: new Date().toISOString(),
}, null, 2));
console.log('[build] готово:', built.map((b) => b.archive).join(', '));
