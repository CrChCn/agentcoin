# agentnet — сетевой слой Agentcoin (v1)

Самостоятельная реализация полного сетевого контура: идентичность ноды, подписанный
P2P-протокол с шифрованием канала, поиск пиров, NAT, headers-first синхронизация,
независимые наблюдатели, версионированный Network API, сайт с SSE, история,
обновления с канарейкой и rollback. Без внешних зависимостей, Node.js >= 20.

```
src/
  identity.mjs    ed25519-ключ, nodeId = agt1+sha256(pubkey), каталог ключей
  envelope.mjs    конверт сообщения, подпись, TTL, replay, лимиты размера
  wire.mjs        TCP-кадры, X25519 ECDH + AES-256-GCM, idle-timeout
  peers.mjs       книга адресов, штрафы, баны по nodeId
  discovery.mjs   static/DNS seeds, сохранённые peers, pex, DHT-lite поиск
  nat.mjs         public-IP probe, NAT-PMP, UPnP IGD, статусы достижимости
  chain.mjs       заголовки/тела, chainwork, reorg, resume, pruning, ENOSPC
  production.mjs  адаптер к боевой цепи AGENTCOIN: genesis, core-правила, checkpoint
  node.mjs        нода: handshake, объявления, синк, локальный API и GUI
  dual-listen.mjs P2P на всех интерфейсах: 0.0.0.0 и [::] на одном порту
  guard.mjs       один процесс на каталог ноды
  truth.mjs       уровни доверия, готовность, классификация форков
  privacy.mjs     публичная проекция, запрет приватных адресов
  indexer.mjs     независимый наблюдатель со своим ключом и историей
  portal.mjs      агрегатор трёх indexer-ов, консенсус, сайт, SSE
  api.mjs         /api/v1/network/* с подписанными ответами
  events.mjs      SSE-шина с sequence number и replay
  history.mjs     история наблюдений, uptime, инциденты, форки
  updates.mjs     подписанные релизы, совместимость, канарейка, rollback
  operator.mjs    паспорта операторов и лимит регистраций
src/site/         витрина сети (network.html/app.js) и локальный GUI ноды
scripts/          node.mjs, indexer.mjs, portal.mjs, demo.mjs,
                  prove-production-sync.mjs, build-portable.mjs, build-installer.mjs,
                  portable-launcher.mjs, guard-main.mjs
installer/        ServiceHost.cs (служба Windows), install.cmd/ps1, uninstall.ps1
dist/             пакеты Windows/macOS и setup.exe (собираются build-*.mjs)
test/             34 теста: unit + живые кластеры
```

## Быстрый старт

```bash
cd agentcoin/agentnet

# живой стенд: 4 ноды, 3 независимых indexer-а, портал и сайт
node scripts/demo.mjs
# SITE http://127.0.0.1:9420/   API /api/v1/network/summary

# отдельно
node scripts/node.mjs    --data ./.data/node1 --port 9336 --seed 127.0.0.1:9337 \
                         --network agentnet-main --publish-endpoint 1 --region EU
node scripts/indexer.mjs --data ./.data/idx-a --api-port 9411 \
                         --seed 127.0.0.1:9336 --network agentnet-main
node scripts/portal.mjs  --data ./.data/portal --port 9420 \
                         --indexer http://127.0.0.1:9411 \
                         --indexer http://127.0.0.1:9412 \
                         --indexer http://127.0.0.1:9413

# тесты
npm test        # node --test --test-concurrency=1 test/*.test.mjs

# боевая цепь: пустая нода B синхронизирует реальный снимок от A, затем новый блок
npm run prove:production

# одноклик-пакеты Windows / macOS + SHA256
npm run build:portable

# установщик Windows (setup.exe со службами) + SHA256
npm run build:installer
```

## Network-порты

```
P2P      0.0.0.0:19444/TCP + [::]:19444/TCP   входящие пиры, IPv4 и IPv6
GUI/API  127.0.0.1:9333                       пульт ноды, только loopback
Шлюз     127.0.0.1:9334                       read-only GET /info, /announce
LAN      UDP 9337                             обнаружение соседей
```

