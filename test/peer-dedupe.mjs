// AGIP-23/dedupe: пара узлов держит ОДИН канал, а свои адреса и алиасы
// никогда не попадают в список пиров (иначе self-dial: 502 и бэк-off циклы).
// Тест изолированный: одноразовый data-dir, без сети и портов.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasLivePeerLink } from '../ws.mjs';
import { setSelfUrl, isSelfPeerUrl, sanitizePeers, addPeer, loadPeers } from '../sync.mjs';

// Изолируем состояние: свои данные в tmp, loopback разрешён только этому процессу.
const _selfUrl = process.env.AGT_SELF_URL, _nodePort = process.env.AGT_NODE_PORT;
delete process.env.AGT_SELF_URL; delete process.env.AGT_NODE_PORT;
process.env.AGT_PEER_ALLOW_LOOPBACK = '1';
process.env.AGT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-peer-dedupe-'));

const SELF = 'http://127.0.0.1:9335';
const ALIASES = ['https://agentcoin.work', 'https://node1.agentcoin.work'];
const PEER = 'https://node2.agentcoin.work';

// Как делает node.mjs на старте: SELF_URL + все алиасы + адрес bind.
setSelfUrl(SELF);
for (const a of ALIASES) setSelfUrl(a);
setSelfUrl(`http://127.0.0.1:9335`);

test('свой адрес и алиасы распознаются как свои', () => {
  assert.equal(isSelfPeerUrl(SELF), true);
  for (const a of ALIASES) assert.equal(isSelfPeerUrl(a), true);
  assert.equal(isSelfPeerUrl('HTTP://127.0.0.1:9335'), true); // регистр схемы не важен
});

test('чужой адрес своим не считается', () => {
  assert.equal(isSelfPeerUrl(PEER), false);
  assert.equal(isSelfPeerUrl('https://node3.agentcoin.work'), false);
});

test('свои адреса не попадают в пиры', () => {
  addPeer(SELF);
  addPeer(ALIASES[0]);
  addPeer(ALIASES[1]);
  assert.deepEqual(loadPeers(), []);
});

test('чужой пир добавляется один раз, повторы игнорируются', () => {
  addPeer(PEER);
  addPeer(PEER);
  assert.deepEqual(loadPeers(), [PEER]);
});

test('sanitizePeers чистит себя, алиасы и дубли за один проход', () => {
  const out = sanitizePeers([SELF, PEER, ALIASES[0], PEER, 'https://node3.agentcoin.work', ALIASES[1], 'мусор']);
  assert.deepEqual(out, [PEER, 'https://node3.agentcoin.work']);
});

test('исходящая живая связь блокирует повторный звонок', () => {
  const peers = new Set([{ connectedPeerUrl: PEER, isClient: true }]);
  assert.equal(hasLivePeerLink(peers, PEER), true);
});

test('входящая живая связь (их theirUrl = URL пира) блокирует звонок', () => {
  const peers = new Set([{ theirUrl: PEER }]);
  assert.equal(hasLivePeerLink(peers, PEER), true);
});

test('связь с другим пиром звонку не мешает', () => {
  const peers = new Set([{ connectedPeerUrl: 'https://node3.agentcoin.work', isClient: true }]);
  assert.equal(hasLivePeerLink(peers, PEER), false);
});

test('пустой набор, null и битые записи — звонок разрешён, падений нет', () => {
  assert.equal(hasLivePeerLink(new Set(), PEER), false);
  assert.equal(hasLivePeerLink(undefined, PEER), false);
  assert.equal(hasLivePeerLink(new Set([null, undefined, {}]), PEER), false);
});

test.after(() => {
  fs.rmSync(process.env.AGT_DATA_DIR, { recursive: true, force: true });
  if (_selfUrl !== undefined) process.env.AGT_SELF_URL = _selfUrl;
  if (_nodePort !== undefined) process.env.AGT_NODE_PORT = _nodePort;
});
