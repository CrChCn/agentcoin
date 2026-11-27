#!/usr/bin/env node
/* portable-launcher.mjs — нода agentnet на боевом снимке цепи Agentcoin.
   Копируется в пакет как app/launcher.mjs и запускается как из папки (start.cmd),
   так и службой Windows (AgentcoinNode → AgentcoinServiceHost.exe → этот файл).

   Разделение портов:
     P2P      0.0.0.0:19444 + [::]:19444 — публичный, входящие пиры
     GUI/API  127.0.0.1:9333             — пульт ноды, только с этого компьютера
     Шлюз     127.0.0.1:9334             — read-only GET /info, /announce
     LAN      UDP 9337                   — обнаружение соседей

     --check                 заполнить/проверить цепь и выйти (без сервера)
     --data=DIR              каталог данных (по умолчанию ./data рядом с пакетом)
     --p2p=PORT              P2P-порт (по умолчанию 19444, 0 = свободный)
     --listen=HOST           адрес P2P (0.0.0.0 = все интерфейсы, IPv4+IPv6)
     --api=PORT              локальный API/GUI (по умолчанию 9333)
     --api-host=HOST         адрес API/GUI (по умолчанию 127.0.0.1; наружу не выставлять)
     --gateway-port=PORT     read-only шлюз (по умолчанию 9334, 0 = выключить)
     --gateway-host=HOST     адрес шлюза (по умолчанию 127.0.0.1)
     --no-gateway            не поднимать шлюз
     --peer=host:port        seed-нода (можно несколько; также peers.txt)
     --dns-seed=host         DNS-имя с TXT/SRV _agentnet._tcp.<host>
     --no-lan                не искать соседей UDP-маячками
     --no-nat                не пробовать NAT-PMP/UPnP
     --no-publish            не объявлять внешний endpoint (приватность)
     --no-open               не открывать браузер
     --service               режим службы: без браузера, журнал в файл
     --log-file=FILE         файл журнала (в режиме службы включается сам)
*/
'use strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from './vendor/core.mjs';
import { AgentcoinNode } from './src/node.mjs';
import { LanDiscovery, localIPv4, LAN_DISCOVERY_PORT } from './src/landiscovery.mjs';
import { isCgnatV4, isPrivateV4 } from './src/nat.mjs';
import {
  createProductionAdapter, loadProductionSnapshot, openProductionChain, seedProductionChain,
} from './src/production.mjs';

const APP = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(APP);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const list = (name) => args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3)).filter(Boolean);

const checkOnly = flag('--check') || flag('--seed-only');
const serviceMode = flag('--service') || process.env.AGENTNET_SERVICE === '1';
const noOpen = flag('--no-open') || serviceMode || process.env.AGENTNET_NO_OPEN === '1';
const noLan = flag('--no-lan') || process.env.AGENTNET_LAN === '0';
const noNat = flag('--no-nat') || process.env.AGENTNET_NAT === '0';
const noPublish = flag('--no-publish') || process.env.AGENTNET_PUBLISH_ENDPOINT === '0';
const noGateway = flag('--no-gateway') || process.env.AGENTNET_GATEWAY === '0';

const apiPort = Number(opt('api', process.env.AGENTNET_API_PORT || 9333));
const p2pPort = Number(opt('p2p', process.env.AGENTNET_P2P_PORT || 19444));
const listenHost = opt('listen', process.env.AGENTNET_LISTEN_HOST || '0.0.0.0');
const apiHost = opt('api-host', process.env.AGENTNET_API_HOST || '127.0.0.1');
const gatewayPort = Number(opt('gateway-port', process.env.AGENTNET_GATEWAY_PORT || 9334));
const gatewayHost = opt('gateway-host', process.env.AGENTNET_GATEWAY_HOST || '127.0.0.1');
const dataDir = path.resolve(opt('data', process.env.AGENTNET_DATA_DIR || path.join(ROOT, 'data')));
const chainFile = path.join(ROOT, 'chain.json');

// ------------------------------------------------------------------ журнал
let logStream = null;
function openLog(file) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 16 * 1024 * 1024) {
      try { fs.renameSync(file, `${file}.1`); } catch { /* не критично */ }
    }
    logStream = fs.createWriteStream(file, { flags: 'a' });
  } catch (e) {
    console.error(`[agentnet] журнал недоступен: ${e.message}`);
  }
}
function say(line) {
  console.log(line);
  if (!logStream) return;
  try { logStream.write(`${new Date().toISOString()} ${line}\n`); } catch { /* журнал не критичен */ }
}

function readPeerList(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean)
      .flatMap((line) => line.split(/[\s,]+/))
      .filter(Boolean);
  } catch {
    return [];
  }
}

