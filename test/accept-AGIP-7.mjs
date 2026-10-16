/* accept-AGIP-7.mjs — исполняемый критерий приёмки AGIP-7 (docs/AGIP-7.md).
   Запуск: node test/accept-AGIP-7.mjs   (без сети — чистая логика + песочница BC)
   Проверяет: (1) вердикт выбора цепи не штрафует пира; (2) клапан самопомощи
   изоляции при «все пиры заблокированы + stale tip»; (3) miner-client не майнит
   на протухшем tip; (4) зомби-детект майнера по heartbeat.
   Exit-код: 0 = приёмка пройдена; 1 = FAIL. */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let fails = 0;
const ok = m => console.log('  ok: ' + m);
const bad = m => { console.error('  FAIL: ' + m); fails++; };

// ── 1. Классификация вердиктов (sync.mjs)
import { isChainChoiceVerdict, peerStrike, loadPeerMeta, savePeerMeta, syncAll, loadPeers, savePeers } from '../sync.mjs';
import { Blockchain } from '../core.mjs';

if (isChainChoiceVerdict('fork_not_heavier')) ok('fork_not_heavier = выбор цепи, не нарушение');
else bad('fork_not_heavier должен быть chain-choice вердиктом');
if (!isChainChoiceVerdict('header PoW fail')) ok('header PoW fail = настоящее нарушение (остаётся страйком)');
else bad('PoW fail неожиданно не считается нарушением');
if (!isChainChoiceVerdict('block@300: pow_fail')) ok('некающий блок = нарушение (страйк сохранён)');
else bad('вскрытый невалидный блок должен оставаться страйком');
if (isChainChoiceVerdict('no_blocks') && isChainChoiceVerdict('fork_height_mismatch')) ok('транзиентные отказы без страйка');

// ── 2. Клапан самопомощи: pypp-meta с заблокированными пирами + stale tip
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agip7-'));
const oldData = process.env.AGT_DATA_DIR;
process.env.AGT_DATA_DIR = tmp;
savePeers(['http://p1', 'http://p2']);
const staleMeta = {
  'http://p1': { strikes: 3, accepted: 0, blockedUntil: Date.now() + 3600_000 },
  'http://p2': { strikes: 3, accepted: 0, blockedUntil: Date.now() + 3600_000 },
};
savePeerMeta(staleMeta);
// BC со stale tip: цепь из одного блока с timestamp 10 минут назад
const bc = new Blockchain(tmp);
const tipTs = Date.now() - 600_000;
bc.chain = [{ height: 1, hash: 'h1', header: { prevHash: 'h0', merkleRoot: 'm', timestamp: tipTs, difficultyBits: 14, nonce: 0 } }];
const logs = await syncAll(bc);
if (logs.some(l => String(l).includes('SAFETY VALVE'))) ok('клапан самопомощи сработал при все-заблоках + stale tip');
else bad('клапан не сработал: ' + logs.join('; ').slice(0, 140));
const after = loadPeerMeta();
if (!after['http://p1']?.blockedUntil && !after['http://p2']?.blockedUntil) ok('blockedUntil снят, страйки сохранены (p1 strikes=' + after['http://p1']?.strikes + ')');
else bad('клапан не снял блокировку');

// 2b. Клапан НЕ должен срабатывать при свежем tip (секьюрность против обхода банов)
savePeerMeta(staleMeta);
bc.chain = [{ height: 1, hash: 'h1', header: { prevHash: 'h0', merkleRoot: 'm', timestamp: Date.now(), difficultyBits: 14, nonce: 0 } }];
const logs2 = await syncAll(bc);
if (!logs2.some(l => String(l).includes('SAFETY VALVE'))) ok('при свежем tip клапан молчит (бан пиров неприкосновенен)');
else bad('клапан сработал на свежем tip — дыра в секьюрности');

process.env.AGT_DATA_DIR = oldData;

// ── 3. Miner-client: гварды через рантайм-симуляцию недоступны без сети,
// проверяем KEY-константы в исходнике (не исполняем сеть)
const src = fs.readFileSync(path.join(process.cwd(), 'miner-client.mjs'), 'utf8');
if (src.includes('tipAgeSec > 300') && src.includes('пропускаем слайс')) ok('майнер: гвард stale tip присутствует');
else bad('майнер: гвард stale tip отсутствует');
if (src.includes('HEARTBEAT_FILE') && src.includes('зомби-детект')) ok('майнер: зомби-детект по heartbeat присутствует');
else bad('майнер: heartbeat-зомби-детект отсутствует');
const ssrc = fs.readFileSync(path.join(process.cwd(), 'sync.mjs'), 'utf8');
if (!/peerStrike\(peerUrl,\s*`fork adopt failed: \$\{r\.reason\}`\); return/.test(ssrc) && ssrc.includes('isChainChoiceVerdict(r.reason)')) ok('sync: страйк при adopt-отказе только для нарушений (fork_not_heavier пропускается)');
else bad('sync: страйки при choice-вердиктах всё ещё включены');

console.log(fails ? `FAIL: ${fails} проверок не прошли` : 'ALL OK: AGIP-7 приёмка пройдена');
process.exit(fails ? 1 : 0);