Наружу выставляется только P2P. Пульт управления и шлюз слушают loopback:
смена адреса API на `0.0.0.0` отдала бы интернету управление нодой без пароля.

## Windows: установка службами

`dist/AgentcoinCore-Preview-0.2-win64-setup.exe` — установщик (iexpress), не ZIP:

1. запускает `install.ps1` с правами администратора (UAC);
2. распаковывает payload в `%ProgramFiles%\AgentcoinCore`, данные — в
   `%ProgramData%\AgentcoinCore\data` (цепь, ключ, пиры сохраняются при обновлении);
3. создаёт две службы с автозапуском и `sc failure ... restart`:
   `AgentcoinNode` (нода) и `AgentcoinGuard` (сторож: `/info` каждые 15 с,
   перезапуск после 3 неудач);
4. открывает входящий TCP 19444 и UDP 9337 в firewall для `node.exe`;
5. кладёт ярлыки «Agentcoin GUI» и «Uninstall Agentcoin Core» в меню Пуск;
6. ждёт `/info` и пишет отчёт в `%ProgramData%\AgentcoinCore\install.json`.

```powershell
# состояние после установки
sc query AgentcoinNode; sc query AgentcoinGuard
netstat -ano | findstr :19444
Invoke-RestMethod http://127.0.0.1:9333/info | Select state,inboundPeers,outboundPeers,publicReachable

# удаление (данные сохраняются; -Purge удаляет и их)
%ProgramFiles%\AgentcoinCore\uninstall.ps1
```

Служба запускается через `AgentcoinServiceHost.exe` — собственный хост на
.NET Framework 4 (собирается `csc.exe`), без winsw/nssm и без сети.
Установщик и бинарники не подписаны: сертификата code signing нет.

## Боевая цепь Agentcoin

`src/production.mjs` — адаптер без переписывания консенсуса: `computeBlockHash`,
`hashMeetsDifficulty`, `merkleRoot`, `expectedDifficultyBits`, `blockWork` и
`validateBlockAgainstChain` берутся из `packaging/node/src/core.mjs`. Боевой genesis:
`00026d18205c7c873bd612d6e2480321171eb0cb0b3d06c2c2cb0b17b9188e4e`.

Снимок цепи считается доверенным до checkpoint (tip снимка), его хеш закреплён:
заголовок на этой высоте с другим хешем отклоняется. Все заголовки проверяются
боевыми правилами (SHA256d, PoW, prevHash, ретаргет, chainId), тела до checkpoint —
на целостность и merkle, новые блоки после checkpoint — полным
`validateBlockAgainstChain`.

Исторические особенности боевой цепи зафиксированы явно: у блоков 2 и 3
`merkleRoot` не совпадает с текущей `core.merkleRoot`, а 143 старые подписи в первых
3000 блоках не проходят текущую проверку. Поэтому до checkpoint тела доверенные,
а не переигрываются текущими правилами.

Проверка на loopback (`npm run prove:production`): нода A засевается снимком
53 709 блоков, пустая B догоняет 53 708 заголовков и 53 709 тел по TCP, затем A
майнит блок 53 709 по боевым правилам, и B принимает его строгой проверкой.

## 1. Нода и идентичность

Установка создаёт `keys/`, `chain/`, `peers/`, `logs/`, `state/`, `guard/`.
`nodeId = "agt1" + sha256(SPKI DER)[0..32]`, приватный ключ ed25519 лежит в
`keys/node.key.pem` (0600) и не экспортируется ни одним API. Ключ ноды не равен
кошельку. `guard/node.lock` не даёт запустить второй процесс на том же каталоге
(pid + случайный токен; мёртвый замок перехватывается).

## 2. P2P-протокол

Конверт:

```json
{ "protocol": 1, "type": "HELLO", "messageId": "...", "nodeId": "agt1...",
  "timestamp": 0, "expiresAt": 0, "payload": {}, "signature": "base64url" }
```

Подпись ed25519 по каноническому JSON всех полей кроме `signature`.
Сообщения: `HELLO`, `CHALLENGE`, `PEERS`, `GET_HEADERS`, `HEADERS`, `GET_BLOCKS`,
`BLOCKS`, `TX`, `PING`, `PONG`, `NODE_ANNOUNCE`, `NODE_GOODBYE`.
Лимиты на тип (HELLO 8 KiB … BLOCKS 2 MiB), TTL по умолчанию 120 с, максимальный
TTL 24 ч, окно часов ±120 с, replay-защита по `messageId`.

