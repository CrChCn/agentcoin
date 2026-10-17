// A-8 (аудит AUDIT-20261018-01): Syntax CI раньше проверял только .mjs — 47 модулей и
// 15 встроенных HTML-скриптов аудит проверял вручную. Теперь встроенные скрипты тоже
//是他的 часть гарантии: извлекаем каждый <script> без src, --check'ем каждый отдельно
// (одна ошибка = выход 1). Запуск: node tools/check-html-scripts.mjs [файл.html ...]
// без аргументов — все tracked *.html.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const files = args.length ? args : (() => {
  const out = execFileSync('git', ['ls-files', '*.html'], { cwd: here, encoding: 'utf8' }).split('\n').map(s => s.trim()).filter(Boolean);
  return out.map(f => path.join(here, f));
})();

if (!files.length) { console.log('check-html-scripts: нет html-файлов'); process.exit(0); }

const RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let checked = 0, failed = 0, diagnosed = [];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-html-scripts-'));

for (const f of files) {
  const rel = path.relative(here, f);
  let html;
  try { html = fs.readFileSync(f, 'utf8'); } catch (e) { console.log(`FAIL ${rel}: не читается (${e.code})`); failed++; continue; }
  let idx = 0, found = false;
  for (const m of html.matchAll(RE)) {
    const attrs = (m[1] || '').toLowerCase();
    if (/\bsrc=/.test(attrs)) continue;                 // внешний скрипт — не наш
    if (/\btype=["']?(importmap|application\/(ld\+)?json|speculationrules)/.test(attrs)) continue; // json-блоки не JS
    idx++; found = true; checked++;
    const code = m[2] || '';
    const tmp = path.join(tmpDir, `${rel.replace(/[^\w.-]+/g, '_')}_${idx}.mjs`);
    fs.writeFileSync(tmp, code);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      failed++;
      const msg = String(e.stderr || e.message || '').split('\n').slice(0, 4).join(' | ');
      diagnosed.push(`${rel} #script-${idx}: ${lineOf(html, code, m[0])} — ${msg}`);
    }
  }
  if (!found) console.log(`  ok ${rel}: встроенных скриптов нет`);
}

function lineOf(html, snippet, whole) {
  const pos = html.indexOf(whole);
  return pos >= 0 ? `строка ~${html.slice(0, pos).split('\n').length}` : '';
}

for (const d of diagnosed) console.log(`FAIL ${d}`);
console.log(`check-html-scripts: проверено встроенных скриптов=${checked} файлов=${files.length} провалено=${failed}`);
if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
