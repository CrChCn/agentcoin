# Выкладка рабочих нод A2 (пошагово для оператора, по одному серверу)

## Статус узлов (публично установлено 2026-11-09, A1)

| Узел | Статус | Роль в выкладке |
|---|---|---|
| `agentcoin.work` | **upstream НЕ определён** — какой физический узел обслуживает API, неизвестно | Проверка оператором (ниже); не трогать до подтверждения |
| node1.agentcoin.work | **НЕ подтверждён** — нет в ростере опрашивающей ноды | **Не использовать как обязательный**; только проверки |
| node2 (Hetzner fsn1) | Подтверждён (отвечает, тот же tip) | SEED — первый сервер |
| node3 (DO fra1) | Подтверждён (отвечает, тот же tip) | Второй сервер, пиром к node2 |

Проверка оператором для неподтверждённого (с любого сервера):
`nslookup node1.agentcoin.work`, `curl -s https://node1.agentcoin.work/api/v1/life`,
сверить `tipHash` с node2/node3; `curl -s https://agentcoin.work/api/v1/network/nodes`
— какой узел отвечает как «Эта нода» и есть ли node1 в списке. До совпадения
tip и появления в ростере node1 в mesh не включать.

## Правила выкладки (каждый подтверждённый сервер)

Порядок: сохранить конфигурацию → применить изменение → проверить службу,
цепь, соединения и новые блоки → только потом следующий сервер.
Пиринг, запуск крана и реальные выплаты — ОТДЕЛЬНЫЕ этапы: настройка связи
не зависит от бюджета и включается раньше денежных шагов.

Сохранение перед изменением (на сервере):
```bash
sudo tar -czf /root/agt-backup-$(date +%F).tgz -C /opt/agentcoin data-vps/peers.json data-vps/wallets.json data-agtx 2>/dev/null; ls -la /root/agt-backup-*
```
Проверка после изменения (на сервере):
```bash
systemctl is-active agt-node
curl -s http://127.0.0.1:9335/life | jq '{blocks, tipHash, chainValid}'
curl -s http://127.0.0.1:9335/ws/status | jq '{wsPeers}'
```
Откат (на сервере):
```bash
sudo systemctl stop agt-node
sudo tar -xzf /root/agt-backup-<ДАТА>.tgz -C /opt/agentcoin
sudo chown -R agt:agt /opt/agentcoin && sudo systemctl start agt-node
sleep 10; curl -s http://127.0.0.1:9335/life | jq '{blocks, chainValid}'
```

## Порядок серверов

Порядок важен: сначала seed без пиров, затем остальные — пиром к seed.
Стандартный порт `9335`. Все команды — по SSH от root (Ubuntu/Debian).

## Шаг 0. На каждом сервере (перед деплоем)

```bash
ssh root@<server-ip>
```

## Сервер 1 — node2 (Hetzner fsn1): SEED, без стартового пира

```bash
export NODE_PORT=9335
bash <(curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/deploy-vps.sh) "$NODE_PORT"
# скрипт сам: Node 24, /opt/agentcoin, UFW (SSH + 9335), systemd agt-node, fail-fast /life
systemctl status agt-node --no-pager | head -5
curl -s http://127.0.0.1:9335/life
```

Записать tip: `curl -s http://127.0.0.1:9335/life | jq '{blocks, tipHash, chainValid}'`.

## Сервер 2 — node3 (DO fra1): пиром к node2

```bash
export NODE_PORT=9335
export AGT_BOOTSTRAP_PEER=http://<node2-ip>:9335   # ВНУТРЕННИЙ/публичный IP node2
AGT_BOOTSTRAP_PEER="$AGT_BOOTSTRAP_PEER" bash <(curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/deploy-vps.sh) "$NODE_PORT"
T=$(sudo cat /opt/agentcoin/data-agtx/admin-token.txt)
curl -s -X POST http://127.0.0.1:9335/sync-now -H "x-admin-token: $T" | head -c 400; echo
curl -s http://127.0.0.1:9335/life | jq '{blocks, tipHash}'
# высоты node2/node3 должны совпасть в течение ~90 с (периодический syncAll)
```

## Сервер 3 — node1: пиром к node2 и node3