const peersFiles = [path.join(ROOT, 'peers.txt'), path.join(dataDir, 'peers.txt')];
const peerCandidates = [
  ...list('peer'), ...list('seed'),
  ...list('peers').flatMap((v) => v.split(/[\s,]+/)),
  ...String(process.env.AGENTNET_PEERS || '').split(/[\s,]+/),
  ...peersFiles.flatMap(readPeerList),
].map((s) => s.trim()).filter(Boolean);
const staticSeeds = [...new Set(peerCandidates)];
const dnsSeeds = [...new Set([
  ...list('dns-seed'),
  ...String(process.env.AGENTNET_DNS_SEEDS || '').split(/[\s,]+/),
].map((s) => s.trim()).filter(Boolean))];

const logFile = opt('log-file', process.env.AGENTNET_LOG_FILE
  || (serviceMode ? path.join(dataDir, 'logs', 'node.log') : ''));
openLog(logFile);

if (!fs.existsSync(chainFile)) {
  say(`[agentnet] нет снимка цепи: ${chainFile}`);
  process.exit(66);
}

const snapshot = loadProductionSnapshot(chainFile, core);
const adapter = createProductionAdapter(core, { checkpoint: snapshot.checkpoint });
const fresh = !fs.existsSync(path.join(dataDir, 'chain', 'headers.ndjson'));

let chain;
if (fresh) {
  say(`[agentnet] первый запуск: разворачиваю снимок ${snapshot.tip.height + 1} блоков в ${dataDir}…`);
  chain = seedProductionChain({
    dataDir, snapshot, core, adapter,
    log: (line) => say(line),
  });
} else {
  chain = openProductionChain({ dataDir, core, adapter, genesisHeader: snapshot.genesisHeader });
  if (chain.height !== snapshot.tip.height || chain.tip.hash !== snapshot.tip.hash) {
    say('[agentnet] локальная цепь не совпадает со снимком пакета.');
    say(`  локально: ${chain.height} ${chain.tip.hash}`);
    say(`  в пакете: ${snapshot.tip.height} ${snapshot.tip.hash}`);
    say('  удалите каталог data и запустите снова (или обновите пакет).');
    process.exit(65);
  }
  if (!chain.bodies.has(0)) chain.addBlock(snapshot.doc.chain[0], { verify: false });
}

say(`[agentnet] цепь: ${chain.height + 1} заголовков, ${chain.bodies.size} тел, genesis ${chain.genesisHash}`);
say(`[agentnet] checkpoint: ${snapshot.checkpoint.height} ${snapshot.checkpoint.hash}`);
say(`[agentnet] данные: ${dataDir}`);
if (logFile) say(`[agentnet] журнал: ${logFile}`);

if (checkOnly) {
  console.log(JSON.stringify({
    ok: true, chainId: core.networkChainId(), height: chain.height, tip: chain.tip.hash,
    genesis: chain.genesisHash, bodies: chain.bodies.size, checkpoint: snapshot.checkpoint,
    adapter: adapter.stats, dataDir,
  }, null, 2));
  process.exit(0);
}

const node = new AgentcoinNode({
  dataDir,
  chain,
  config: {
    networkId: core.networkChainId(),
    listen: { host: listenHost, port: p2pPort },
    api: { host: apiHost, port: apiPort },
    nat: {
      enabled: !noNat,
      upnp: true,
      natpmp: true,
      gateway: process.env.AGT_NAT_GATEWAY || null,
      timeoutMs: 1500,
    },
    privacy: { publishEndpoint: !noPublish, region: process.env.AGENTNET_REGION || null },
    discovery: {
      staticSeeds,
      dnsSeeds,
      minPeers: 1,
      maxPeers: 32,
      intervalMs: 5000,
    },
    sync: { fetchBodies: true, intervalMs: 1000, headersPerBatch: 500, blocksPerBatch: 200 },
  },
  log: (line) => say(line),
});

// Внешний endpoint объявляется только если NAT дал публичный адрес и это не
// приватная/CGNAT-зона. Иначе нода остаётся исходящей и ждёт входящих.
node.on('nat', (nat) => {
  if (noPublish || !nat) return;
  const ip = String(nat.externalIp || '');
  const v4 = net.isIP(ip) === 4;
  const v6 = net.isIP(ip) === 6;
  const usable = (v4 && !isPrivateV4(ip) && !isCgnatV4(ip) && ip !== '0.0.0.0')
    || (v6 && /^[23]/.test(ip));
  if (nat.mapped && usable) {
    node.config.publicEndpoint = { host: ip, port: node.listenPort };
    node.config.privacy.publishEndpoint = true;
    say(`[agentnet] внешний endpoint: ${ip}:${node.listenPort} (${nat.method || nat.status}) — объявлен пирам`);
    node.broadcastAnnouncement();
  } else {
    say(`[agentnet] NAT: ${nat.status}${nat.mapped ? ' (порт проброшен)' : ''}; внешний адрес не объявлен`);
  }
});

await node.start();

