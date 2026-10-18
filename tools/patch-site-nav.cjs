// Migration: remove old navigation injected by this tool. A shared site keeps
// relative links on its own origin; it never redirects a visitor to loopback.
const fs = require('node:fs');
for (const f of ['imperial', 'index', 'terminal', 'jobs', 'dashboard', 'chat']) {
  const p = 'site/' + f + '.html';
  if (!fs.existsSync(p)) continue;
  const before = fs.readFileSync(p, 'utf8');
  const after = before.replace(/<script>\s*\/\* Авто-навигация:[\s\S]*?<\/script>/g, '');
  if (after !== before) { fs.writeFileSync(p, after); console.log(f, 'removed legacy navigation'); }
}
