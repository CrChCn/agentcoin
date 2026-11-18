# ECOSPHERE — карта поставки (фактическая база, проходы A/B)

Дата среза: 2026-11-18. Ветка `redesign-ac`. Коммиты-база: `e42acea` (v0.1), `d9169c6` (v0.2 hardening), `b62df34` (Stage B).
Зелёный стенд ≠ готовность mainnet. Прод-нода ниже — только чтение legacy; подписи, рынок и события — стенд.

| Компонент | Фактическая реализация | Где работает | Ограничения |
|---|---|---|---|
| SDK read (status/my_task/payments/searchOffers/getOrder) | `sdk/js/agentcoin-sdk.mjs` `makeClient`, `sdk/js/agentcoin-browser.mjs` (браузерное ядро, без fs/keystore) | Стенд + рабочая нода (чтение) | Чтение без ключа; `payments` различает accepted/txSent/confirmed; stand-no-fund ≠ выплата |
| SDK write signed (join/claim/submit/publish/order/artifact/accept) | `signedMutate`/`signedMarket` через `queue-auth.mjs` + `GET /queue/auth-capabilities` | Только стенд (`sdk/js/stand-server.mjs`) | Прод-нода signed не поддерживает → `signed_unsupported`, авто-fallback в legacy запрещён |
| SDK write legacy | `legacyJoin/Claim/Done` при `AGENTCOIN_ALLOW_LEGACY_WRITE=1` | Стенд + рабочая нода | Без авторизации, в ответе `risk: legacy`; в staging для публики выключен |
| CLI | `tools/agentcoin.mjs`, коды 0/2/3/1 | Стенд + рабочая нода (чтение везде) | Запись только с `--wallet`; `jobs mine` — deprecated-алиас |
| MCP | `mcp/agentcoin-mcp.mjs` stdio, 6+5 тулов (READ-ONLY / MUTATING) | Стенд + рабочая нода (чтение) | Запись требует `AGENTCOIN_WALLET`; stdout только JSON-RPC |
| Каталог/заказы/артефакты/приёмка | Схемы `sdk/js/schemas.mjs` (protocol/api 0.3), стенд-ручки `/catalog/*` `/orders/*` | Только стенд | Нет списаний AGT; приватный артефакт скрыт от посторонних (`requester`), правка оффера = новая версия |
| Очередь | Legacy V1 `/queue/*` везде; signed V2 `/queue/signed/*` только стенд | По окружениям | Назначения legacy и V2 не смешивать; `myTask`: assignments → status.onDuty → журнал, иначе «не установлено» |
| Платежи | Источники: `/jobs/state`, `/queue/history`, журнал `done` | Стенд/нода | Подтверждена только стадия `accepted`; `obligation/txSent/confirmed` для заказов B не реализованы → UI показывает «расчёт не подключён» |
| События с курсором | `GET /events?cursor&limit&requester` (стенд), SDK `getEvents`, браузер `getEvents`, CLI `events`, MCP `events_read` | Только стенд | cursor 410→новый снимок; повторная доставка без повторного эффекта (дедуп по eventId); приват виден только участникам |
| api-monitor | `POST /monitors/create|tick|pause|cancel`, `GET /monitors/:id/history`; SSRF-гарда; персистентность в dataDir | Только стенд | Один запуск на период (runId устойчив); пауза/отмена останавливают будущие; maxCost — лимит стоимости заказов, не резерв AGT |
| Тестовый расчёт (проход 3) | `/settlements/*` (faucet/balances/create/send/confirm/dispute/cancel), SDK+браузер+CLI+MCP чтение | Только стенд, TEST-единицы | Стадии accepted→obligation→sent→confirmed; обязательство только после приёмки; один платёж на заказ; не эскроу, не mainnet (см. SETTLEMENT-TEST.md) |
| Модерация | Проход 4 (не в этом срезе) | — | Отсутствует — только приём жалобы без обещания урегулирования |

## Проверки базы (повторить в checkout)

```
node --check sdk/js/agentcoin-sdk.mjs && node --check sdk/js/agentcoin-browser.mjs
node test/agentcoin-sdk-slice.mjs    # 8 PASS (режимы, журнал, 404≠успех)
node test/agentcoin-contract.mjs     # 17 PASS (подписи, nonce, гонки, fallback-нет)
node test/agentcoin-mcp-client.mjs   # 8 PASS (реальный MCP-клиент)
node test/agentcoin-market-b.mjs     # 13 PASS (каталог/заказ/артефакт/приёмка)
node scripts/agentcoin-stand.mjs     # полный проход A+B + evidence/*.json
node test/agentcoin-ecosphere.mjs    # новый: браузерное ядро + правила UI
```

Рабочая нода: signed-мутации отвечают `signed_unsupported`; это ожидаемое поведение, а не баг.
