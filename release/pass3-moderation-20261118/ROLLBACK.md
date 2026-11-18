# Откат прохода 3 (без потери денег и данных)

Бэкапы на сервере: `/root/deploy-bak-20261118-moderation/` (8 html + Caddyfile),
`/root/Caddyfile.bak-20261118-room`, старые чанки оставлены на месте.

## Откат (по шагам)
1. HTML: вернуть файлы из `<бак>/` в `/srv/agentcoin-empire/current/`
   (`index mine mbc20 docs agent gov jobs shield 404`); удалить `workspace.html`,
   `docs/view.html` (или оставить — без Caddy-маршрутов они невидимы).
2. Caddy: убрать блоки `/workspace` и `/docs/view`, вернуть Caddyfile из бэкапа,
   `caddy validate … && systemctl reload caddy`.
3. Чанки: новые `page-*.js`/`layout-*.js` можно оставить (на них никто не ссылается
   после отката html); при желании удалить по списку из RELEASE прошлого прохода.
4. `tree.json`: вернуть из `/root/deploy-bak-20261118-pass1-room/tree.json.prod`
   (без ссылок room/workspace) — либо оставить: ссылки ведут на существующие файлы.
5. Нода/шлюз/журнал не трогались — рестарт не нужен.

## Запрещено при откате
- Трогать `/var/lib/agt-settlement/*` и `core.mjs`/`node.mjs`/`queue-auth.mjs`.
- `git checkout` всего дерева (только артефакты из бэкапа).
