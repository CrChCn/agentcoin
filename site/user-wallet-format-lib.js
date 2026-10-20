// wallet-format.js — публичные форматы кошелька AGENTCOIN + единицы + QR.
// Контракт agentcoin.wallet.intent.v1 / agentcoin.wallet.signed.v1 идентичен
// cabinet.html (window.AgentcoinWalletFormat) — не менять значения полей.
// Единицы (AGIP-9): 1 AGT = 1e3 mAGT = 1e9 mGNT (магент).
// QR — самодостаточный encoder (byte mode, ECC L, версии 1–10, маска по штрафу);
// без внешних зависимостей; для адресов/реквизитов (≤271 байт на v10).
'use strict';
window.AgentcoinWalletFormat = (() => {
  const ADDR = /^AGT[0-9a-f]{40}$/, HEX = /^[a-f0-9]{64}$/;
  const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join('|') === [...keys].sort().join('|');
  const uint = n => Number.isSafeInteger(n) && n >= 0;
  function decimal(value) {
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,9})?$/.test(value)) throw Error('Сумма: десятичная запись, до 9 знаков после точки.');
    const [a, b = ''] = value.split('.');
    const units = BigInt(a) * 1000000000n + BigInt(b.padEnd(9, '0'));
    if (units < 1n || units > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('Сумма вне допустимого диапазона.');
    const out = a + (b.replace(/0+$/, '') ? '.' + b.replace(/0+$/, '') : '');
    if (BigInt(Number(out).toFixed(9).replace('.', '')) !== units) throw Error('Сумма не представима без потери точности.');
    return out;
  }
  function intent(v) {
    if (!exact(v, ['schema', 'network', 'genesisHash', 'from', 'to', 'amount', 'memo', 'createdAt', 'nonce']) || v.schema !== 'agentcoin.wallet.intent.v1' || v.network !== 'AGENTCOIN' || !HEX.test(v.genesisHash) || !ADDR.test(v.from) || !ADDR.test(v.to) || v.amount !== decimal(v.amount) || typeof v.memo !== 'string' || new TextEncoder().encode(v.memo).length > 512 || /[\u0000-\u001f\u007f]/.test(v.memo) || !uint(v.createdAt) || !uint(v.nonce)) throw Error('Неверный публичный запрос перевода.');
    return v;
  }
  async function hash(value) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    return new Uint8Array(await crypto.subtle.digest('SHA-256', await crypto.subtle.digest('SHA-256', bytes)));
  }
  const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
  async function signed(v, expected) {
    intent(expected);
    if (!exact(v, ['schema', 'network', 'genesisHash', 'intent', 'tx']) || v.schema !== 'agentcoin.wallet.signed.v1' || v.network !== expected.network || v.genesisHash !== expected.genesisHash) throw Error('Файл другой сети или неизвестного формата.');
    intent(v.intent);
    for (const k of Object.keys(expected)) if (v.intent[k] !== expected[k]) throw Error('Подписанный файл не совпадает с подготовленным переводом.');
    const tx = v.tx;
    if (!exact(tx, ['from', 'to', 'amount', 'nonce', 'ts', 'memo', 'fromPub', 'signature', 'txid']) || tx.from !== expected.from || tx.to !== expected.to || tx.amount !== Number(expected.amount) || !Number.isFinite(tx.amount) || tx.nonce !== expected.nonce || tx.ts !== expected.createdAt || tx.memo !== expected.memo || typeof tx.fromPub !== 'string' || tx.fromPub.length > 256) throw Error('Поля транзакции не совпадают с запросом.');
    const pubhash = hex(await hash(tx.fromPub));
    const derived = 'AGT' + pubhash.slice(0, 32) + hex(await hash(pubhash)).slice(0, 8);
    if (derived !== tx.from) throw Error('Публичный ключ не принадлежит отправителю.');
    const digest = await hash(JSON.stringify({ from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce, ts: tx.ts, memo: tx.memo }));
    if (hex(digest) !== tx.txid) throw Error('Неверный идентификатор транзакции.');
    if (!/^[a-f0-9]{128}$/i.test(tx.signature)) throw Error('Неверный формат подписи.');
    const pem = tx.fromPub.match(/^-----BEGIN PUBLIC KEY-----\n([A-Za-z0-9+/=\n]+)-----END PUBLIC KEY-----\n?$/);
    if (!pem) throw Error('Неверный публичный ключ.');
    const der = Uint8Array.from(atob(pem[1].replace(/\n/g, '')), c => c.charCodeAt(0));
    const pub = await crypto.subtle.importKey('spki', der, { name: 'Ed25519' }, false, ['verify']);
    const signature = Uint8Array.from(tx.signature.match(/../g), x => parseInt(x, 16));
    if (!await crypto.subtle.verify('Ed25519', pub, signature, digest)) throw Error('Подпись не прошла проверку.');
    return structuredClone(tx);
  }
  return Object.freeze({ decimal, intent, signed });
})();

