/* agentnet/landiscovery.mjs — знакомство нод в локальной сети UDP-маячками.
   Это не замена P2P: маячок только сообщает host:port, дальше ноды соединяются
   своим обычным TCP-протоколом с рукопожатием и шифрованием. */
'use strict';
import dgram from 'node:dgram';
import os from 'node:os';

export const LAN_DISCOVERY_PORT = 9337;
const BEACON_KIND = 'agentnet-lan';

export function localIPv4() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.internal) continue;
      if (a.family === 'IPv4' || a.family === 4) out.push({ address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

function broadcastAddresses() {
  const set = new Set(['255.255.255.255']);
  for (const { address, netmask } of localIPv4()) {
    const ip = address.split('.').map(Number);
    const mask = String(netmask || '').split('.').map(Number);
    if (ip.length !== 4 || mask.length !== 4 || mask.some((n) => !Number.isFinite(n))) continue;
    set.add(ip.map((n, i) => ((n & mask[i]) | (~mask[i] & 255)) & 255).join('.'));
  }
  return [...set];
}

export class LanDiscovery {
  constructor({
    networkId, nodeId, port,
    servicePort = LAN_DISCOVERY_PORT,
    intervalMs = 5000,
    onPeer = () => {},
    log = () => {},
  }) {
    this.networkId = networkId;
    this.nodeId = nodeId;
    this.port = port;
    this.servicePort = servicePort;
    this.intervalMs = intervalMs;
    this.onPeer = onPeer;
    this.log = log;
    this.sock = null;
    this.timer = null;
    this.found = new Set();
  }

  async start() {
    if (this.sock) return this;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.sock = sock;
    sock.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
    sock.on('error', (e) => this.log(`[lan] ${e.code || e.message}`));
    const bound = await new Promise((resolve) => {
      const onError = (e) => {
        this.log(`[lan] обнаружение выключено: ${e.code || e.message}`);
        try { sock.close(); } catch { /* noop */ }
        this.sock = null;
        resolve(false);
      };
      sock.once('error', onError);
      sock.bind(this.servicePort, '0.0.0.0', () => {
        sock.off('error', onError);
        resolve(true);
      });
    });
    if (!bound) return this;
    try { sock.setBroadcast(true); } catch { /* не все платформы разрешают */ }
    this.timer = setInterval(() => this._announce(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    this._announce();
    this.log(`[lan] обнаружение: UDP ${this.servicePort}, маячок каждые ${Math.round(this.intervalMs / 1000)} с`);
    return this;
  }

  _announce() {
    if (!this.sock) return;
    const payload = Buffer.from(JSON.stringify({
      kind: BEACON_KIND,
      v: 1,
      networkId: this.networkId,
      nodeId: this.nodeId,
      port: this.port,
    }));
    for (const addr of broadcastAddresses()) {
      try {
        this.sock.send(payload, this.servicePort, addr, () => {});
      } catch { /* сеть могла пропасть */ }
    }
  }

  _onMessage(buf, rinfo) {
    if (!buf || buf.length > 512) return;
    let m;
    try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (!m || m.kind !== BEACON_KIND || m.v !== 1) return;
    if (m.networkId !== this.networkId) return;
    if (!m.nodeId || m.nodeId === this.nodeId) return;
    const port = Number(m.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    const key = `${m.nodeId}@${rinfo.address}:${port}`;
    if (this.found.has(key)) return;
    this.found.add(key);
    if (this.found.size > 256) this.found.clear();
    this.onPeer({ host: rinfo.address, port, nodeId: m.nodeId });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.sock) {
      try { this.sock.close(); } catch { /* уже закрыт */ }
      this.sock = null;
    }
  }
}