```bash
export NODE_PORT=9335
export AGT_BOOTSTRAP_PEER=http://<node2-ip>:9335
AGT_BOOTSTRAP_PEER="$AGT_BOOTSTRAP_PEER" bash <(curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/deploy-vps.sh) "$NODE_PORT"
T=$(sudo cat /opt/agentcoin/data-agtx/admin-token.txt)
curl -s -X POST http://127.0.0.1:9335/peer/add -H "x-admin-token: $T" \
  -H 'Content-Type: application/json' -d '{"peer":"http://<node3-ip>:9335"}'
curl -s -X POST http://127.0.0.1:9335/sync-now -H "x-admin-token: $T" | head -c 400; echo
```

## Замыкание mesh (на node2 и node3 добавить друг друга + node1)

На каждом из node2/node3 (loopback + свой токен):

```bash
T=$(sudo cat /opt/agentcoin/data-agtx/admin-token.txt)
for P in http://<node1-ip>:9335 http://<node2-ip>:9335 http://<node3-ip>:9335; do
  curl -s -X POST http://127.0.0.1:9335/peer/add -H "x-admin-token: $T" \
    -H 'Content-Type: application/json' -d "{\"peer\":\"$P\"}"; echo
done
curl -s -X POST http://127.0.0.1:9335/sync-now -H "x-admin-token: $T" | head -c 300; echo
```

Проверка mesh (с любого сервера): все три `/life` — один `tipHash`,
`/ws/status` — `wsPeers > 0`, `/peers/meta` — accepted растёт без strikes.

## Кран A3 (после mesh, на ОДНОЙ ноде — node2)

Фонд крана читается из env при старте, поэтому:

```bash
T=$(sudo cat /opt/agentcoin/data-agtx/admin-token.txt)
# 1) кошелёк фонда:
curl -s -X POST http://127.0.0.1:9335/wallet/create -H "x-admin-token: $T" \
  -H 'Content-Type: application/json' -d '{"label":"faucet-fund","recover":true}'
#    → записать address; mnemonic — один раз оператору
# 2) профинансировать майнингом (3 блока × 50 = 150 AGT):
FUND=<address>; for i in 1 2 3; do
  curl -s -X POST http://127.0.0.1:9335/mine -H "x-admin-token: $T" \
    -H 'Content-Type: application/json' -d "{\"miner\":\"$FUND\"}"; echo; done
# 3) прописать фонд в unit и перезапустить:
sudo sed -i "s|^ExecStart=|Environment=AGT_FAUCET_FUND=$FUND\nExecStart=|" /etc/systemd/system/agt-node.service
sudo systemctl daemon-reload && sudo systemctl restart agt-node
sleep 8; curl -s http://127.0.0.1:9335/life | jq '{blocks, chainValid}'
# 4) проверка выдачи:
curl -s -X POST http://127.0.0.1:9335/faucet/drip -H 'Content-Type: application/json' -d '{"address":"<AGT-адрес>"}'
#    → {"dripped":0.5,...}; повтор → 429 already_dripped_24h
```

Пилотный бюджет крана (решение владельца): 0.5 / 5 / 20 AGT — на стенде
проверены как суммы выплат; дневной лимит крана — 0.5/адрес, 10 адресов/IP.

## Выплаты A4 (на node2, после крана)

Фонд тот же (`$FUND`). Выплаты — подписанные tx с memo `payout:<кому>:<сумма>`.
Повтор того же txid отклоняется (`already_in_chain`) — проверено на стенде.
Шаблон (нужен `core.mjs` из репо + ключ фонда из `data-vps/wallets.json`):

```bash
node commission-payout.mjs http://127.0.0.1:9335   # существующий скрипт, 10 AGT/член
```

Для произвольных сумм — `treasury-payout.mjs` как образец (build/sign/submit +
ончейн-верификация по txid). Реестр получателей и сумм утверждает владелец.

## Что остаётся за владельцем (заблокировано без него)

- Upstream `agentcoin.work`: к какому физическому узлу вести, кто оператор.
- Подтверждение node1 (DNS/роль) — в roster его нет.
- Бюджет пилота крана и реестр выплат A4.
