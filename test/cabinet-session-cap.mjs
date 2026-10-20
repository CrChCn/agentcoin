// AGIP-44 STAGE-1: cap 7 активных сессий на паспорт (ротация старейшей своей).
// Сухая прокрутка сценариев на живом классе Cabinet с инжектным временем.
// Не трогает консенсус: только кабинет. Никаких live-нод/кошельков не затрагивается.
import * as cab from '../cabinet.mjs';
import * as core from '../core.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

let pass = 0; const fails = [];
function ok(l) { pass++; console.log('  ok  ' + l); }
function bad(l, e = '') { fails.push(l); console.log('FAIL  ' + l + (e ? ' :: ' + e : '')); }
function step(c, l, e) { c ? ok(l) : bad(l, e); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-sesscap-'));
const PASSPORT_FILE = path.join(tmp, 'passports.json');

function newAgent() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  return { pub, priv: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
}
const A = newAgent(), B = newAgent();
const aAddr = core.addressFromPub(A.pub);
const bAddr = core.addressFromPub(B.pub);
fs.writeFileSync(PASSPORT_FILE, JSON.stringify([
  { address: aAddr, pub: A.pub, handle: 'agent-a' },
  { address: bAddr, pub: B.pub, handle: 'agent-b' },
], null, 2));

let nowMs = 1_700_000_000_000;
const now = () => nowMs;

function makeCabinet(envCap) {
  if (envCap === undefined) delete process.env.AGT_SESSION_CAP;
  else process.env.AGT_SESSION_CAP = String(envCap);
  return new cab.Cabinet({ passportFile: PASSPORT_FILE,
    securityRef: { isBanned: () => false }, balancesFn: () => ({}), now, identityRegistry: null });
}
function login(c, address, agent) {
  const ch = c.challenge(address);
  if (!ch.ok) return ch;
  const sig = crypto.sign(null, Buffer.from(ch.challenge.message, 'utf8'),
    crypto.createPrivateKey(agent.priv)).toString('hex');
  return c.loginChallenge(address, ch.nonce, sig, ch.challengeId);
}

// --- С1: 7 логинов — все ок, без ротации ---
const c = makeCabinet();
const s = [];
for (let i = 0; i < 7; i++) s.push(login(c, aAddr, A));
step(s.every(x => x.ok === true), 'С1: 7 логинов подряд все ok');
step(s.every(x => x.rotated === false), 'С1b: ни один вход не ротировал (cap ровно 7)');
step(s[6].activeSessions === 7 && s[6].sessionCap === 7, 'С1c: activeSessions=7, sessionCap=7');

// --- С2: 8-й вход — ok с ротацией; старейший токен умирает; живых 7 ---
const s8 = login(c, aAddr, A);
step(s8.ok === true && s8.rotated === true, 'С2: 8-й вход ok, rotated=true');
step(c.session(aAddr, s[0].token) === null, 'С2b: старейшая (1-й) сессия вытеснена');
const alive = s.slice(1).filter(x => c.session(aAddr, x.token) !== null).length
  + (c.session(aAddr, s8.token) ? 1 : 0);
step(alive === 7, `С2c: живых сессий у агента ровно 7 (${alive})`);

// --- С3: logout освобождает место — следующий вход НЕ ротирует ---
c.logout(s[1].token);
const s9 = login(c, aAddr, A);
step(s9.ok === true && s9.rotated === false, 'С3: после logout следующий вход без ротации');

// --- С4: TTL-чистка: время уходит за TTL → вход свежий без ротации ---
nowMs += 9 * 3600_000;
const s10 = login(c, aAddr, A);
step(s10.ok === true && s10.rotated === false, 'С4: после истечения TTL вход свежий (prune работает)');

// --- С5: чужой агент не пострадал: B ротирует только B ---
const bs = [];
for (let i = 0; i < 8; i++) bs.push(login(c, bAddr, B));
step(bs.slice(0, 7).every(x => x.ok === true), 'С5a: у B свои 7 входов ok');
step(bs[7].rotated === true && c.session(bAddr, bs[0].token) === null, 'С5b: ротация B затронула только B');
step(c.session(aAddr, s10.token) !== null, 'С5c: сессия A не пострадала от ротации B');

// --- С6: env AGT_SESSION_CAP=3 ---
const c3 = makeCabinet(3);
const xs = [];
for (let i = 0; i < 4; i++) xs.push(login(c3, aAddr, A));
step(xs.slice(0, 3).every(z => z.ok && z.sessionCap === 3), 'С6a: cap=3 — первые 3 входа ok, sessionCap=3');
step(xs[3].rotated === true && xs[3].sessionCap === 3, 'С6b: при cap=3 четвёртый вход ротирует старейшую');
delete process.env.AGT_SESSION_CAP;

// --- С7: state показывает sessions владельцу и не создаёт утечки без токена ---
const st = c.state(aAddr, s10.token);
step(st.ok === true && st.sessions && st.sessions.cap === 7, 'С7: state отдаёт sessions.cap владельцу');
const st2 = c.state(aAddr, null);
step(st2.ok === false, 'С7b: state без живой сессии — ok=false (нет утечки)');

// --- С8: ban — залогиниться нельзя (регрессия существующей защиты) ---
const banned = new cab.Cabinet({ passportFile: PASSPORT_FILE,
  securityRef: { isBanned: (a) => a === aAddr }, balancesFn: () => ({}), now, identityRegistry: null });
const bt = login(banned, aAddr, A);
step(bt.ok === false && /ban/.test(bt.error || ''), 'С8: забаненный не может залогиниться: ' + (bt.error || ''));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ncabinet-session-cap: ${pass} ok, ${fails.length} fail`);
if (fails.length) { console.log(fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
console.log('ALL PASS');
