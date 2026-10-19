#!/usr/bin/env node
// Генератор site/apple-icon.png (180×180): тёмный квадрат + золотая монета + тёмная корона.
// Воспроизводимая графика без зависимостей: RGBA-буфер → zlib deflate → PNG.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = 180;
const px = Buffer.alloc(S * S * 4); // RGBA
const put = (x, y, r, g, b) => { const i = (y * S + x) * 4; px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255; };

// фон: тёмный с лёгкой вертикальной подсветкой
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const t = 1 - y / S; // верх ярче
  put(x, y, Math.round(11 + 16 * t), Math.round(16 + 22 * t), Math.round(32 + 33 * t));
}
const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const inTri = (x, y, p) => {
  const [a, b, c] = p;
  const s = (a[0] - c[0]) * (y - c[1]) - (a[1] - c[1]) * (x - c[0]);
  const t = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
  const u = (c[0] - b[0]) * (y - b[1]) - (c[1] - b[1]) * (x - b[0]);
  return (s >= 0 && t >= 0 && u >= 0) || (s <= 0 && t <= 0 && u <= 0);
};
const GOLD = [230, 179, 64], GOLD_HI = [246, 210, 122], NAVY = [13, 19, 34], NAVY2 = [35, 48, 72];

// монета: тёмный ободок → золото → внутреннее кольцо
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  if (inCircle(x, y, 90, 92, 66)) put(x, y, ...NAVY);                      // ободок
  else continue;
  if (inCircle(x, y, 90, 92, 62) && !inCircle(x, y, 90, 92, 56)) put(x, y, ...NAVY2); // пунктир-кольцо
  if (inCircle(x, y, 90, 92, 56)) {
    const dx = x - 90, dy = y - 92, d = Math.sqrt(dx * dx + dy * dy) / 56;
    const [r, g, b] = d < 0.45 ? GOLD_HI : GOLD; // блик слева-сверху → глубже золота к краю
    const sh = 1 - 0.22 * ((dx + dy) / 56 + 1) / 2 * 0; // упрощённая тень ниже
    put(x, y, Math.round(r * (1 - 0.18 * d)), Math.round(g * (1 - 0.2 * d)), Math.round(b * (1 - 0.26 * d)));
  }
}
// корона (тёмная на золоте): базовая планка + 3 шипа
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  if (x >= 56 && x <= 124 && y >= 100 && y <= 118) put(x, y, ...NAVY);
  if (x >= 62 && x <= 118 && y >= 112 && y <= 116) put(x, y, ...GOLD_HI); // гребень на планке
}
const spikes = [
  [[52, 100], [82, 100], [66, 58]],
  [[76, 100], [104, 100], [90, 44]],
  [[98, 100], [128, 100], [114, 58]],
];
for (let y = 38; y < 100; y++) for (let x = 48; x < 132; x++) {
  if (spikes.some(p => inTri(x, y, p))) put(x, y, ...NAVY);
}
// жемчужины на шипах (золотые точки)
const dots = [[66, 60], [90, 46], [114, 60]];
for (const [cx, cy] of dots) for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  if (inCircle(x, y, cx, cy, 5)) put(x, y, ...GOLD_HI);
}

// PNG: IHDR + IDAT (фильтр 0 на строке) + IEND
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return (buf) => { let c = -1; for (const b of buf) c = t[(c ^ b) & 255] ^ (c >>> 8); return ~c; };
})();
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(root, 'site', 'apple-icon.png');
fs.writeFileSync(out, png);
console.log(`make-pwa-icon: ${out} (${png.length} bytes)`);
