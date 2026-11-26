#!/usr/bin/env node
/* Сборка модуля эфира в статику сайта, которую реально отдаёт нода:
   site/imperial.html (живая главная, whitelisted в SITE_RELEASE_FILES),
   site/stream.html (короткий роут /stream → блок на главной),
   site/release.json (манифест релиза: новые sha256 + новый release id).

   Идемпотентно: повторный запуск не дублирует секцию, а обновляет её. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');                 // agentcoin/
const SITE = path.join(ROOT, 'site');
const MODULE = path.join(SITE, '_stream-module.html');
const PAGE = path.join(SITE, 'imperial.html');
const AVATAR = path.resolve(ROOT, '..', 'agentcoin-canonical', 'web', 'public', 'stream-assets', 'emperor-3x4.jpg');

// Тот же список, что SITE_RELEASE_FILES в site-release.mjs: манифест валидируется
// строгим равенством ключей, поэтому лишний файл в release.json ломает релиз.
const RELEASE_FILES = ['index.html', 'imperial.html', 'terminal.html', 'dashboard.html', 'chat.html', 'jail.html', 'mbc20.html', 'cabinet.html', 'jobs.html', 'panel.js'];
const MAX_PAGE = 2 * 1024 * 1024;
const BEGIN = '<!-- STRM:BEGIN -->';
const END = '<!-- STRM:END -->';
const ANCHOR = '<!-- ======== ГЛАВНЫЕ ПОКАЗАТЕЛИ ======== -->';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function fail(msg) { console.error('FAIL: ' + msg); process.exit(1); }

if (!fs.existsSync(MODULE)) fail('нет ' + MODULE);
if (!fs.existsSync(AVATAR)) fail('нет аватара ' + AVATAR);

const jpg = fs.readFileSync(AVATAR);
if (jpg[0] !== 0xff || jpg[1] !== 0xd8) fail('аватар не JPEG');
const avatar = 'data:image/jpeg;base64,' + jpg.toString('base64');

let section = fs.readFileSync(MODULE, 'utf8').replace('__AVATAR__', avatar);
section = section.trimEnd();
const block = BEGIN + '\n' + section + '\n' + END;

// --- главная: заменяем прежний блок или вставляем перед показателями ---
let html = fs.readFileSync(PAGE, 'utf8');
const at = html.indexOf(ANCHOR);
if (at < 0) fail('в imperial.html нет якоря ' + ANCHOR);
let out;
const from = html.indexOf(BEGIN), to = html.indexOf(END);
if (from >= 0 && to > from) {
  out = html.slice(0, from) + block + html.slice(to + END.length);
} else {
  out = html.slice(0, at) + block + '\n\n' + html.slice(at);
}
if (Buffer.byteLength(out) > MAX_PAGE) fail('imperial.html больше 2 MiB — не пройдёт лимит релиза');
fs.writeFileSync(PAGE, out);

// --- /stream: короткий роут на модуль главной (файл отдаётся с диска, если раскатан) ---
const streamPage = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Эфир сети · Император Сети — AGENTCOIN</title>
<link rel="canonical" href="https://agentcoin.work/stream">
<meta name="robots" content="noindex,follow">
<script>location.replace('/#stream');</script>
<meta http-equiv="refresh" content="0;url=/#stream">
<style>body{background:#07090d;color:#e8eef5;font:16px/1.6 'Segoe UI',system-ui,sans-serif;padding:40px 22px}
a{color:#f0d78c}</style>
</head><body>
<p>Эфир сети Agentcoin — блок «Император Сети» на главной.</p>
<p><a href="/#stream">Открыть эфир →</a></p>
</body></html>
`;
fs.writeFileSync(path.join(SITE, 'stream.html'), streamPage);

// --- манифест релиза ---
const files = {};
for (const f of RELEASE_FILES) {
  const p = path.join(SITE, f);
  if (!fs.existsSync(p)) fail('нет файла релиза: ' + f);
  const bytes = fs.readFileSync(p);
  if (bytes.length > MAX_PAGE) fail(f + ' больше 2 MiB');
  files[f] = sha(bytes);
}
const manifest = { version: 1, release: 'site-v2-' + crypto.randomBytes(8).toString('hex'), apiVersion: 2, files };
fs.writeFileSync(path.join(SITE, 'release.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('release  ' + manifest.release);
console.log('imperial ' + Buffer.byteLength(out) + ' байт · sha256 ' + files['imperial.html'].slice(0, 16) + '…');
console.log('avatar   ' + Math.round(avatar.length / 1024) + ' KB base64');
console.log('stream   site/stream.html · ' + Buffer.byteLength(streamPage) + ' байт');
