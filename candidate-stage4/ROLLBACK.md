# Stage 4 — откат (только из фактического серверного бэкапа)

Откат выполняется только в deploy-окне (этап 5) и только из бэкапа,
снятого по `DEPLOY.md` п.2. Этот ZIP источником отката НЕ является.

## Условия отката

Любое из: `caddy validate` красный после замены; проверки п.5 красные;
вернулся любой из трёх исходных блокеров; staging-запись достигла mainnet.

## Процедура

```bash
# $B — путь бэкапа из DEPLOY.md п.2 (единственный источник истины)
cp -a $B/Caddyfile /etc/caddy/Caddyfile
rm -rf /srv/agentcoin-empire/current && cp -a $B/site-current /srv/agentcoin-empire/current
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
```

## Проверка отката

- `GET /imperial` снова отдаёт прежнее тело (как до окна) — зафиксировано срезом.
- `GET /` и `/agent-room`, `/settlement` — прежние тела.
- `caddy adapt` — порядок как до окна.

## Запрещено при откате

- Восстанавливать «по памяти» или из этого ZIP вместо `$B`.
- Рестартовать ноды и майнер; трогать цепь, балансы, выплаты, ключи.