Рукопожатие:

1. Dialer → `HELLO`: pubkey, X25519 pubkey, подпись эфемерного ключа, nonce, сеть, версия, listen.
2. Listener → `CHALLENGE`: свой ключ, свой X25519, challenge (32 байта).
3. Dialer → `CHALLENGE` (role=response): подписанный challenge + HMAC-подтверждение общего секрета.
4. Обе стороны включают AES-256-GCM; далее весь трафик шифруется, nonce — sequence number.

Проверяются: привязка `nodeId` к ключу, сеть, версия протокола, подпись эфемерного
ключа, HMAC, replay, свежесть, лимиты, rate limit (20 msg/s, burst 60). Нарушения
дают штраф; 100 штрафа → бан на час, бан хранится по `nodeId`.

## 3. Поиск пиров

Источники: hardcoded/static seeds, DNS seeds (`TXT _agentnet._tcp.<host>` формата
`nodeId@host:port` или `host:port`, плюс `SRV`), сохранённые peers, peer exchange
(`PEERS`) и DHT-lite — итеративный поиск ближайших по XOR-расстоянию через
`PEERS { find }`. Seed только знакомит; после знакомства ноды работают напрямую.

## 4. NAT

`nat.mjs` проверяет IPv6, публичный IP (настраиваемый probe), NAT-PMP (RFC 6886,
реальный UDP-обмен) и UPnP IGD (SSDP + SOAP AddPortMapping). Статусы:
`PUBLIC`, `PORT_FORWARDED`, `IPV6_PUBLIC`, `RELAYED`, `OUTBOUND_ONLY`.
Наружу публикуется только статус и флаги; локальные адреса не выводятся.
Входящая достижимость подтверждается отдельно: indexer дозванивается на
объявленный endpoint и фиксирует `dialBack`.

## 5. Синхронизация

Headers-first: `GET_HEADERS {locator, limit}` → `HEADERS`; locator биткойн-типа.
Принимается только цепь с большей суммарной работой; при равной работе reorg нет.
Тела тянутся `GET_BLOCKS`/`BLOCKS` и проверяются по merkle-корню. Есть resume
(цепь читается с диска), восстановление после обрыва записи (битый хвост
отрезается), pruning тел, и безопасная остановка записи при `ENOSPC`/`EDQUOT`
(нода переходит в read-only и сообщает `chain.readOnly`).

## 6. Доверие и Sybil

Уровни: `SELF_REPORTED → CHALLENGE_VERIFIED → PEER_OBSERVED → MULTI_OBSERVED →
PUBLIC_REACHABLE → INDEPENDENT_OPERATOR`.

Нода считается готовой, если: подпись валидна **и** genesis совпал **и** объявление
свежее **и** challenge пройден **и** голову подтвердили ≥2 независимых indexer-а
**и** общий блок совпал. Разные высоты — `LAGGING/ADVANCED`, не форк. Разные hash
на одной высоте — `DIVERGENT/FORK`.

Паспорт оператора подписывается отдельным ключом, содержит список nodeId и лимит
регистраций (5). Число nodeId не выдаётся за число независимых операторов.

## 7. Наблюдатели и сайт

Каждый indexer — отдельный процесс со своим ключом, своими P2P-подключениями и
своей историей; он не проксирует ответы нод как свои. Портал опрашивает три
indexer-а, проверяет их подписи (ключи пинятся по URL), сливает наблюдения,
поднимает `MULTI_OBSERVED`/`PUBLIC_REACHABLE`, считает форки и публикует сайт.

Network API (у indexer-а и у портала):

```
/api/v1/network/summary
/api/v1/network/nodes
/api/v1/network/nodes/:id
/api/v1/network/edges
/api/v1/network/history
/api/v1/network/consensus
/api/v1/network/operators
/api/v1/network/indexers
/api/v1/network/eventlog
/api/v1/network/events      (SSE)
```

