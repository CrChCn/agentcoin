#!/usr/bin/env node
// Генератор маршрутов Caddy из канонического дерева (site/tree.json).
// Зачем: прод-конфиг перечисляет страницы вручную, и всё, что в список не попало,
// уезжает в catch-all — пользователь видит лендинг вместо /dashboard или /mine.
// Здесь маршруты строятся из дерева, поэтому новый узел нельзя забыть.
//
// Запуск: node tools/gen-caddy-routes.mjs [--out caddy-routes.conf]
// Результат — готовые route-блоки для site-блока agentcoin.work. Ставить их нужно
// ВЫШЕ wildcard-прокси /api/* и выше catch-all try_files, иначе они не сработают.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outPath = path.join(root, outIndex >= 0 ? args[outIndex + 1] : 'caddy-routes.conf');
const SITE_ROOT = '/srv/agentcoin-empire/current/site'; // прод-корень статики (см. шапку конфига)
const tree = JSON.parse(fs.readFileSync(path.join(root, 'site', 'tree.json'), 'utf8'));

const lines = [];
lines.push('# ⚜ Маршруты сайта AGT для Caddy — сгенерировано tools/gen-caddy-routes.mjs');
lines.push('# Источник правды: site/tree.json. Не править вручную: перегенерируй после правки дерева.');
lines.push('#');
lines.push('# Как применять: вставить блоки ниже ВНУТРЬ существующего site-блока agentcoin.work');
lines.push('# ПЕРЕД wildcard-прокси /api/* и перед catch-all (try_files … /index.html).');
lines.push('# Порядок важен: Caddy исполняет route по первому совпадению.');
lines.push('#');
lines.push(`# Корень статики ниже — ${SITE_ROOT}. Если на сервере другой путь, поменяй root во всех блоках.`);
lines.push('# Проверка после деплоя: node tools/check-site-live.mjs --base https://agentcoin.work');
lines.push('');
lines.push(`https://agentcoin.work {`);
lines.push(`\t# --- страницы дерева: ${tree.sections.reduce((n, s) => n + s.links.length, 0)} узлов ---`);

const reserved = new Set(['/']); // корень обслуживает сам лендинг-роут, отдельный блок не нужен
for (const section of tree.sections) {
  lines.push(`\t# ${section.icon} ${section.title}`);
  for (const link of section.links) {
    if (link.generated) {
      lines.push(`\t# ${link.href} — страницу собирает код ноды; проксируй её так же, как /api/*`);
      continue;
    }
    if (reserved.has(link.href)) continue;
    lines.push(`\troute ${link.href} {`);
    lines.push(`\t\troot * ${SITE_ROOT}`);
    lines.push(`\t\trewrite * /${link.file}`);
    lines.push(`\t\tfile_server`);
    lines.push(`\t}`);
  }
}

lines.push('');
lines.push('\t# --- служебное ---');
lines.push('\t# Каноническое дерево: /tree.json обновляет вшитую копию в panel.js без пересборки.');
lines.push('\troute /tree.json {');
lines.push(`\t\troot * ${SITE_ROOT}`);
lines.push('\t\tfile_server');
lines.push('\t}');
lines.push('\t# /docs/*.md (Rust-кошелёк, SDK, seed-ноды) уже отдаётся прод-конфигом — не перекрывай.');
lines.push('\t# /mempool — контент-негоциация: человеку HTML, API — JSON (роут ноды).');
lines.push('\t# Не перекрывай его статикой: иначе fetch от API получит HTML.');
lines.push('}');

fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`gen-caddy-routes: ${outPath} — ${tree.sections.reduce((n, s) => n + s.links.length, 0)} узлов`);
