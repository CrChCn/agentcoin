// Инъекция имперской панели (☰ + ⌂) во все витрины site/*.html.
// Запуск: node tools/inject-sidebar.cjs
const fs = require('fs');

const TAG_OPEN = '<script src="/panel.js" defer></script>';
const FILES = ['imperial', 'index', 'terminal', 'jobs', 'dashboard', 'chat', 'jail', 'mbc20', 'cabinet'];

// 1) пропатчить node.mjs: отдать /panel.js как статический файл из tools/
const nodeSrc = fs.readFileSync('node.mjs', 'utf8');
if (!nodeSrc.includes("/p === '/panel.js'")) {
  const anchor = "  if (p === '/imperial' || p === '/imperial.html') {";
  const inj = "  if (p === '/panel.js') {\n    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });\n    return res.end(fs.readFileSync(path.join(__dirname, 'tools', 'imperial-panel.js')));\n  }\n";
  if (!nodeSrc.includes(anchor)) { console.log('node.mjs: anchor not found'); process.exit(1); }
  fs.writeFileSync('node.mjs', nodeSrc.replace(anchor, inj + anchor));
  console.log('node.mjs: /panel.js route added');
} else console.log('node.mjs: route already present');

// 2) прошить script-тег во все витрины
for (const f of FILES) {
  const p = 'site/' + f + '.html';
  if (!fs.existsSync(p)) { console.log(f, 'SKIP'); continue; }
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes('/panel.js')) { console.log(f, 'already'); continue; }
  s = s.replace(/<head([^>]*)>/i, (m) => m + '\n' + TAG_OPEN);
  if (s === fs.readFileSync(p, 'utf8')) { console.log(f, 'FAIL no <head>'); continue; }
  fs.writeFileSync(p, s);
  console.log(f, 'injected');
}
