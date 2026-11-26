import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALLBACK_SEED_URLS, DEFAULT_DNS_SEED_HOSTS,
  parseSeedRecord, resolveDnsSeeds, seedHostsFromEnv,
} from '../seeds.mjs';

test('parseSeedRecord: ключеванная TXT-запись превращается в URL', () => {
  assert.deepEqual(parseSeedRecord('agt-seed0=https://agentcoin.work'), ['https://agentcoin.work']);
});

test('parseSeedRecord: несколько адресов, хост:порт и склейка без схемы', () => {
  assert.deepEqual(
    parseSeedRecord('agt-seed0=node1.agentcoin.work agt-seed1=91.99.191.236:9335,http://64.225.104.125:9335'),
    ['https://node1.agentcoin.work', 'https://91.99.191.236:9335', 'http://64.225.104.125:9335'],
  );
});

test('parseSeedRecord: дубликаты схлопываются, мусор отбрасывается', () => {
  assert.deepEqual(
    parseSeedRecord('https://AgentCoin.Work https://agentcoin.work p1 javascript:alert(1) https://x:99999 https://y/path'),
    ['https://agentcoin.work'],
  );
  assert.deepEqual(parseSeedRecord(''), []);
  assert.deepEqual(parseSeedRecord(null), []);
});

test('seedHostsFromEnv: дефолт, список и явное выключение', () => {
  assert.deepEqual(seedHostsFromEnv({}), [...DEFAULT_DNS_SEED_HOSTS]);
  assert.deepEqual(seedHostsFromEnv({ AGT_DNS_SEEDS: ' A.example.org , b.example.org ' }), ['a.example.org', 'b.example.org']);
  assert.deepEqual(seedHostsFromEnv({ AGT_DNS_SEEDS: 'off' }), []);
  assert.deepEqual(seedHostsFromEnv({ AGT_DNS_SEEDS: '0' }), []);
});

test('resolveDnsSeeds: TXT-чанки склеиваются, ответы дедуплицируются', async () => {
  const asked = [];
  const resolver = {
    async resolveTxt(host) {
      asked.push(host);
      if (host === 'a.example.org') return [['agt-seed0=https://node1.', 'agentcoin.work'], ['agt-seed1=https://node1.agentcoin.work']];
      throw Object.assign(new Error('no records'), { code: 'ENOTFOUND' });
    },
  };
  const urls = await resolveDnsSeeds({ hosts: ['a.example.org', 'b.example.org'], resolver });
  assert.deepEqual(urls, ['https://node1.agentcoin.work']);
  assert.deepEqual(asked, ['a.example.org', 'b.example.org']);
});

test('resolveDnsSeeds: падение DNS не роняет ноду', async () => {
  const resolver = { async resolveTxt() { throw new Error('boom'); } };
  assert.deepEqual(await resolveDnsSeeds({ hosts: ['seed.invalid'], resolver }), []);
});

test('resolveDnsSeeds: зависший резолвер обрывается по таймауту', async () => {
  const resolver = { resolveTxt: () => new Promise(() => {}) };
  assert.deepEqual(await resolveDnsSeeds({ hosts: ['slow.invalid'], resolver, timeoutMs: 30 }), []);
});

test('fallback: только публичные https-адреса', () => {
  assert.ok(FALLBACK_SEED_URLS.length >= 1);
  for (const u of FALLBACK_SEED_URLS) assert.match(u, /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/);
});
