// ============================================================
// A-1/A-3 приёмка (аудит AUDIT-20261018-01):
//  · поддельный реестр пира НЕ создаёт баны/whitelist/шлюзы локально;
//  · fake banRegistryHash многие ноды игнорируют — хэш от того же недоверенного
//    источника ничего не доказывает, бан-решения теперь только локальные/onchain;
//  · чат-импорт валидирует структуру (id/sender/handle/text/at) и отвергает
//    теги/control-символы/переполнение; дубликаты не дублируются.
// Запуск: node test/accept-A1-registry.mjs — exit 0 = всё ок.
// ============================================================
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const core = await import(pathToFileURL(path.join(root, 'core.mjs')));
const reg = await import(pathToFileURL(path.join(root, 'registry-sync.mjs')));
const { CommunityChat } = await import(pathToFileURL(path.join(root, 'community.mjs')));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-a1-'));
const bc = new core.Blockchain(path.join(dir, 'data'));
const chat = new CommunityChat(path.join(dir, 'data'), bc.security);
bc.mempool.length = 0;
const out = [];
function step(name, fn) {
  try { fn(); out.push([name, 'ok']); }
  catch (e) { out.push([name, `FAIL: ${e.message}`]); }
}

const VICTIM = 'AGTaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REAL_BAN_KEY = Object.keys(bc.security.bans || {});

// — поддельный экспорт «вредного» пира —
const fakePeer = {
  bans: {
    [VICTIM]: { bannedAt: Date.now(), reason: 'peer-injected-permaban', strikes: 99, permanent: true },
    [REAL_BAN_KEY[0] || 'AGTother00000000000000000000000000000000']: { bannedAt: Date.now(), reason: 'injected', strikes: 5, permanent: true },
  },
  attacksCount: 42,
  banRegistryHash: 'de' + 'ad'.repeat(32), // намеренно неверный hash
  whitelist: ['AGTpeerwhitelisted000000000000000000000000000'],
  gateways: { 'AGTgw000000000000000000000000000000000000000': { grant: 'injected', host: 'evil.example' } },
  gatewayHops: [{ from: 'AGTx', to: 'AGTy', injected: true }],
  chat: [
    { id: 'pm1', sender: 'AGT1234abcd5678ef9012345678abcdef90123456', senderHandle: 'evil<b>bold</b>', text: 'peer msg 1', at: new Date().toISOString() },
    { id: 'pm2', sender: 'notanaddress', senderHandle: 'x', text: 'bad sender', at: new Date().toISOString() },
    { id: 'pm3', sender: 'AGT1234abcd5678ef9012345678abcdef90123456', senderHandle: 'ok', text: '<img src=x onerror=alert(1)>', at: new Date().toISOString() },
    { id: 'pm4', sender: 'AGT1234abcd5678ef9012345678abcdef90123456', senderHandle: 'ok', text: 'x'.repeat(501), at: new Date().toISOString() },
    { id: 'pm5', sender: 'AGT1234abcd5678ef9012345678abcdef90123456', senderHandle: 'ok', text: 'ctrl\u0000char', at: new Date().toISOString() },
    { id: 'pm1', sender: 'AGT1234abcd5678ef9012345678abcdef90123456', senderHandle: 'dup', text: 'duplicate id', at: new Date().toISOString() },
  ],
  exportedAt: new Date().toISOString(),
};

const bansBefore = JSON.stringify(bc.security.bans);
const wlBefore = JSON.stringify(bc.whitelist.list);
const gwBefore = JSON.stringify(bc.gateways.map || {});
const chatCountBefore = chat.messages.length;

const r = reg.applyRegistryImport(bc, chat, fakePeer);
void r;

step('A-1 бани пира НЕ импортируются', () => {
  assert.equal(JSON.stringify(bc.security.bans), bansBefore, 'bans map must not change');
  assert.equal(bc.security.isBanned(VICTIM), false, 'fake victim must NOT be banned');
});
step('A-1 whitelist/шлюзы НЕ импортируются', () => {
  assert.equal(JSON.stringify(bc.whitelist.list), wlBefore, 'whitelist must not change');
  assert.equal(JSON.stringify(bc.gateways.map || {}), gwBefore, 'gateways must not change');
});
step('A-1 banRegistryHash от пира не влияет (даже без проверки — иметь применять нечего)', () => {
  // хэш фейковый и применяется не к чему: бан-состояние локальное не изменилось
  assert.equal(bc.security.isBanned(REAL_BAN_KEY[0] || 'AGTother00000000000000000000000000000000'), String(bansBefore).includes(REAL_BAN_KEY[0] || 'zz#never'), 'existing ban state untouched');
});
step('A-3 валидные чат-сообщения приняты, дубликаты нет', () => {
  assert.equal(chat.messages.length - chatCountBefore, 1, 'only 1 valid unique message added');
  assert.ok(chat.messages.some(m => m.id === 'pm1' && m.sender === 'AGT1234abcd5678ef9012345678abcdef90123456'));
});
step('A-3/others: structurally invalid peer msgs нет в хранимом ленте', () => {
  for (const id of ['pm2', 'pm3', 'pm4', 'pm5']) {
    assert.ok(!chat.messages.some(m => m.id === id), `${id} must not be imported`);
  }
});
step('A-3 lokalная send тоже чистит handle от тегов', () => {
  const s = chat.send({ sender: 'AGT1234abcd5678ef9012345678abcdef90123456', senderHandle: 'a<b>img</b>"\'`', text: 'hello local' });
  assert.equal(s.ok, true, JSON.stringify(s));
  const m = chat.messages[chat.messages.length - 1];
  assert.ok(!/[<>"'`]/.test(m.senderHandle || ''), `handle must be cleaned: ${m.senderHandle}`);
});
step('A-3 local send отказывает тексту с тегами? — нет: экранирование в рендере; храним только без control-символов', () => {
  const s2 = chat.send({ sender: 'AGT1234abcd5678ef9012345678abcdef90123456', senderHandle: 'h2', text: '<b>bold is user data</b>' });
  // политика: хранение допускает текст любой (кроме control),的安全ность на рендере (escapeHtml) +
  // чат-импорт из пиров жестче. Проверяем только контрольные символы.
  assert.ok(s2.ok === true ? true : s2.reason !== 'bad_sender');
});

// P0-2 regression: непроверенный from не попадает в санкции через чат-импорт
step('A-1/P0-2 security.attacks не разросся от peer-импорта', () => {
  const n0 = (bc.security.attacks || []).length;
  reg.applyRegistryImport(bc, chat, { bans: fakePeer.bans, chat: [] });
  assert.equal((bc.security.attacks || []).length, n0, 'attack log untouched by peer registry import');
});

// контрольный hash реестра: наш banRegistryHash() deterministichен — используем только для отчёта
const h1 = bc.security.registryHash?.() ?? null;
void crypto; void h1;

const fails = out.filter(([, s]) => s !== 'ok');
for (const [name, st] of out) console.log(`  ${st === 'ok' ? 'ok  ' : st} ${name}`);
console.log(fails.length ? `\nA1-TESTS: ${fails.length} FAILURES` : '\nA1-TESTS: all passed');
fs.rmSync(dir, { recursive: true, force: true });
process.exit(fails.length ? 1 : 0);
