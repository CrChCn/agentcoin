# Откат Shield v0.3

1. `cp -a /root/deploy-bak-shield-v03-20261118/shield.html /root/deploy-bak-shield-v03-20261118/shield.txt /srv/agentcoin-empire/current/`
2. Caddy: `cp -a /root/Caddyfile.bak-shield-v03-20261118 /etc/caddy/Caddyfile && caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile && systemctl reload caddy`
3. Проверить: `curl -sk https://agentcoin.work/shield -o /dev/null -w '%{http_code}\n'` и остальные маршруты.