const lan = localIPv4().map((a) => a.address);
say(`[agentnet] нода ${node.id}`);
for (const ep of node.listenEndpoints) {
  say(`[agentnet] P2P слушает ${ep.host}:${ep.port} (${ep.family})`);
}
for (const ip of lan) say(`[agentnet] P2P из локальной сети: ${ip}:${node.listenPort}`);
say(`[agentnet] seed-нод: ${staticSeeds.length ? staticSeeds.join(', ') : 'нет (поиск через peers.txt/LAN/DNS)'}`);
say(`[agentnet] GUI: http://127.0.0.1:${node.apiPort}/gui`);
if (apiHost !== '127.0.0.1' && apiHost !== 'localhost') {
  say(`[agentnet] ВНИМАНИЕ: API/GUI без пароля доступен на ${apiHost}:${node.apiPort} — это пульт управления нодой`);
}

function statusLine() {
  const s = node.snapshot();
  return `[agentnet] пиры: входящих ${s.inboundPeers}, исходящих ${s.outboundPeers}, `
    + `всего ${s.peers.total}; publicReachable=${s.publicReachable}; NAT ${s.nat.status}`;
}

let gateway = null;
if (!noGateway && gatewayPort > 0) {
  gateway = await startGateway({ host: gatewayHost, port: gatewayPort, apiPort: node.apiPort });
  if (gateway) {
    say(`[agentnet] шлюз (read-only): http://${gatewayHost}:${gateway.address().port}/info`);
    say('[agentnet] шлюз отдаёт только GET /info и /announce, без управления нодой');
  }
}

if (!noLan) {
  const dialing = new Set();
  const lanDiscovery = new LanDiscovery({
    networkId: node.networkId,
    nodeId: node.id,
    port: node.listenPort,
    servicePort: LAN_DISCOVERY_PORT,
    intervalMs: 5000,
    log: (line) => say(line),
    onPeer: (peer) => {
      const known = new Set([...node.sessions.values()].map((s) => s.nodeId));
      if (known.has(peer.nodeId)) return;
      const key = `${peer.host}:${peer.port}`;
      if (dialing.has(key)) return;
      dialing.add(key);
      say(`[lan] сосед ${peer.nodeId.slice(0, 12)} на ${key} — соединяюсь`);
      node.connect(peer, { source: 'lan' })
        .then((r) => { if (!r.ok && r.reason !== 'self') say(`[lan] ${key}: ${r.reason}`); })
        .catch(() => {})
        .finally(() => setTimeout(() => dialing.delete(key), 10000));
    },
  });
  await lanDiscovery.start();
  node.once('stopped', () => lanDiscovery.stop());
}

say(statusLine());
const statusTimer = setInterval(() => say(statusLine()), 60000);
if (statusTimer.unref) statusTimer.unref();

if (serviceMode) {
  // Ответ на /health нужен сторожу и установщику; журнал уже пишется в файл.
  say('[agentnet] режим службы: браузер не открывается, остановка — через SCM (sc stop AgentcoinNode)');
} else {
  say('[agentnet] остановка: Ctrl+C');
}

if (!noOpen) {
  try {
    const gui = `http://127.0.0.1:${node.apiPort}/gui`;
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', gui], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [gui], { detached: true, stdio: 'ignore' }).unref();
  } catch { /* браузер не обязателен */ }
}

function startGateway({ host, port, apiPort: upstreamPort }) {
  const allowed = new Set(['/info', '/announce']);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://gateway');
    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    };
    if (req.method !== 'GET' || !allowed.has(url.pathname)) {
      res.writeHead(405, headers);
      return res.end(JSON.stringify({
        error: 'read_only_gateway',
        allow: [...allowed],
        node: url.pathname === '/' ? { info: '/info', announce: '/announce' } : undefined,
      }));
    }
    const upstream = http.request({
      host: '127.0.0.1', port: upstreamPort, path: url.pathname, method: 'GET', timeout: 5000,
      headers: { accept: 'application/json' },
    }, (up) => {
      res.writeHead(up.statusCode || 502, {
        'content-type': up.headers['content-type'] || headers['content-type'],
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      up.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream_timeout')));
    upstream.on('error', (e) => {
      if (res.headersSent) return res.end();
      res.writeHead(502, headers);
      res.end(JSON.stringify({ error: 'upstream', message: e.message }));
    });
    upstream.end();
  });
  return new Promise((resolve) => {
    server.once('error', (e) => {
      say(`[agentnet] шлюз не запущен: ${e.code || e.message}`);
      resolve(null);
    });
    server.listen(port, host, () => resolve(server));
  });
}

const shutdown = async () => {
  clearInterval(statusTimer);
  try { gateway?.close(); } catch { /* уже закрыт */ }
  try { await node.stop('portable_shutdown'); } catch { /* уже остановлена */ }
  if (logStream) { try { logStream.end(); } catch { /* noop */ } }
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