Каждый ответ: `schemaVersion`, `kind`, `generatedAt`, `observedAt`, `expiresAt`,
`sourceIndexer`, `data`, `signature`, `pubkey`. Подпись проверяется вместе с
привязкой `sourceIndexer` к ключу.

SSE: `id: <seq>` + `event: <type>`; типы `node.discovered`, `node.handshake`,
`node.sync_progress`, `node.ready`, `node.stale`, `node.offline`,
`peer.connected/disconnected`, `fork.detected/resolved`, `version.outdated`,
`incident`, `update.applied/rolled_back`. При обрыве клиент запрашивает свежий
snapshot и продолжает с `Last-Event-ID`.

Сайт: обзор, карта P2P, ноды, операторы, синхронизация, версии, форки, история,
compute/storage/задачи (пока «нет данных»), инциденты. Локальный GUI ноды —
`http://127.0.0.1:<api>/gui`, управляет только этой нодой.

## 8. Приватность

Публично: nodeId, статус, уровень, версия, высота, tip, peers, uptime, регион
(только при согласии), operatorId, наблюдения. Скрыто: приватные/loopback/CGNAT
адреса, hostname, username, ключи, пути, произвольные поля. `privacy.mjs`
фильтрует endpoint-ы и проверяет ответ на утечки; это закреплено тестом.

## 9. Обновления

Релиз подписывается ключом из `updates.releaseKeys` ноды, содержит версию,
диапазон совместимости протокола, артефакты, `mandatory`, `canaryPercent`,
`rollbackTo`. Нода применяет обновление только если протокол совместим и
nodeId попал в канарейку (или обновление обязательное), сохраняет предыдущую
версию и умеет `rollback`. Локальный API: `/updates`, `/updates/check`,
`/updates/apply`, `/updates/rollback`.

## Проверено тестами (34)

* идентичность, персистентность ключа, каталоги, дефолты;
* подпись/подмена, replay, TTL, лимит размера, чужой ключ;
* discovery: seed-адреса и IPv6, static/saved/pex, DHT-lite по XOR, баны в выдаче;
* подписи Network API (подмена data/kind/срока/ключа) и release-ключи;
* паспорт оператора: подпись, лимит регистраций, реестр;
* handshake, шифрование канала, объявления, RTT, self-connect, чужая сеть;
* бан по nodeId и его персистентность, rate-limit и штраф;
* цепь: chainwork > высота, отказ лёгкой ветки, merkle, resume, битый хвост,
  pruning, ENOSPC → read-only;
* guard: второй процесс на каталоге;
* 2–3 ноды: headers-first, тела, общий tip, догон через посредника, рестарт;
* NAT-PMP на реальном UDP-обмене, статусы PUBLIC/OUTBOUND_ONLY/RELAYED;
* truth: уровни, готовность, форки, merge наблюдателей;
* интеграция: 4 ноды, 3 indexer-а, портал, подписанные ответы, отсутствие
  приватных адресов, SSE, форк и его снятие, паспорт оператора, обновление и
  rollback, отказ indexer-а, отказ сайта, отказ seed-ноды, отказ оператора.

## Ограничения (честно)

* Боевая цепь подключена через `production.mjs`; `packaging/node` не изменялся.
  Снимок до checkpoint доверенный (bootstrap), новые блоки проверяются полностью;
  старые подписи и две merkle-аномалии не переигрываются текущими правилами.
  Сетевого моста к WebSocket-P2P `agentcoin.work` нет: agentnet использует свой TCP.
* `HELLO`/`CHALLENGE` идут открытым текстом; после рукопожатия трафик шифруется
  X25519+ AES-256-GCM. TLS-сертификатов и PKI нет.
* DHT-lite — итеративный поиск по известным пирам, не полноценная Kademlia-таблица.
* UPnP IGD реализован, но на реальном роутере не проверялся (NAT-PMP проверен).
* Sybil-защита — уровни, паспорта, лимит регистраций и репутация; stake/proof of
  resources не реализованы.
* Compute/Storage/Задачи в API v1 не публикуются, разделы сайта честно пустые.
* Сайт раздаётся порталом локально; на `agentcoin.work` не выкладывался.
