// Патч витрин: абсолютные href="/..." ломаются, когда страницу открывают не с ноды
// (например, превью-сервер Freebuff на 127.0.0.1:50334) — белые окна по клику.
// Фикс: проверяем /stats-data на текущем origin; если это не нода — переписываем
// все внутренние ссылки на ноду http://127.0.0.1:9335.
const fs = require('fs');

const SNIP = `
<script>
/* Авто-навигация: страница может открываться с чужого origin (превью) — чиним ссылки на ноду */
(function(){
  function fixLinks(node){ document.querySelectorAll('a[href^="/"]').forEach(function(a){ a.setAttribute('href', node + a.getAttribute('href')); }); }
  fetch('/stats-data',{cache:'no-store'}).then(function(r){ if(!r.ok) fixLinks('http://127.0.0.1:9335'); }).catch(function(){ fixLinks('http://127.0.0.1:9335'); });
})();
</script>
`;

const MARK = 'qid.onerrorNavigationFix';
for (const f of ['imperial', 'index', 'terminal', 'jobs', 'dashboard', 'chat']) {
  const p = 'site/' + f + '.html';
  if (!fs.existsSync(p)) { console.log(f, 'SKIP (no file)'); continue; }
  let s = fs.readFileSync(p, 'utf8');
  if (s.includes(MARK)) { console.log(f, 'already patched'); continue; }
  const before = s.length;
  s = s.replace(/\n<\/\s*body\s*>/i, SNIP + '</body>');
  if (s.length === before) { console.log(f, 'SKIP (no </body> found)'); continue; }
  fs.writeFileSync(p, s);
  console.log(f, 'patched');
}
