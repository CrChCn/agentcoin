/* ============================================================
   bip39-lite.mjs — BIP-39 (12 слов) + детерминированный ed25519-кошелёк
   AGIP-2 (шаг 10 из ROADMAP-15-STEPS). Только node:stdlib.
   Ключевой принцип: mnemonic НИКОГДА не хранится в data/; она выдаётся
   один раз при /wallet/create?recover=true, а восстановление — POST
   /wallet/recover — детерминированно даёт ТОТ ЖЕ адрес/privKey/pub.
   
   Форматы совместимы с core.mjs createWallet (ed25519):
   - privKey: pkcs8 PEM от seed[0..32] (BIP39 seed 64 байта → первые 32);
   - pub: spki PEM (совпадает с createWallet.export);
   - address: 'AGT' + sha256d(pub).slice(0,32) + checksum(8 hex) — та же формула.
   Старые (не-sid) кошельки продолжают работать без изменений.
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORDLIST_PATH = path.join(__dirname, 'bip39-english.txt');

let _words = null;
function words() {
  if (_words) return _words;
  const txt = fs.readFileSync(WORDLIST_PATH, 'utf8');
  const list = txt.split(/\r?\n/).map(w => w.trim()).filter(Boolean);
  if (list.length !== 2048) throw new Error('bip39 wordlist corrupt: ' + list.length + ' слов (ожидали 2048)');
  _words = list;
  return _words;
}

// Шифр: 128 бит энтропии → 12 слов (checksum =预售 первых 4 бита sha256(entropy))
export function entropyToMnemonic(entropyBuf) {
  const bits = Array.from(entropyBuf).map(b => b.toString(2).padStart(8, '0')).join('');
  const hash = crypto.createHash('sha256').update(entropyBuf).digest();
  const hashBits = Array.from(hash).map(b => b.toString(2).padStart(8, '0')).join('');
  const checkBits = hashBits.slice(0, entropyBuf.length * 8 / 32);
  const all = bits + checkBits;
  const out = [];
  for (let i = 0; i < all.length / 11; i++) {
    const idx = parseInt(all.slice(i * 11, (i + 1) * 11), 2);
    out.push(words()[idx]);
  }
  return out.join(' ');
}

export function generateMnemonic(strength = 128) {
  if (strength % 32 !== 0 || strength < 128 || strength > 256) throw new Error(' strength must be 128..256, кратно 32');
  return entropyToMnemonic(crypto.randomBytes(strength / 8));
}

// bip39 seed: PBKDF2-HMAC-SHA512(мнемоника, 'mnemonic'+passphrase, 2048, 64)
export function mnemonicToSeed(mnemonic, passphrase = '') {
  return crypto.pbkdf2Sync(mnemonic.normalize('NFKD'), ('mnemonic' + passphrase).normalize('NFKD'), 2048, 64, 'sha512');
}

// ed25519 privKey из 32 байт (BIP-39 seed первые 32) — DER PKCS8
function ed25519PrivFromSeed(seed32) {
  // ed25519 PKCS8 префикс (сюд 根据 to проверенному DER от generateKeyPairSync: OID 1.3.101.112 = 2b6570)
  const DER_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
  const der = Buffer.concat([DER_PREFIX, Buffer.from(seed32)]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

// Детерминированный кошелёк (формат поля идентичен core.createWallet)
function walletFromKeyPair(label, privateKeyObj) {
  const privKey = privateKeyObj.export({ type: 'pkcs8', format: 'pem' });
  const pub = crypto.createPublicKey(privateKeyObj).export({ type: 'spki', format: 'pem' });
  const sha256d = (x) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(x).digest()).digest('hex');
  const pubHash = sha256d(pub);
  const checksum = sha256d(pubHash).slice(0, 8);
  const address = 'AGT' + pubHash.slice(0, 32) + checksum;
  return { label, privKey, pub, pubHash, address, createdAt: Date.now() };
}

// Полный кон: сид → кошелёк
export function walletFromSeed(seed64, label = 'agent') {
  return walletFromKeyPair(label, ed25519PrivFromSeed(seed64.subarray(0, 32)));
}

// Генератор нового сид-кошелька: { wallet, mnemonic }
export function createSeedWallet(label = 'agent', strength = 128) {
  const mnemonic = generateMnemonic(strength);
  const seed = mnemonicToSeed(mnemonic);
  return { wallet: walletFromSeed(seed, label), mnemonic };
}

// Восстановление: { wallet } — тот же адрес при той же фразе
export function recoverFromMnemonic(mnemonicWords, label = 'agent', passphrase = '') {
  const w = String(mnemonicWords || '').trim().split(/\s+/);
  if (w.length !== 12 && w.length !== 15 && w.length !== 18 && w.length !== 24) {
    throw new Error('mnemonic: 12/15/18/24 слов (наша сеть выдаёт 12)');
  }
  // проверка checksum: восстановить энтропию из слов и пересчитать
  const list = words();
  const bits = w.map(word => {
    const idx = list.indexOf(word.toLowerCase());
    if (idx < 0) throw new Error('неизвестное слово: "' + word + '"');
    return idx.toString(2).padStart(11, '0');
  }).join('');
  const entBitsLen = Math.floor(bits.length * 32 / 33);
  const entBits = bits.slice(0, entBitsLen);
  const entBytes = Buffer.from(entBits.match(/.{8}/g).map(h => parseInt(h, 2)));
  const expected = entropyToMnemonic(entBytes);
  if (expected !== w.join(' ')) throw new Error('checksum мнемоники не совпал — фраза повреждена');
  return { wallet: walletFromSeed(mnemonicToSeed(w.join(' '), passphrase), label) };
}
