# Деплой модуля нативных расчётов на agentcoin.work (выполняет владелец)

Цель: публичный маршрут модуля на `https://agentcoin.work/` (шлюз + страница),
подключённый через предназначенный прокси. Ноды и консенсус не трогаем:
ни рестарта `agt-node.service`, ни правок `core.mjs`.

## 0. Что деплоится (из этого репо, коммит см. в SETTLEMENT-документе)
- `agentcoin/sdk/js/mainnet-node-api.mjs`, `mainnet-server.mjs`,
  `mainnet-settlement.mjs`, `settlement-policy.example.json`
- `agentcoin/scripts/ecosphere-staging-serve.mjs` (процесс шлюза `/mainnet/*`)
- `agentcoin/site/ecosphere/mainnet.html` (статика страницы)
- `agentcoin/test/mainnet-node-api.mjs`, `test/mainnet-settlement.mjs` (проверки)

## 1. На сервере: осмотр прокси (перед изменениями)
```bash
cat /etc/caddy/Caddyfile
systemctl list-units --type=service --state=running | grep -Ei 'agt|caddy|agentcoin' || true
```
Найти, каким route голые `/info /balance /tx /tx/preflight /blocks /headers` уходят
на ноду `127.0.0.1:9335`, а `/api/v1/*` — на шлюз-адаптер (`:9336`). Новый маршрут
добавлять рядом, существующие не трогать.

## 2. Процесс шлюза (отдельный systemd-юнит, НЕ в ноде)
```bash
# каталог модуля (пример): /opt/agentcoin-settlement/current  (git checkout нужного коммита)
# политика владельца (создать из settlement-policy.example.json, заполнить лимиты):
#   /opt/agentcoin-settlement/settlement-policy.json   (chmod 600)
sudo tee /etc/systemd/system/agt-settlement.service > /dev/null <<'EOF'
[Unit]
Description=AGT native settlement gateway (read-only node API + signed intake)
After=network.target
[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/agentcoin-settlement/current/agentcoin
Environment=AGT_SETTLEMENT_PORT=18745
Environment=AGT_MAINNET_API=http://127.0.0.1:9335
Environment=AGT_SETTLEMENT_POLICY=/opt/agentcoin-settlement/settlement-policy.json
ExecStart=/usr/bin/node scripts/ecosphere-settlement-gateway.mjs 18745
Restart=always
RestartSec=15
[Install]
WantedBy=multi-user.target
EOF
```
Примечание: `scripts/ecosphere-settlement-gateway.mjs` — тонкая обёртка, выделяемая
из `ecosphere-staging-serve.mjs` (только `/mainnet/*` + `/version`, без TEST-стенда):
создаётся отдельным коммитом до деплоя. Либо деплоить тот же serve-файл — тогда
TEST-маршруты держать закрытыми на loopback (они уже только на 127.0.0.1).

## 3. Caddy: публичный маршрут (внутрь существующего site-блока agentcoin.work)
```caddy
route /mainnet/* {
    reverse_proxy 127.0.0.1:18745
}
```
Статику `mainnet.html` — в существующий статический корень сайта (рядом с
остальными страницами; НЕ новым site-блоком — Caddy отклонит дубль домена).
```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile && sudo caddy reload
```

## 4. Сверка после деплоя (с сервера, затем извне)
```bash
curl -s http://127.0.0.1:18745/mainnet/info | head -c 300; echo
curl -s https://agentcoin.work/mainnet/info | head -c 300; echo
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' https://agentcoin.work/ecosphere/mainnet.html
```
Требования: `/mainnet/info` снаружи 200-JSON от живой ноды (высота = `/info`);
страница 200-HTML именно модуля (не Next-оболочка — сверить первые байты);
`POST /mainnet/submit` с `{"signedTx": …}` без ключа — маршрутизируется;
с `privKey` в теле — `400 private_key_rejected`. Каждый маршрут из capabilities
модуля обязан отвечать 200 — расхождение фиксировать, blanket-фолбэка нет.

## 5. Первый перевод (только так)
1. Владелец задаёт `settlement-policy.json` (лимиты, allowlist, порог ручного
   подтверждения) и называет разрешённый кошелёк + утверждённую сумму.
2. Заказ доводится до `accepted` (приёмка отдельно, эскроу нет).
3. Владелец подписывает ЛОКАЛЬНО (`signTransfer` своим ключом; ключ никуда не
   передаётся) и публикует `signedTx` в `POST https://agentcoin.work/mainnet/submit`.
4. Сдача: orderId, txid, сумма, получатель, `paid:true` при глубине ≥ 6
   (`GET /mainnet/settlements/:id/status`).

## Откат
Остановить юнит + убрать Caddy-route + `caddy reload` (~1 мин). Нода, цепь и
журнал шлюза (`mainnet-settlements.json` — сохранить копию) не затрагиваются.
