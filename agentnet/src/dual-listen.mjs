/* agentnet/dual-listen.mjs — P2P-сокет на всех интерфейсах сразу.
   Wildcard-адрес означает два слушателя на одном порту: IPv4 0.0.0.0 и
   IPv6-only [::]. Так входящие работают и из IPv4-интернета, и из IPv6,
   а netstat показывает оба адреса. Один сокет с dual-stack (host '::')
   тоже принимает IPv4, но слушателя 0.0.0.0 в списке тогда нет, а часть
   провайдеров и firewall-правил смотрит именно на семейство адреса. */
'use strict';
import net from 'node:net';

function makeServer(onConnection, maxConnections) {
  const server = net.createServer((socket) => onConnection(socket));
  server.maxConnections = maxConnections;
  return server;
}

function listen(server, options) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(options);
  });
}

function close(server) {
  return new Promise((resolve) => {
    try { server.close(() => resolve()); } catch { resolve(); }
  });
}

export function isWildcard(host) {
  return !host || host === '*' || host === '0.0.0.0' || host === '::';
}

/**
 * Слушает port на всех интерфейсах.
 * @returns {{servers: net.Server[], port: number, endpoints: {host: string, family: string, port: number}[], ipv6: null|string}}
 */
export async function listenDualStack({
  host = '0.0.0.0', port = 0, onConnection, maxConnections = 64,
} = {}) {
  if (!isWildcard(host)) {
    const server = makeServer(onConnection, maxConnections);
    await listen(server, { port, host });
    const actual = server.address().port;
    return {
      servers: [server],
      port: actual,
      endpoints: [{ host, family: net.isIP(host) === 6 ? 'ipv6' : 'ipv4', port: actual }],
      ipv6: null,
    };
  }

  const v4 = makeServer(onConnection, maxConnections);
  await listen(v4, { port, host: '0.0.0.0' });
  const actual = v4.address().port;
  const servers = [v4];
  const endpoints = [{ host: '0.0.0.0', family: 'ipv4', port: actual }];
  let ipv6 = null;
  let ipv6Error = null;

  // Второй слушатель строго IPv6-only: иначе он конфликтует с v4 на том же порту.
  const v6 = makeServer(onConnection, maxConnections);
  try {
    await listen(v6, { port: actual, host: '::', ipv6Only: true });
    servers.push(v6);
    endpoints.push({ host: '::', family: 'ipv6', port: actual });
    ipv6 = `[::]:${actual}`;
  } catch (e) {
    ipv6Error = e.code || e.message;
    try { v6.close(); } catch { /* не открылся */ }
  }

  return { servers, port: actual, endpoints, ipv6, ipv6Error };
}

export async function closeServers(servers) {
  await Promise.all((servers || []).map(close));
}
