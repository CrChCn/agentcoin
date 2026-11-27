'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import {
  detectReachability, natpmpPublicAddress, natpmpMapPort, localAddressSummary, NAT_STATUS,
} from '../src/nat.mjs';

function startFakeNatpmp() {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.on('error', (e) => reject(e));
    sock.on('message', (msg, rinfo) => {
      if (!msg || msg.length < 2) return;
      if (msg[1] === 0) {
        const res = Buffer.from([0, 128, 0, 0, 0, 0, 0, 1, 203, 0, 113, 7]);
        sock.send(res, rinfo.port, rinfo.address);
      } else if (msg[1] === 1) {
        const internal = msg.readUInt16BE(4);
        const res = Buffer.alloc(16);
        res[1] = 129;
        res.writeUInt16BE(0, 2);
        res.writeUInt32BE(1, 4);
        res.writeUInt16BE(internal, 8);
        res.writeUInt16BE(internal, 10);
        res.writeUInt32BE(3600, 12);
        sock.send(res, rinfo.port, rinfo.address);
      }
    });
    sock.bind(5351, '127.0.0.1', () => resolve(sock));
  });
}

test('nat: NAT-PMP запрос адреса и проброс порта (реальный UDP-обмен)', async (t) => {
  let fake;
  try {
    fake = await startFakeNatpmp();
  } catch (e) {
    t.skip(`порт 5351 занят: ${e.code || e.message}`);
    return;
  }
  try {
    const ip = await natpmpPublicAddress('127.0.0.1', { timeoutMs: 1000 });
    assert.equal(ip, '203.0.113.7');
    const map = await natpmpMapPort('127.0.0.1', 9336, { timeoutMs: 1000 });
    assert.equal(map.ok, true);
    assert.equal(map.externalPort, 9336);
    assert.equal(map.method, 'natpmp');

    const reach = await detectReachability({
      port: 9336,
      config: { natpmp: true, gateway: '127.0.0.1', upnp: false, timeoutMs: 800, publicIpProbe: '' },
      log: () => {},
    });
    assert.equal(reach.status, NAT_STATUS.PORT_FORWARDED);
    assert.equal(reach.mapped, true);
    assert.equal(reach.externalIp, '203.0.113.7');
    assert.equal(typeof reach.localAddresses, 'number', 'наружу только счётчик, не адреса');
    assert.ok(!JSON.stringify(reach).includes('127.0.0.1'));
  } finally {
    fake.close();
  }
});

test('nat: статусы PUBLIC / OUTBOUND_ONLY / RELAYED выводятся из проверок', async () => {
  const local = localAddressSummary();
  const localV4 = local.v4.find((ip) => !ip.startsWith('169.254.')) || local.v4[0] || null;
  const base = { natpmp: false, upnp: false, timeoutMs: 200, publicIpProbe: 'probe' };

  if (localV4) {
    const pub = await detectReachability({
      port: 9336,
      config: { ...base },
      log: () => {},
      fetchImpl: async () => localV4,
    });
    assert.equal(pub.status, local.ipv6Global ? NAT_STATUS.IPV6_PUBLIC : NAT_STATUS.PUBLIC);
    assert.equal(pub.externalIp, localV4);
  }

  const outbound = await detectReachability({
    port: 9336,
    config: { ...base },
    log: () => {},
    fetchImpl: async () => '203.0.113.9',
  });
  assert.equal(outbound.status, local.ipv6Global ? NAT_STATUS.IPV6_PUBLIC : NAT_STATUS.OUTBOUND_ONLY);
  assert.equal(outbound.mapped, false);

  const relayed = await detectReachability({
    port: 9336,
    config: { ...base, relay: { enabled: true, url: 'wss://relay.example/ws' } },
    log: () => {},
    fetchImpl: async () => '203.0.113.9',
  });
  assert.equal(relayed.status, local.ipv6Global ? NAT_STATUS.IPV6_PUBLIC : NAT_STATUS.RELAYED);
});

test('nat: публичный endpoint не выводится из приватного', async () => {
  const { publicEndpoint } = await import('../src/privacy.mjs');
  assert.equal(publicEndpoint({ host: '127.0.0.1', port: 1 }), null);
  assert.equal(publicEndpoint({ host: '10.1.2.3', port: 1 }), null);
  assert.deepEqual(publicEndpoint({ host: '203.0.113.10', port: 1 }), { host: '203.0.113.10', port: 1 });
});