// ---------------- единицы (AGIP-9) ----------------
window.AgentcoinWalletUnits = (() => {
  const SCALE = 1000000000n; // 1 AGT = 1e9 mGNT (магент)
  function magentsOf(decimalStr) {
    const [a, b = ''] = String(decimalStr).split('.');
    return BigInt(a) * SCALE + BigInt((String(b).padEnd(9, '0')).slice(0, 9));
  }
  const NOTE = '1 AGT = 1 000 mAGT = 1 000 000 000 mGNT (магент, AGIP-9)';
  function magentsOf(decimalStr) {
    if (!/^\d+(\.\d{1,9})?$/.test(String(decimalStr))) throw Error('Сумма: десятичная запись, до 9 знаков.');
    const [a, b = ''] = String(decimalStr).split('.');
    return BigInt(a) * SCALE + BigInt(String(b).padEnd(9, '0').slice(0, 9));
  }
  function magentsToDecimalStr(mg) {
    const a = mg / SCALE, b = (mg % SCALE).toString().padStart(9, '0').replace(/0+$/, '');
    const dec = a.toString() + (b ? '.' + b : '');
    return dec.replace(/^(\d)\b/, '$1'); // корректная десятичная форма AGT
  }
  function toDecimalStr(mg) { // mAGT-строка с ≤6 знаками после точки
    const a = mg / 1000000n, b = (mg % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
    return a.toString() + (b ? '.' + b : '');
  }
  // AGT-десятичная → {AGT, mAGT, mGNT} (строки; без потери точности)
  function convert(decimalStr) {
    const mg = magentsOf(decimalStr);
    return { AGT: decimalStr, mGNT: mg.toString(), mAGT: toDecimalStr(mg), note: NOTE };
  }
  // из введённой суммы В ЛЮБОЙ единице → decimal AGT (9 знаков, магент-точность)
  function toAGT(value, unit) {
    const s = String(value || '').trim().replace(',', '.');
    if (unit === 'mGNT') { if (!/^\d{1,15}$/.test(s)) throw Error('mGNT (магент): целое число.'); return magentsToDecimalStr(BigInt(s)); }
    if (unit === 'mAGT') {
      if (!/^\d{1,12}(\.\d{1,6})?$/.test(s)) throw Error('mAGT: до 6 знаков после точки.');
      const [i, f = ''] = s.split('.');
      return magentsToDecimalStr(BigInt(i) * 1000000n + BigInt(f.padEnd(6, '0').slice(0, 6)));
    }
    // AGT: валидируем десятичную форму с целочисленной точностью
    if (!/^\d+(\.\d{1,9})?$/.test(s)) throw Error('Сумма: десятичная запись, до 9 знаков после точки.');
    const mag = magentsOf(s); if (mag < 1n) throw Error('Сумма меньше 1 магента.');
    return magentsToDecimalStr(mag);
  }
  return Object.freeze({ convert, toAGT, magentsOf });
})();

// ---------------- компактный QR (byte mode, ECC L, v1-10) ----------------
window.AgentcoinQR = (() => {
  // GF(256), α=2 (стандарт QR). Таблицы.
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (!a || !b) ? 0 : EXP[LOG[a] + LOG[b]];
  const CAP = [17, 32, 53, 78, 106, 134, 154, 192, 230, 271]; // байт ECC L, v1..v10
  const DATA_CW = [19, 34, 55, 80, 108, 136, 156, 194, 232, 274];
  const EC_CW = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18];
  const BLOCKS = [1, 1, 1, 1, 1, 2, 2, 2, 2, 2];
  const ALIGN = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  function rsGen(n) { // старший-первый; product of (x + α^i), i=0..n-1
    let g = [1];
    for (let i = 0; i < n; i++) {
      const a = EXP[i], ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < ng.length; j++) ng[j] = (j < g.length ? g[j] : 0) ^ mul(j >= 1 ? g[j - 1] : 0, a);
      g = ng;
    }
    return g;
  }
  function rsEnc(data, n) { const g = rsGen(n); const rem = new Array(n).fill(0); for (const b of data) { const f = b ^ rem[0]; rem.shift(); rem.push(0); if (f) for (let i = 0; i < n; i++) rem[i] ^= mul(g[i + 1], f); } return rem; }
  function bitStream(bytes, vIdx) {
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    push(4, 4); push(bytes.length, vIdx < 9 ? 8 : 16); // byte mode 0100; charcount 8 бит (v1–9) / 16 бит (v10–)
    for (const b of bytes) push(b, 8);
    const cap = DATA_CW[vIdx] * 8;
    const term = Math.min(4, cap - bits.length); for (let i = 0; i < term; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; out.push(v); }
    for (let p = 0xEC, i = 0; out.length < DATA_CW[vIdx]; i ^= 1, p = i ? 0x11 : 0xEC) out.push(p);
    return out;
  }
  function interleave(data, ecPerBlock, blocks) {
    const dcs = [], ecs = [];
    for (let b = 0; b < blocks; b++) { const part = data.slice(b * (data.length / blocks), (b + 1) * (data.length / blocks)); dcs.push(part); ecs.push(rsEnc(part, ecPerBlock)); }
    const out = [];
    const maxD = dcs[0].length;
    for (let i = 0; i < maxD; i++) for (const d of dcs) out.push(d[i]);
    for (let i = 0; i < ecPerBlock; i++) for (const e of ecs) out.push(e[i]);
    return out;
  }
  function reserve(size, align) {
    const f = Array.from({ length: size }, () => new Uint8Array(size)); // 0 пусто, 1 функция, 2+ данные
    // Финдеры + разделители (3 угла)
    const mark = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const rr = r + i, cc = c + j; if (rr >= 0 && cc >= 0 && rr < size && cc < size) f[rr][cc] = 1; } };
    mark(0, 0); mark(0, size - 7); mark(size - 7, 0);
    const set = (r, c) => { f[r][c] = 1; };
    // тайминг
    for (let i = 8; i < size - 8; i++) { set(6, i); set(i, 6); }
    // выравнивания
    for (const r of align) for (const c of align) { if (f[r][c]) continue; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j); }
    // format-info области (вокруг финдеров) резервируем
    for (let i = 0; i < 9; i++) { set(8, i); set(i, 8); }
    for (let i = 0; i < 8; i++) { set(8, size - 1 - i); set(size - 1 - i, 8); }
    return f;
  }
  function placeData(f, size, codewords, mask, remainderBits) {
    let bitIdx = 0;
    const total = codewords.length * 8 + remainderBits;
    const bitAt = i => (i < codewords.length * 8) ? ((codewords[i >> 3] >> (7 - (i & 7))) & 1) : 0;
    const colPairs = [];
    for (let c = size - 1; c > 0; c -= 2) { if (c === 6) c = 5; colPairs.push(c); }
    let up = true;
    for (const c2 of colPairs) {
      for (let k = 0; k < size; k++) {
        const r = up ? size - 1 - k : k;
        for (const c of [c2, c2 - 1].filter(cc => cc >= 0 && !f[r][cc])) {
          if (bitIdx < total) { let b = bitAt(bitIdx++); const m = maskFn(mask, r, c); if (m) b ^= 1; f[r][c] = 2 + b; }
          else { f[r][c] = 2; }
        }
      }
      up = !up;
    }
    if (bitIdx < total) throw Error('qr_overflow');
  }
  function maskFn(m, r, c) {
    switch (m) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return (r * c) % 2 + (r * c) % 3 === 0;
      case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
      default: return ((r * c) % 3 + (r + c) % 2) % 2 === 0;
    }
  }
  const MASKCOND = [ // канонические предикаты для penalty-независимой проверки
    (r, c) => (r + c) % 2 === 0, (r, c) => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
  ];
  function penalty(f, size) {
    let p = 0; const v = (r, c) => (f[r][c] >= 2) ? (f[r][c] & 1) : 0;
    for (let r = 0; r < size; r++) { let run = 1; for (let c = 1; c < size; c++) { if (v(r, c) === v(r, c - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; } else run = 1; } }
    for (let c = 0; c < size; c++) { let run = 1; for (let r = 1; r < size; r++) { if (v(r, c) === v(r - 1, c)) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; } else run = 1; } }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) { const s = v(r, c); if (s === v(r, c + 1) && s === v(r + 1, c) && s === v(r + 1, c + 1)) p += 3; }
    // pattern 1011101 с 0000 по бокам (упрощённо: N3 по центральной колонке/строке)
    const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const rowCheck = arr => { for (let i = 0; i + 11 <= arr.length; i++) { let ok = true; for (let j = 0; j < 11; j++) if (arr[i + j] !== pat[j]) { ok = false; break; } if (ok) p += 40; } };
    for (let r = 0; r < size; r++) { const arr = []; for (let c = 0; c < size; c++) arr.push(v(r, c)); rowCheck(arr); }
    for (let c = 0; c < size; c++) { const arr = []; for (let r = 0; r < size; r++) arr.push(v(r, c)); rowCheck(arr); }
    let dark = 0; for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += v(r, c);
    p += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
    return p;
  }
  // format info: 5 бит (ECC L=01) + маска; BCH(15,5) generator 0x537; XOR 0x5412
  function formatBits(mask) {
    let d = (0b01 << 3) | mask; d <<= 10;
    let g = 0x537, rem = d;
    for (let i = 14; i >= 10; i--) if (rem >> i & 1) rem ^= g << (i - 10);
    return (((0b01 << 3) | mask) << 10 | rem) ^ 0x5412;
  }
  function drawFormat(f, size, fmt) {
    const get = i => (fmt >> (14 - i)) & 1;
    // Главный блок (top-left): bits 0–5 → (row 8, cols 0–5); bit6 → (8,7); bit7 → (8,8);
    // bit8 → (7,8); bits 9–14 → (col 8, rows 5..0). Все позиции уже зарезервированы.
    const tl = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    tl.forEach(([r, c], i) => { f[r][c] = 2 + get(i); });
    // Копия 1 (right edge): col 8, rows size-1..size-8 ← bits 0..7
    for (let i = 0; i < 8; i++) f[size - 1 - i][8] = 2 + get(i);
    // Копия 2 (bottom edge): row 8, cols size-1..size-7 ← bits 0..6
    for (let i = 0; i < 7; i++) f[8][size - 1 - i] = 2 + get(i);
    // тёмный модуль (всегда чёрный): row 8, col size-8; НЕ совпадает с копией format-info
    f[8][size - 8] = 2 + 1;
  }
  function encode(text) {
    const bytes = Array.from(new TextEncoder().encode(String(text)));
    if (bytes.length > CAP[9]) throw Error('qr_too_long');
    let vIdx = CAP.findIndex(c => bytes.length <= c); if (vIdx < 0) throw Error('qr_too_long');
    const size = 17 + 4 * (vIdx + 1);
    const codewords = interleave(bitStream(bytes, vIdx), EC_CW[vIdx], BLOCKS[vIdx]);
    const remainderBits = (vIdx >= 1 && vIdx <= 5) ? 7 : 0; // остаточные биты: v2–v6 → 7, v7–v13 → 0
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const f = reserve(size, ALIGN[vIdx]);
      drawFormat(f, size, formatBits(mask));
      placeData(f, size, codewords, mask, remainderBits);
      const p = penalty(f, size);
      if (!best || p < best.p) best = { f, p, mask };
    }
    const f = best.f;
    const sketch = Array.from(f, row => Array.from(row, v => v >= 2 ? (v & 1) : null));
    return { size, modules: sketch, mask: best.mask, version: vIdx + 1 };
  }
  return Object.freeze({ encode, formatBits, _rsEnc: rsEnc, _gf: { mul, EXP, LOG }, _self: { CAP, DATA_CW, EC_CW, BLOCKS, ALIGN, code: MASKCOND } });
})();
