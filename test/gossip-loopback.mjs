/* gossip-loopback.mjs — приёмка фильтра loopback-пиров из gossip (§13 аудита).
   Чужой 127.0.0.1:порт указывает на машину ПИРА, а локальный дайл бьёт в свои же
   порты (self-dial). Gossip-приём режет такие адреса; явное добавление
   (/peer/add, seeds, bootstrap) разрешено всегда; стендам — AGT_ALLOW_LOOPBACK_PEERS=1.
   Запуск: node test/gossip-loopback.mjs. Exit 0 = ok. */
import assert from 'node:assert/strict';
import { normalizePeerUrl, sanitizePeers, isLoopbackPeerUrl } from '../sync.mjs';

const fails = [];
const t = (cond, m) => { if (!cond) fails.push(m); else console.log('  ok: ' + m); };

// 1. детектор loopback
t(isLoopbackPeerUrl('http://127.0.0.1:9341'), '127.0.0.1 — loopback');
t(isLoopbackPeerUrl('http://localhost:9335'), 'localhost — loopback');
t(isLoopbackPeerUrl('http://[::1]:9335'), '[::1] — loopback');
t(!isLoopbackPeerUrl('https://node1.agentcoin.work'), 'публичный хост — не loopback');
t(!isLoopbackPeerUrl('http://91.99.191.236:9335'), 'публичный IP — не loopback');
t(!isLoopbackPeerUrl('https://agentcoin.work'), 'голый домен — не loopback (другая проблема)');
t(!isLoopbackPeerUrl('не-адрес'), 'мусор — не loopback (режет normalize)');

// 2. явное добавление loopback НЕ запрещено уровнем sync (стенды живы)
t(normalizePeerUrl('http://127.0.0.1:9335') === 'http://127.0.0.1:9335', 'normalize держит loopback для явного add');
t(sanitizePeers(['http://127.0.0.1:9335']).length === 1, 'sanitizePeers не трогает явный loopback');

// 3. логика gossip-фильтра из node.mjs onPeers (allowLoop=false по умолчанию)
const SELF_URL = 'https://node1.agentcoin.work';
const theirUrl = 'https://node2.agentcoin.work';
function gossipFilter(list, allowLoop) {
  return [...new Set(list)].filter(u => typeof u === 'string' && /^https?:\/\//.test(u) && !u.includes(SELF_URL) && !theirUrl?.includes(u) && (allowLoop || !isLoopbackPeerUrl(u))).slice(0, 50);
}
const incoming = ['https://node3.agentcoin.work', 'http://127.0.0.1:9341', 'http://localhost:9335', theirUrl, SELF_URL];
const cut = gossipFilter(incoming, false);
t(cut.length === 1 && cut[0] === 'https://node3.agentcoin.work', `gossip режет loopback+self+their (осталось: ${JSON.stringify(cut)})`);
const kept = gossipFilter(incoming, true);
t(kept.includes('http://127.0.0.1:9341'), 'AGT_ALLOW_LOOPBACK_PEERS=1 оставляет loopback для стендов');

if (fails.length) { console.error('FAIL:\n - ' + fails.join('\n - ')); process.exit(1); }
console.log('GOSSIP-LOOPBACK-OK');
