/* agentnet/nat.mjs — определение достижимости: public IP probe, NAT-PMP, UPnP,
   IPv6, relay. Наружу отдаются только статус/флаги, никогда локальные адреса. */
'use strict';
import dgram from 'node:dgram';
import os from 'node:os';

export const NAT_STATUS = Object.freeze({
  PUBLIC: 'PUBLIC',
  PORT_FORWARDED: 'PORT_FORWARDED',
  IPV6_PUBLIC: 'IPV6_PUBLIC',
  RELAYED: 'RELAYED',
  OUTBOUND_ONLY: 'OUTBOUND_ONLY',
});

export function isPrivateV4(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export function isCgnatV4(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

export function isGlobalV6(ip) {
  const s = String(ip || '').toLowerCase();
  if (!s.includes(':')) return false;
  if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd') || s === '::1') return false;
  return /^[23][0-9a-f]{0,3}:/.test(s);
}

export function localAddressSummary() {
  const v4 = [];
  const v6 = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.internal) continue;
      if (a.family === 'IPv4' || a.family === 4) v4.push(a.address);
      else if (a.family === 'IPv6' || a.family === 6) v6.push(a.address);
    }
  }
  return { v4, v6, ipv6Global: v6.some(isGlobalV6) };
}

async function fetchText(url, timeoutMs) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'text/plain' } });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return /^[0-9a-fA-F:.]{3,64}$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

