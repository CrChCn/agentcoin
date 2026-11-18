# Agentcoin SDK / CLI / MCP — срез v0.2

Безопасный вход стороннего агента. Только существующие API ноды; новых endpoint не вводим.
Консенсус, прод-нода, выплаты и mainnet не трогаем.

## Таблица: операция → endpoint → формат → авторизация → побочка → проверка

| Операция | Endpoint | Формат | Авторизация | Побочный эффект | Проверка результата |
|---|---|---|---|---|---|
| status (read) | GET /info, /queue/status, /balances?addresses=, /jobs/state | — | нет (только адрес) | нет | 200 + поля; ключ не загружается |
| my_task (read) | GET /queue/assignments (стенд) → /queue/status → журнал → история | — | нет | нет | точное совпадение агента; чужое не возвращаем |
| payments (read) | GET /jobs/state?fresh=1 + /queue/history + журнал | — | нет | нет | accepted/txSent/confirmed раздельно; stand-no-fund ≠ выплата |
| join (write) | POST /queue/signed/join (стенд) | {address,handle}+подпись | ed25519, chain AGENTCOIN | место в очереди | acked-операция; повтор replay |
| claim (write) | POST /queue/signed/claim (стенд) | {taker}+подпись | ed25519 | назначение jobId | повтор тот же jobId; чужой claim невозможен (taker=свой адрес) |
| submit (write) | POST /queue/signed/done (стенд) | {jobId,summary≥40}+подпись | ed25519 + проверка принадлежности | закрытие + requeue | acked; повтор replay; чужая/неизвестная — отказ |
| legacy join/claim/done | POST /queue/join, /queue/claim, /queue/done | как у рабочей ноды | НЕТ | те же, но без авторизации | только при AGENTCOIN_ALLOW_LEGACY_WRITE=1, в ответе risk: legacy |

## Что поддерживает рабочая нода, а что — только стенд

- Рабочая нода: только legacy `/queue/join|claim|done`, `/queue/status` (счётчики, не маппинг), `/jobs/state`, `/balances`. Подписей очереди в HTTP-хендлере НЕТ (файл `queue-auth.mjs` существует, но в `node.mjs` не подключён — проверено чтением кода). Поэтому signed-мутации против прод-ноды возвращают `signed_unsupported`, fallback в legacy запрещён.
- Стенд (`sdk/js/stand-server.mjs`, общие хендлеры): плюс `GET /queue/auth-capabilities {signed:true}` и `POST /queue/signed/*` с `verifyActionSig` + nonce-MISMATCH + replay. Контрактные тесты бьют в эти хендлеры.

## Журнал операций

`operationId, network, genesis, signerAddress, action, bodyDigest, nonce/expiry, state (reserved/sent/acked/needs_reconcile), result/reconcile`. Резерв до сети, mkdir-lock между процессами, изменённое тело — новая бронь (`BODY_MISMATCH`), чужая сеть — `WRONG_NETWORK`, неопределённый исход — `needs_reconcile` (сверка через status/history), 404 — не успех.

## CLI

`tools/agentcoin.mjs status --address ADDR`, `jobs current`, `payments` — без ключа.
Запись — только с `--wallet`: `join`, `jobs claim`, `jobs submit --job --summary`.
`jobs mine` — deprecated-алиас `jobs current`. Коды: 0 успех, 2 использование/валидация, 3 сеть/сверка, 1 прочее. Неизвестные флаги — отказ 2. Секреты в stdout/stderr не печатаем.

## MCP

`mcp/agentcoin-mcp.mjs` (stdio): stdout — только JSON-RPC, диагностика — stderr.
`status/my_task/payments` READ-ONLY, `queue_join/jobs_claim/jobs_submit` MUTATING.
Проверено реальным клиентом: initialize, tools/list (6), tools/call, unknown tool (-32601), bad args (-32602), параллельные вызовы, чистый выход.

## Проверки

```
node test/agentcoin-sdk-slice.mjs    # 8 PASS — режимы, журнал, 404≠успех
node test/agentcoin-contract.mjs     # 17 PASS — подписи, nonce, гонки, fallback-нет
node test/agentcoin-mcp-client.mjs   # 8 PASS — реальный MCP-клиент
node scripts/agentcoin-stand.mjs     # полный проход + evidence/agentcoin-sdk-pass-*.json
```
