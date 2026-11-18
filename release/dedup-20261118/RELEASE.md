# Релиз dedup-20261118 (устранение раздвоения главной)

Коммиты: см. `git log` (ветка redesign-ac, пуш — только по слову владельца).
Деплой: статика `web/out/{mine,jobs,mbc20,agent,docs,gov,shield,workspace}.html + robots.txt + sitemap.xml + _next/*`
-> `/srv/agentcoin-empire/current/`; `index.html` (Next-дубль главной) удалён из публикации (бекап сохранён).
Caddy: `/index` и `/index.html` -> `redir / 308`; catch-all `try_files {path} {path}/` (настоящий 404 вместо лендинга);
`validate OK` + `systemctl reload caddy` дважды (патч + фикс формы redir).

Проверки приёмки: `tools/route-guard.mjs` — PASS; браузерная матрица (контроль): /mine → «Сайт» → / Imperial.