function udpRequest({ host, port, payload, timeoutMs }) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* noop */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on('message', (msg) => { clearTimeout(timer); finish(msg); });
    sock.on('error', () => { clearTimeout(timer); finish(null); });
    try {
      sock.send(payload, port, host, (err) => { if (err) { clearTimeout(timer); finish(null); } });
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/** NAT-PMP RFC 6886: запрос внешнего адреса (opcode 0). */
export async function natpmpPublicAddress(gateway, { timeoutMs = 1200 } = {}) {
  if (!gateway) return null;
  const res = await udpRequest({ host: gateway, port: 5351, payload: Buffer.from([0, 0]), timeoutMs });
  if (!res || res.length < 12) return null;
  if (res[1] !== 128) return null;
  const result = res.readUInt16BE(2);
  if (result !== 0) return null;
  return `${res[8]}.${res[9]}.${res[10]}.${res[11]}`;
}

/** NAT-PMP: проброс TCP-порта (opcode 1). */
export async function natpmpMapPort(gateway, port, { lifetime = 3600, timeoutMs = 1200 } = {}) {
  if (!gateway || !port) return { ok: false };
  const payload = Buffer.alloc(12);
  payload[1] = 1;
  payload.writeUInt16BE(port, 4);
  payload.writeUInt16BE(port, 6);
  payload.writeUInt32BE(lifetime, 8);
  const res = await udpRequest({ host: gateway, port: 5351, payload, timeoutMs });
  if (!res || res.length < 16 || res[1] !== 129) return { ok: false };
  if (res.readUInt16BE(2) !== 0) return { ok: false };
  return { ok: true, externalPort: res.readUInt16BE(10), lifetime: res.readUInt32BE(12), method: 'natpmp' };
}

function parseControlUrl(xml, baseUrl) {
  const serviceBlock = /<service>[\s\S]*?WANIPConnection[\s\S]*?<\/service>/i.exec(xml)
    || /<service>[\s\S]*?WANPPPConnection[\s\S]*?<\/service>/i.exec(xml);
  if (!serviceBlock) return null;
  const control = /<controlURL>([^<]+)<\/controlURL>/i.exec(serviceBlock[0]);
  if (!control) return null;
  try { return new URL(control[1].trim(), baseUrl).href; } catch { return null; }
}

async function ssdpLocations({ timeoutMs = 1200 } = {}) {
  const locations = new Set();
  const query = Buffer.from(
    'M-SEARCH * HTTP/1.1\r\n' +
    'HOST: 239.255.255.250:1900\r\n' +
    'MAN: "ssdp:discover"\r\n' +
    'MX: 1\r\n' +
    'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n'
  );
  await new Promise((resolve) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = () => { if (done) return; done = true; try { sock.close(); } catch { /* noop */ } resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    sock.on('message', (msg) => {
      const m = /LOCATION:\s*(\S+)/i.exec(msg.toString('utf8'));
      if (m) locations.add(m[1]);
    });
    sock.on('error', finish);
    sock.bind(() => {
      try {
        sock.setBroadcast(true);
        sock.send(query, 1900, '239.255.255.250');
      } catch { finish(); }
    });
  });
  return [...locations];
}

/** UPnP IGD: AddPortMapping + GetExternalIPAddress (best-effort, таймаут короткий). */
export async function upnpMapPort(port, { timeoutMs = 1500, localIp } = {}) {
  const locations = await ssdpLocations({ timeoutMs });
  for (const location of locations.slice(0, 3)) {
    try {
      const xml = await (await fetch(location, { signal: AbortSignal.timeout(timeoutMs) })).text();
      const controlUrl = parseControlUrl(xml, location);
      if (!controlUrl) continue;
      const soap = (action, inner) => `<?xml version="1.0"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">${inner}</u:${action}></s:Body></s:Envelope>`;
      const headers = {
        'content-type': 'text/xml; charset="utf-8"',
        soapaction: '"urn:schemas-upnp-org:service:WANIPConnection:1#AddPortMapping"',
      };
      const body = soap('AddPortMapping',
        `<NewRemoteHost></NewRemoteHost><NewExternalPort>${port}</NewExternalPort>` +
        `<NewProtocol>TCP</NewProtocol><NewInternalPort>${port}</NewInternalPort>` +
        `<NewInternalClient>${localIp || '127.0.0.1'}</NewInternalClient><NewEnabled>1</NewEnabled>` +
        `<NewPortMappingDescription>agentnet</NewPortMappingDescription><NewLeaseDuration>3600</NewLeaseDuration>`);
      const res = await fetch(controlUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      let externalIp = null;
      try {
        const ipBody = soap('GetExternalIPAddress', '');
        const ipRes = await fetch(controlUrl, {
          method: 'POST',
          headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: '"urn:schemas-upnp-org:service:WANIPConnection:1#GetExternalIPAddress"' },
          body: ipBody,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await ipRes.text();
        const m = /<NewExternalIPAddress>([^<]+)</i.exec(text);
        if (m) externalIp = m[1].trim();
      } catch { /* внешний IP необязателен */ }
      return { ok: true, method: 'upnp', externalIp, controlUrl };
    } catch { /* следующий кандидат */ }
  }
  return { ok: false };
}

export function gatewayFromEnvOrConfig(config = {}) {
  return config.gateway || process.env.AGT_NAT_GATEWAY || null;
}

/**
 * Итоговый статус. Порядок: IPv6 → проброс → публичный IP → relay → outbound.
 * Возвращает только флаги и внешний адрес (его публикует оператор осознанно).
 */
export async function detectReachability({
  port,
  config = {},
  log = () => {},
  fetchImpl = null,
} = {}) {
  const timeoutMs = config.timeoutMs || 1500;
  const local = localAddressSummary();
  const gateway = gatewayFromEnvOrConfig(config);
  let externalIp = null;
  let method = null;
  let mapped = false;
  const attempts = [];

  if (config.publicIpProbe) {
    const probe = fetchImpl || fetchText;
    const ip = await probe(config.publicIpProbe, timeoutMs);
    if (ip) { externalIp = ip; method = 'probe'; }
    attempts.push({ source: 'probe', ok: Boolean(ip) });
  }

  if (config.natpmp && gateway) {
    const pub = await natpmpPublicAddress(gateway, { timeoutMs });
    if (pub) { externalIp = externalIp || pub; method = method || 'natpmp'; }
    const map = await natpmpMapPort(gateway, port, { timeoutMs });
    if (map.ok) { mapped = true; method = 'natpmp'; }
    attempts.push({ source: 'natpmp', ok: Boolean(pub || map.ok), externalIp: pub || null });
  }

  if (config.upnp) {
    const upnp = await upnpMapPort(port, { timeoutMs, localIp: local.v4[0] });
    if (upnp.ok) {
      mapped = true;
      externalIp = upnp.externalIp || externalIp;
      method = method || 'upnp';
    }
    attempts.push({ source: 'upnp', ok: Boolean(upnp.ok), externalIp: upnp.externalIp || null });
  }

  const localV4 = local.v4.find((ip) => !ip.startsWith('169.254.')) || local.v4[0] || null;
  let status;
  if (local.ipv6Global) status = NAT_STATUS.IPV6_PUBLIC;
  else if (mapped) status = NAT_STATUS.PORT_FORWARDED;
  else if (externalIp && localV4 && externalIp === localV4) status = NAT_STATUS.PUBLIC;
  else if (config.relay && config.relay.enabled && config.relay.url) status = NAT_STATUS.RELAYED;
  else status = NAT_STATUS.OUTBOUND_ONLY;

  const cgnat = Boolean(localV4 && (isCgnatV4(localV4) || (isPrivateV4(localV4) && externalIp && externalIp !== localV4)));
  log(`[nat] status=${status} method=${method || 'none'} cgnat=${cgnat} mapped=${mapped}`);
  return {
    status,
    method,
    externalIp: externalIp || null,
    mapped,
    cgnat,
    ipv6: local.ipv6Global,
    localAddresses: local.v4.length + local.v6.length,
    attempts,
    checkedAt: new Date().toISOString(),
  };
}
