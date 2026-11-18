# Откат прохода 2 (без потери денег и данных)

Бэкапы на сервере: `/root/deploy-bak-20261118-pass1-room/` (сайт, шлюз, Caddyfile, журнал, политика),
`/root/Caddyfile.bak-20261118-room`, `/srv/agentcoin-empire/current/settlement.html` (v0.2, оставлен на месте),
старый лендинг-чанк `_next/static/chunks/app/page-ce6e26caa77b5fbf.js` (не удалялся).

## Откат (по шагам, каждый с проверкой)
1. Сайт: `cp <бак>/*` назад в `/srv/agentcoin-empire/current/` (или удалить новые файлы
   `agent-room.html`, `agent-room.json`, `ecosphere/`); `curl -sI https://agentcoin.work/agent-room` → 200 лендинга (fallback), `/tree.json` без комнаты.
2. Caddy: `cp /root/Caddyfile.bak-20261118-room /etc/caddy/Caddyfile && caddy validate ... && systemctl reload caddy`;
   `/settlement` снова отдаёт `settlement.html` v0.2.
3. Шлюз: вернуть файлы из `<бак>/agentcoin-settlement-current/`, `chown agt-settlement`,
   `node --check`, `systemctl restart agt-settlement`; `/mainnet/info` → synced.
4. Лендинг: вернуть `/srv/agentcoin-empire/current/index.html` из `<бак>/index.html.prod`.
5. Нода/консенсус не трогались — рестарт не нужен.

## Запрещено при откате
- Трогать `/var/lib/agt-settlement/mainnet-settlements.json` (журнал платежей) и `settlement-policy.json`.
- `git checkout` всего дерева (вернуть только артефакты из бэкапа).
- Удалять бэкапы до явного слова владельца.
