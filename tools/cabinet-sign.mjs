// Простой мост «кабинет → подпись»: берёт СКАЧАННЫЙ из кабинета challenge-JSON,
// находит приватный ключ адреса в локальных data-каталогах (или в указанной папке),
// подписывает локально и печатает ГОТОВЫЙ ответ для поля «Ответ Skill».
// Секрет никогда не печатается и не уходит в сеть: подпись остаётся локальной.
//
// Запуск: node tools/cabinet-sign.mjs <путь-к-challenge.json> [папка-с-wallets.json]
// Двойной клик: tools\cabinet-sign.cmd   (спросит файл interactively)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { addressFromPub } from '../core.mjs'; // каноническая деривация адреса — как у всей сети

// канонизация pubkey ровно по правилам ноды (agent-identity.canonicalAgentPublicKey):
// иначе подпись в ответ может не сойтись с pub паспорта
function canonicalPub(pub) {
  if (typeof pub !== 'string' || pub.length > 512 || !pub.startsWith('-----BEGIN PUBLIC KEY-----\n')) return null;
  try {
    const key = crypto.createPublicKey(pub);
    if (key.asymmetricKeyType !== 'ed25519') return null;
    return key.export({ type: 'spki', format: 'pem' });
  } catch { return null; }
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argFile = process.argv[2];

function die(m, code = 2) { console.error('ОШИБКА: ' + m); process.exit(code); }
if (!argFile) die('Укажи путь к challenge.json (кабинет → «Скачать запрос JSON»).\nПример: node tools/cabinet-sign.mjs Downloads\\agentcoin-login-challenge.json\nЛибо запусти tools\\cabinet-sign.cmd');

let raw;
try { raw = fs.readFileSync(argFile, 'utf8'); } catch (e) { die('не читаю файл: ' + e.message); }
let ch;
try { ch = JSON.parse(raw); } catch (e) {
  // маленькая миласть: файл мог содержать объект с полем challenge или перед клиентом
  try { const v = JSON.parse(raw.trim().split('\n').slice(-1)[0]); ch = v.challenge || v; }
  catch { die('файл не JSON: ' + e.message); }
}
if (ch && typeof ch === 'object' && ch.challenge && !ch.message) ch = ch.challenge;
const need = ['version', 'domain', 'action', 'network', 'address', 'pub', 'message', 'challengeId'];
for (const k of need) if (ch?.[k] === undefined) die('в challenge нет поля ' + k + ' — это не запрос кабинета');
if (ch.action !== 'login') die('action=' + ch.action + ' — подписываем только action=login');

const canon = canonicalPub(ch.pub);
if (!canon || addressFromPub(canon) !== ch.address) die('pub не разворачивается в заявленный address канонической деривацией ядра — запрос подозрителен, не подписывать');

const dirs = [process.argv[3] || null, ...fs.readdirSync(ROOT).filter(d => d.startsWith('data'))].filter(Boolean);
let priv = null, where = null;
for (const d of dirs) {
  const wf = path.join(ROOT, d, 'wallets.json');
  let w; try { w = JSON.parse(fs.readFileSync(wf, 'utf8')); } catch { continue; }
  const rec = w[ch.address];
  if (rec?.privKey) { priv = rec.privKey; where = d + '/wallets.json (' + (rec.label || '') + ')'; break; }
}
if (!priv) die('локальный приватный ключ для ' + ch.address + ' не найден в data-каталогах этого компьютера.\nЭто правильно для Passport-кошельков (ключ у агента) — тогда подпиши через Skill: agent-profile.mjs sign-challenge');

let exp = ch.expiresAt ? new Date(ch.expiresAt) : null;
if (exp && exp.getTime() < Date.now()) die('challenge истёк ' + exp.toISOString() + ' — нажми «Получить запрос на вход» заново и подпиши новый файл');

let sig;
try { sig = crypto.sign(null, Buffer.from(ch.message, 'utf8'), crypto.createPrivateKey(priv)).toString('hex'); }
catch (e) { die('подпись не удалась: ' + e.message); }

console.log('Подписано ключом: ' + where);
console.log('Ответ Skill (вставь целиком в поле «Ответ Skill» и нажми Войти в течение 5 минут):');
console.log('');
console.log(JSON.stringify({ address: ch.address, challengeId: ch.challengeId, nonce: ch.message, signature: sig }, null, 2));
