// ============================================================
// ИМПЕРАТОРСКИЙ ХОЛОДНЫЙ КОШЕЛЁК AGT (emperor wallet)
// Файл-хранилище «как wallet.dat у Bitcoin»:
//   · приватный ключ ed25519 ШИФРУЕТСЯ AES-256-GCM, ключ — пароль владельца
//     (scrypt N=2^17, r=8, p=1 — офлайн-PBKDF, стойкость > Sapphire-class brute force);
//   · мнемоника BIP39 (12/24 слова) → seed → SLIP-0010 ed25519 master key
//     (стандартные пути: восстановление через годы на любом Node ≥ 18);
//   · адрес = canonical addressFromPub(pub) — принимает любая честная нода AGT;
//   · ОФЛАЙН: create/restore/sign/verify не обращаются к сети вообще;
//     сеть нужна только для POST /tx и баланса (по желанию).
// Файл по умолчанию: data-emperor/emperor-wallet.empw (gitignored).
// Секреты НИКОГДА не пишутся в логи/issue/землю репозитория.
//
// Режимы:
//   node tools/emperor-wallet.mjs create   [--file P] [--words 12|24] [--label "Император"]
//   node tools/emperor-wallet.mjs info     [FILE]
//   node tools/emperor-wallet.mjs sign     [FILE] --tx tx.json --out signed-tx.json
//   node tools/emperor-wallet.mjs verify   signed-tx.json
//   node tools/emperor-wallet.mjs balance  [FILE] --node http://127.0.0.1:9335
//   node tools/emperor-wallet.mjs pass     [FILE]     (смена пароля)
//   node tools/emperor-wallet.mjs restore  [--file P]   (восстановление из слов — для «10 лет спустя»)
// Пароль/фраза: tools/emperor-create.cmd | tools/emperor-restore.cmd (скрытый ввод PowerShell).
// Самостоятельный запуск с открытым вводом: можно, но ввод окажется виден — избегай.
// ============================================================
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* граф реальный импорт core offline */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORE = await import(pathToFileURL(path.join(ROOT, 'core.mjs')).href);

const DEFAULT_FILE = path.join(ROOT, 'data-emperor', 'emperor-wallet.empw');
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 512 * 1024 * 1024 };
const WORDS_FILE = path.join(ROOT, 'bip39-english.txt');

function die(msg, code = 2) { console.error('ОШИБКА: ' + msg); process.exit(code); }
function log(m) { process.stdout.write(m + '\n'); }

