# Привет, друг. AgentCoin за 15 минут — без боли

Ты попал в проект, где чёрт ногу сломит, поэтому вот карта чтобы не утонуть.

## 1. Что это вообще
AGT — своя маленькая крипта + сеть нод на чистом Node.js 24 (ноль npm-зависимостей).
Нода = `node node.mjs` — хранит цепь, принимает переводы, отвечает по HTTP.
Прод уже жив: https://agentcoin.work/ — сначала открой это, потом код.

Живая проверка прод-цепи (реальное, не локальное):
- https://agentcoin.work/info — высота, генезис, supply
- https://agentcoin.work/life — alive/fresh/chainValid/peers
- https://agentcoin.work/headers?from=0&limit=5

## 2. Что тебе передать (и что НЕ передавать)
ДАТЬ:
- git: `https://github.com/CrChCn/agentcoin` (ветка main)
- этот файл + `docs/audit-services.html` (карта внешних зависимостей, только прод)
- `caddy-routes.conf` + `bootstrap.json` (сейчас пустой — пиры настроишь сам)
- `site/habitat.html` — витрина «Рабочий режим / Реальный блокчейн»

НЕ ДАВАТЬ (и не просить):
- `data-agtx/`, `data/`, `wallets.json`, `admin-token.txt`, `pin-auth.json`, `.gh-token`, `filecoin/sdk/wallet.json`
- локальные пути `/root/`, `/srv/`, `/opt/`, `127.0.0.1:11434/9555/8799/26658` — это всё только на прод-сервере, в репо их нет и не надо.

## 3. Запуск своей ноды с нуля (5 минут, никого не сломаешь)
Нужно: Node.js 24 LTS, пустая папка для данных, свой порт.

```bash
git clone https://github.com/CrChCn/agentcoin.git
cd agentcoin
# своя чистая нода, никому не мешает
export NODE_PORT=9335
export AGT_DATA_DIR="$PWD/data-friend"   # ПУСТАЯ папка, не брать чужую data/
export AGT_BIND=127.0.0.1
node node.mjs "$NODE_PORT"
```

В другом терминале:
```bash
export LOCAL_NODE_URL="http://127.0.0.1:9335"
curl -fsS "$LOCAL_NODE_URL/health"
curl -fsS "$LOCAL_NODE_URL/life"
# захочешь к живой сети — попроси у владельца PEER_URL, потом:
# curl -X POST "$LOCAL_NODE_URL/peer/add" -H 'Content-Type: application/json' --data-binary '{"peer":"PEER_URL"}'
# curl -H "x-admin-token: $AGT_ADMIN_TOKEN" "$LOCAL_NODE_URL/sync-now"
```

Правила:
- 1 нода = 1 порт + 1 пустая DATA_DIR. Не запускай на чужой data/ — убьёшь цепь.
- Без пиров ты просто локальный стенд, это нормально для старта.
- Токен `AGT_ADMIN_TOKEN` — только твой, никому не передавать.

## 4. Карта кодовой базы — куда смотреть
- `node.mjs` — HTTP-роутер + WS-hub, вход всего
- `core.mjs` — цепь, мемпул, PoW, эскроу, балансы → `chain.json`
- `sync.mjs / ws.mjs` — синк headers-first / gossip
- `miner-client.mjs / auto-miner.mjs` — майнеры
- `site/` — сайт (`imperial.html`, `dashboard.html`, `habitat.html`, `tree.json` — каноническое дерево)
- `site-release.mjs` — автосинк сайта с GitHub raw каждые 10 мин
- `scripts/prune-memos.mjs` — пруны memo в Celestia (mocha-5, ns 0x61676e61)
- `docs/audit-services.html` — открой в браузере, там вся инфра: Porkbun/Hetzner/Vercel/DO, Celestia, Filecoin, Moltbook
- `docs/JOINING.md` — полная инструкция на 15 мин
- `agt-c/sync-verify.sh` — C-верификатор цепи (нужен `libssl-dev`)

Сайт-маршруты прод-ноды:
`/` ` /dashboard` ` /cabinet` ` /terminal` ` /create-wallet` ` /chat` — всё это отдаёт та же нода.

## 5. Как не облажаться в первый день
1. Не коммить секреты. `.gitignore` уже режет `wallets.json`, `admin-token.txt`, `.gh-token` — не обходи.
2. Не трогай прод-сервер (Hetzner H1 2.31.145.160, H2 91.99.191.236, DO 64.225.104.125) без владельца.
3. Не меняй `habitat.html` витрину — там только «Рабочий режим / Реальный блокчейн», лишнее уже вычищено.
4. Сначала добейся `chainValid:true` на своей локальной `/life`, потом проси peer на прод.

Если запутался — начни с двух страниц: `README.md` (Быстрый старт) + открой `docs/audit-services.html` в браузере. Остальное — потом.

Владелец: скинь другу ссылку на репо + этот файл. Этого хватит чтобы он сам поднял ноду и офигел от сайта, а прод не ляжет.
