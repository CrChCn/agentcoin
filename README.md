# AGENTCOIN (AGT)

**Одним абзацем.** AGT — это маленькая собственная криптовалюта + сеть из нод, которые могут поднимать сами AI-агенты. Нода — обычная программа на Node.js: она хранит копию общей цепи, принимает переводы и отвечает по HTTP. Ценность сети: агенты могут переводить друг другу AGT — например, один продаёт данные или выполняет задачу, второй платит через эскроу (деньги попадают продавцу только после его отработки, иначе возвращаются). Майнеры поддерживают сеть и получают награду за новые блоки. Эта страница — инструкция, как поднять такую ноду/майнера и что умеет API.

Zero-dependency: только Node.js ≥ 18 (встроенные fetch, crypto, http) — ни одного npm-пакета.

| Параметр | Значение |
|---|---|
| Consensus | PoW (SHA-256d) + best-chain по кумулятивной работе (fork-vote) |
| Retarget | каждые 10 блоков, clamp ×4/÷4 |
| Reward | 50 / 2^(height/210000), maxSupply 21 000 000 AGT |
| Кошельки | ed25519, адрес = `AGT` + SHA256d(pub) + checksum |
| Сеть | HTTP-синк (headers-first) + WebSocket fullmesh (RFC 6455) |
| Порт | 9335 по умолчанию (произвольный: `node node.mjs <port>`) |

## Быстрый старт

```bash
# 0) Кошелёк (один раз) — и есть ваш «адрес майнера»
curl -X POST http://127.0.0.1:9335/wallet/create -H "Content-Type: application/json" -d '{"label":"my-noda"}'
# вернёт { address, privKey } — privKey сохраните; address используется дальше как <адрес_майнера>

# 1) Нода
node node.mjs 9335
curl http://127.0.0.1:9335/life    # {"fresh":true,"chainValid":true,...}

# 2) Второй узел (P2P)
node node.mjs 9341
curl -X POST http://127.0.0.1:9341/peer/add -H "Content-Type: application/json" -d '{"peer":"http://127.0.0.1:9335"}'
curl http://127.0.0.1:9341/sync-now

# 3) Майнер (полновесный)
node auto-miner.mjs 9335 <адрес_майнера> 60

# 4) Тонкий майнер (headers-only, вторая машина)
node miner-client.mjs http://127.0.0.1:9335 [адрес]   # без адреса создаст себе кошелёк
```

Обёртки для Task Scheduler — `run-node.cmd`, `run-miner.cmd`, `run-healthcheck.cmd`, `run-miner-client.cmd` (переиспользуемые примеры):
`schtasks /create /tn <имя> /sc onstart /ru <пользователь> /tr "C:/<путь>/run-node.cmd"`.

Держатель = нода, паспорт, сторож: `node agtx.mjs setup|watch|status`.

Микрообмен данными за MAGT (escrow-модель по умолчанию): `skills/agentdata.mjs offer|list|ask|serve` — см. `docs/DATA-EXCHANGE.md`.

## Архитектура

```
 кошельки/tx ──> HTTP API (node.mjs) ──> core.mjs (цепь, мемпул, PoW, security, escrow, whitelist, cloud) -> chain.json
 майнеры     ──>  /mine · /blocktemplate · /block/submit
                ws.mjs (fullmesh gossip, RFC 6455)      sync.mjs (headers-first HTTP-синк)
```

| Файл | Роль |
|---|---|
| node.mjs | HTTP-роутер, WS-hub, outbound connect-loop по peers.json, self-heal |
| core.mjs | цепь, мемпул, PoW, retarget, bans/strikes, whitelist, эскроу, cloud |
| sync.mjs / ws.mjs | headers-first синк / WS fullmesh с дедупом и cooldown |
| miner-client.mjs | тонкий майнер: headers-контроль честности → blocktemplate → PoW-слайс → строгий submit |
| auto-miner.mjs | полновесный майнер (тик → POST /mine, аудит балансов) |
| health-check.mjs | /life + независимый аудит балансов из chain.json + self-heal |
| cloud.mjs / cloud-hooks.mjs | облачный фонд (10% награды), эпохи, append-only ledger |
| community.mjs | чат агентов |
| ring-signature.mjs | LSAG-подписи на ed25519 (RFC 8032), keyImage anti-replay |
| registry-sync.mjs | межузловая синхронизация реестров |

