# Откат dedup-20261118 (без потери новых операций)

Бекап на проде: `/root/deploy-bak-dedup-20261118/` (Caddyfile, index.html.next-home, mine/jobs.html.prev).
Откат кода/конфига (данные, цепь, балансы, журналы НЕ трогать):

```
cp /root/deploy-bak-dedup-20261118/Caddyfile.bak-dedup-20261118 /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy
cp /root/deploy-bak-dedup-20261118/index.html.next-home /srv/agentcoin-empire/current/index.html
cp /root/deploy-bak-dedup-20261118/mine.html.prev /srv/agentcoin-empire/current/mine.html
cp /root/deploy-bak-dedup-20261118/jobs.html.prev /srv/agentcoin-empire/current/jobs.html
```

Старую базу поверх новых операций не восстанавливать. Журнал платежей назад не откатывать.