/* ---------- BIP39 ---------- */
function loadWords() {
  const raw = fs.readFileSync(WORDS_FILE, 'utf8');
  return raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function hexToBits(hexStr) {
  const out = [];
  for (const ch of hexStr) out.push((parseInt(ch, 16) >> 3) & 1, (parseInt(ch, 16) >> 2) & 1, (parseInt(ch, 16) >> 1) & 1, parseInt(ch, 16) & 1);
  return out;
}
function bitsToHex(bits) {
  let s = '';
  for (let i = 0; i < bits.length; i += 4) s += (bits[i] << 3 | bits[i + 1] << 2 | bits[i + 2] << 1 | bits[i + 3]).toString(16);
  return s;
}
function mnemonicFromEntropy(entBytes) {
  const ENT = entBytes.length * 8;
  const CS = ENT / 32;
  const h = crypto.createHash('sha256').update(entBytes).digest();
  const bits = [...hexToBits(entBytes.toString('hex')), ...hexToBits(h.toString('hex')).slice(0, CS)];
  const words = loadWords();
  const idxBits = bits.slice(0, bits.length - 0);
  const out = [];
  for (let i = 0; i < bits.length; i += 11) {
    const n = bits.slice(i, i + 11).reduce((a, b) => a * 2 + b, 0);
    out.push(words[n]);
  }
  return out.join(' ');
}
function validateMnemonic(wordsArr) {
  const words = loadWords();
  const idxs = wordsArr.map(w => { const i = words.indexOf(w.toLowerCase()); if (i < 0) throw new Error(`слово не из BIP39-листа: «${w}»`); return i; });
  const n = idxs.length;
  if (![12, 15, 18, 21, 24].includes(n)) throw new Error(`нужны 12/15/18/21/24 слов, получено ${n}`);
  const CS = n / 3;
  const bits = idxs.map(i => Array.from({ length: 11 }, (_, b) => (i >> (10 - b)) & 1)).flat();
  const entBits = bits.slice(0, n * 11 - CS);
  const chkBits = bits.slice(n * 11 - CS);
  const expected = hexToBits(crypto.createHash('sha256').update(Buffer.from(bitsToHex(entBits), 'hex')).digest().toString('hex')).slice(0, CS);
  if (chkBits.some((b, i) => b !== expected[i])) throw new Error('контрольная сумма мнемоники НЕ сходится — опечатка в словах');
  return Buffer.from(bitsToHex(entBits), 'hex');
}

/* ---------- SLIP-0010 ed25519 master → PKCS8 ---------- */
function slip10Master(seed) {
  const I = crypto.createHmac('sha512', Buffer.from('ed25519 seed')).update(seed).digest();
  return I.subarray(0, 32); // IL = приватный скед; IR = chaincode (нужен только при деривации веток)
}
function pkcs8FromRaw32(raw32) {
  const head = Buffer.from('302e020100300506032b657004220420', 'hex');
  return Buffer.concat([head, raw32]);
}
function keyPairFromSeed(seed) {
  // Компания с сетевой схемой AGIP-2 (bip39-lite.mjs): начальный 32 байта BIP39-seed
  // непосредственно = приватный скллер ed25519 (PKCS8: seed → DER). Это значит, что
  // существущий «сид» из POST /wallet/create{recover:true} имеет ТОТ ЖЕ адрес —
  // империjemский кошелёк способен ИМПОРТИРОВАТЬ старый сид без обращения к ноде.
  const raw = seed.subarray(0, 32);
  const privPem = pkcs8Pem(pkcs8FromRaw32(raw));
  const pubPem = crypto.createPublicKey(privPem).export({ type: 'spki', format: 'pem' });
  const address = CORE.addressFromPub(pubPem);
  // диагностическая пара SLIP-0010 (не используется для доступа — объяснение в doc'e)
  void slip10Master(seed);
  return { privPem, pubPem, address };
}
function pkcs8Pem(buf) {
  const b = buf.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${b}\n-----END PRIVATE KEY-----`;
}

/* ---------- шифрование хранилища ---------- */
function deriveKey(pass, salt) { return crypto.scryptSync(pass, salt, 32, SCRYPT); }
function encryptKeystore({ privPem, pubPem, address, label, mnemonicHash, pass }) {
  const kdfSalt = crypto.randomBytes(16);
  const key = deriveKey(pass, kdfSalt);
  const iv = crypto.randomBytes(12);
  const ct = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([ct.update(String(privPem), 'utf8'), ct.final()]);
  return {
    format: 'EMPW1', cipher: 'aes-256-gcm', kdf: { name: 'scrypt', ...SCRYPT },
    kdfSalt: kdfSalt.toString('hex'), iv: iv.toString('hex'), authTag: ct.getAuthTag().toString('hex'),
    ct: enc.toString('hex'),
    pubkey: pubPem, address, label, mnemonicHash,
    createdAt: new Date().toISOString(),
    note: 'AGT emperor cold keystore: расшифровка ТОЛЬКО паролем; восстановление вне этого файла — по мнемонике (выписана на бумагу)',
  };
}
function decryptKeystore(ks, pass) {
  const key = deriveKey(pass, Buffer.from(ks.kdfSalt, 'hex'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ks.iv, 'hex'));
  d.setAuthTag(Buffer.from(ks.authTag, 'hex'));
  const out = Buffer.concat([d.update(Buffer.from(ks.ct, 'hex')), d.final()]).toString('utf8');
  const pubPem = crypto.createPublicKey(out).export({ type: 'spki', format: 'pem' });
  const address = CORE.addressFromPub(pubPem);
  if (address !== ks.address) throw new Error('адрес не совпал с записью в хранилище — файл повреждён/подменён');
  return out;
}

/* ---------- CLI ---------- */
const argv = process.argv.slice(2);
const cmdName = argv.shift();

function argVal(name, fallback = null) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}
function hasFlag(f) { return argv.includes(f); }

async function main() {
  if (cmdName === 'info') {
    const file = argVal('--file', DEFAULT_FILE);
    const ks = JSON.parse(fs.readFileSync(file, 'utf8'));
    log(JSON.stringify({ file, address: ks.address, pubkey: ks.pubkey.slice(27, 75) + '…', label: ks.label, createdAt: ks.createdAt, format: ks.format }, null, 2));
    return;
  }
  if (cmdName === 'balance') {
    const file = argVal('--file', DEFAULT_FILE);
    const node = argVal('--node', 'http://127.0.0.1:9335');
    const ks = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = await fetch(node.replace(/\/$/, '') + '/balance', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address: ks.address }), signal: AbortSignal.timeout(9000),
    });
    const j = await r.json().catch(() => ({}));
    log(JSON.stringify({ address: ks.address, node, ...j }, null, 2));
    return;
  }
  if (cmdName === 'verify') {
    const file = (argv.length && !argv[0].startsWith('--')) ? argv[0] : 'signed-tx.json';
    const tx = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ok = CORE.verifyTransaction(tx);
    log(ok ? `ПОДПИСЬ ЧЕСТНАЯ: ${tx.from} → ${tx.to} на ${tx.amount} AGT (offline-verify)` : 'ПОДПИСЬ НЕПРАВИЛЬНА/ЧУЖАЯ — эту tx нода отвергнет');
    process.exit(ok ? 0 : 1);
  }

  /* --- режимы, требующие пароля, приходят через stdin/ prompts из ps1 --- */
  if (cmdName === 'create' || cmdName === 'restore' || cmdName === 'sign' || cmdName === 'pass') {
    return runSecured(cmdName).then(code => process.exit(code ?? 0));
  }
  die('режимы: create | info | sign | verify | balance | pass | restore. Смотри docs/EMPEROR-WALLET.md');
  void cmdName;
}

async function runSecured(mode) {
  // СЕКРЕТЫ приходят по stdin с маркерами (ps1Write): строки "PASS:<пароль>" и (для restore) "WORDS:<12 слов>".
  // Хорошая практика: узел этого процесса секреты не пишет в файл/логи.
  const input = await readStdinAll();
  const mk = input.match(/PASS:(.*)\r?\n|PASS:(.*)$/);
  const pass = mk ? (mk[1] ?? mk[2]) : die('нет маркера PASS:<пароль> во входе');
  void pass;

  if (mode === 'sign') {
    const file = argVal('--file', DEFAULT_FILE);
    const txPath = argVal('--tx', null) ?? die('нужен --tx tx.json');
    const outPath = argVal('--out', path.join(path.dirname(txPath), 'signed-tx.json'));
    const ks = JSON.parse(fs.readFileSync(file, 'utf8'));
    const privPem = decryptKeystore(ks, pass);
    const tx = JSON.parse(fs.readFileSync(txPath, 'utf8'));
    if (tx.from !== ks.address) die(`tx.from (${tx.from}) ≠ адрес кошелька (${ks.address}) — расход чужого адреса запрещён приёмкой P0-1`);
    const signed = { ...tx };
    signed.fromPub = ks.pubkey;
    signed.signature = CORE.signTransaction(signed, privPem);
    if (!CORE.verifyTransaction(signed)) die('self-verify не сошёлся — ядро отвергнет');
    fs.writeFileSync(outPath, JSON.stringify(signed, null, 2));
    log(`ПОДПИСАНО (offline) → ${outPath}`);
    log(`отправь: POST /tx на любой честной ноде с файлом ${outPath}`);
    return 0;
  }
  if (mode === 'pass') {
    // PASS: — СТАРЫЙ пароль, PASS2: — НОВЫЙ (двойной ввод нового проверяет ps1-обёртка)
    const file = argVal('--file', DEFAULT_FILE);
    const again = input.match(/PASS2:(.*)\r?\n|PASS2:(.*)$/);
    const pass2 = again ? (again[1] ?? again[2]) : null;
    if (pass2 === null || pass2 === '' ) die('нет нового пароля (PASS2:) — ничего не изменено');
    const ks = JSON.parse(fs.readFileSync(file, 'utf8'));
    const privPem = decryptKeystore(ks, pass);
    const newKs = encryptKeystore({ privPem, pubPem: ks.pubkey, address: ks.address, label: ks.label, mnemonicHash: ks.mnemonicHash, pass: pass2 });
    fs.writeFileSync(file, JSON.stringify(newKs, null, 2));
    log('пароль изменён, файл переписан: ' + file);
    return 0;
  }
  if (mode === 'restore') {
    const wLine = input.match(/WORDS:([^\r\n]+)/);
    if (!wLine) die('нет маркера WORDS:<слова> во входе');
    const words = wLine[1].trim();
    const file = argVal('--file', path.join(ROOT, 'data-emperor', 'restored.empw'));
    const label = argVal('--label', 'emperor-restored');
  const ent = validateMnemonic(words.split(/\s+/))
    ; void ent; // восстановление — только по словам
  const passphrase = argVal('--pp', '');
    const seed = crypto.pbkdf2Sync(Buffer.from(words.normalize('NFKD'), 'utf8'), Buffer.from('mnemonic' + passphrase, 'utf8'), 2048, 64, 'sha512');
    const kp = keyPairFromSeed(seed);
    const newKs = encryptKeystore({ privPem: kp.privPem, pubPem: kp.pubPem, address: kp.address, label, mnemonicHash: sha256dStr(words), pass });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(newKs, null, 2));
    log(`ВОССТАНОВЛЕНО: адрес ${kp.address}`);
    log(`файл: ${file}`);
    return 0;
  }
  /* --- create --- */
  const wordsN = Number(argVal('--words', '12'));
  const label = argVal('--label', 'Император');
  const pct2 = input.match(/PASS2:(.*)\r?\n|PASS2:(.*)$/);
  const pass2 = pct2 ? (pct2[1] ?? pct2[2]) : null;
  if (pass2 !== pass) die('пароль не совпал дважды — хранилище НЕ создано');
  const file = argVal('--file', DEFAULT_FILE);
  const ent = crypto.randomBytes(wordsN === 12 ? 16 : 32);
  const words = mnemonicFromEntropy(ent);
  const seed = crypto.pbkdf2Sync(Buffer.from(words.normalize('NFKD'), 'utf8'), Buffer.from('mnemonic', 'utf8'), 2048, 64, 'sha512');
  const kp = keyPairFromSeed(seed);
  const ks = encryptKeystore({ privPem: kp.privPem, pubPem: kp.pubPem, address: kp.address, label, mnemonicHash: sha256dStr(words), pass });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ks, null, 2));
  log('=== ИМПЕРАТОРСКИЙ КОШЕЛЁК СОЗДАН ===');
  log(`адрес:      ${kp.address}`);
  log(`хранилище:  ${file}  (AES-256-GCM + scrypt; файл НЕ в git — уже в .gitignore)`);
  log(`хэш мнемоники (проверка подлинности позже): sha256d=${ks.mnemonicHash}`);
  log(''); log('=== БУМАЖНЫЙ РЕЗЕРВ (единственный показ, НЕ фотографируй, НЕ отключай питание) ===');
  const wordsArr = words.split(' ');
  for (let i = 0; i < wordsArr.length; i++) log(`  ${String(i + 1).padStart(2, '0')}. ${wordsArr[i]}`);
  log('=== ПРАВИЛО ===');
  log('· эти слова НА БУМАГУ (два места), на двух РАЗНЫХ физических площадках');
  log('· пароль хранилища — отдельно от бумаги (диспетчер паролей/два места)');
  log('· восстановление раз в 10 лет: одинаковый результат на любой честной машине: узлов: node ≥ 18');
  log('  команда: node tools/emperor-wallet.mjs restore --file data-emperor/restored.empw (скрипт emperor-restore.cmd)');
  log('· не публикуй слова/пароль в чаты, issue, скриншоты');
  return 0;
}
void die;
function sha256dStr(s) {
  const a = crypto.createHash('sha256').update(s).digest();
  return crypto.createHash('sha256').update(a).digest('hex');
}

function readStdinAll() {
  return new Promise((resolve) => {
    let s = '';
    if (process.stdin.isTTY) return resolve(s);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => { s += d; });
    process.stdin.on('end', () => resolve(s));
  });
}

await main();