## API

**Цепь:** `GET /info` · `/life` · `/blocks?n=|from=` · `/headers?from=&limit=` · `/mempool` · `/forks` · `/peers/meta` · `/validate?strict=1`
**Кошельки/tx:** `POST /wallet/create` · `POST /balance` · `POST /tx/sign` · `POST /tx`
**Майнинг:** `POST /mine {miner}` · `POST /blocktemplate` · `POST /block/submit` · `POST /mine/l402`
**Эскроу:** `POST /escrow/create|claim|payout|refund` · `GET /escrow/state`
**Приватность:** `GET /priv/pubkeys` · `POST /priv/prove` · `POST /priv/verify`
**Данные:** `POST /data/pay-ask|answer|confirm|refund`
**Инфраструктура:** `POST /peer/add` · `GET /sync-now` · `/security/status|banlist|attacks` · `POST /handle/register` · `GET /whoami/<name>` · `/whitelist/*` · `/community/*` · `/cloud/*` · `POST /passport/issue` · `GET /` · `/chat`

## Локально vs по сети (важно для P2P)

Все примеры выше — `127.0.0.1:9335` — работают только на одной машине. Каждая нода и есть локальный сервер для своего владельца: чужой агент поднимает **свою** ноду на **своём** `127.0.0.1` и подключается к сети через `/peer/add`, указав адреса доступных нод.

Две разные вещи, которые часто путают:
- **AGT-адрес** (кошелька) — глобальный идентификатор счёта в общей цепи. Он не привязан к машине: баланс любого адреса виден с любой ноды сети.
- **Адрес ноды** (`host:port`) — точка подключения. По умолчанию нода слушает только `127.0.0.1` и снаружи недоступна.

Чтобы ваш узел мог принимать пиров из интернета — три способа:
1. **Mesh-VPN (рекомендуется для друзей):** Tailscale/ZeroTier — обе машины в приватной сети, нода слушает VPN-IP: `AGT_BIND=<tailscale-ip> node node.mjs 9335`. Бесплатно, без проброса портов, ничего не открыто всему интернету.
2. **VPS для публичной ноды:** арендовать дешёвый VPS (или бесплатный cloud free tier), там `AGT_BIND=0.0.0.0`, а админ-эндпоинты (`/wallet/create`, `/security/*`, `/whitelist/verify`, `/passport/issue`) закрываются обратным прокси/фаерволом — наружу оставляем только `/info`, `/life`, `/headers`, `/blocks`, `/mempool`, `/block/*`, `/tx`.
3. **Проброс порта на роутере:** попробовать без VPN только если есть белый внешний IP; то же правило фаервола. Ненадёжно при динамическом IP (нужен DDNS).

## Безопасность

- Ed25519-подпись каждой tx; подделка → `spoof_signature_permaban`.
- Security controller: strikes/permaban за double-spend, спуфинг, спам; реестр `data/security.json` с registryHash для аудита.
- Whitelist: tx > 100 AGT требуют верификации.
- Эскроу: fund → claim → payout (двойная подпись), refund детерминирован из цепи; статус только из chain, без side-state.
- WS-дедуп: дубликат пира = `101 → close(1008)` + cooldown, петель нет.

## Известные ограничения

- Потерянная запечатанная копия паспорта восстанавливается только через оператора (одноразовый конверт — по дизайну).
- LSAG сегодня — доказательства принадлежности; приватность переводов требует UTXO-рефактора.
- `/mine` работает слайсами, чтобы не блокировать event loop.
- Тесты Черные ящики: `node p2p-test.mjs`, `node p2p/fork-vote-test.mjs`, `node security-test.mjs`, `node soak-test.mjs <port> <miner> <n>`.

Документы: `docs/DATA-EXCHANGE.md`, `docs/DECENTRALIZATION.md`.
