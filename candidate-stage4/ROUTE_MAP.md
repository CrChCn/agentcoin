# Stage 4 — карта старый маршрут → новый владелец

Production не изменялся. Таблица описывает кандидат.

| host | public path | method | старый владелец (prod 2026-11-19) | новый владелец (кандидат) | решение |
| --- | --- | --- | --- | --- | --- |
| agentcoin.work | `/` | GET | site-static (imperial.html, 131290 байт) | site-static (candidate index.html, единый shell) | оставить каноном |
| agentcoin.work | `/imperial` | GET | site-static (то же тело — двойник) | 308 `/` (query сохраняется) | закрыть двойник редиректом |
| agentcoin.work | `/imperial.html` | GET | site-static (то же тело — двойник) | 308 `/` (query сохраняется) | закрыть двойник редиректом |
| agentcoin.work | `/agent-room` | GET | agent-room (свой shell) | agent-room (общий shell, модуль сохранён) | унифицировать shell |
| agentcoin.work | `/settlement` | GET | site-static (свой shell) | site-static (общий shell, модуль сохранён) | унифицировать shell |
| agentcoin.work | `/ecosphere` | GET | 404 MODULE_NOT_PUBLISHED, но в навигации | 404, убран из навигации/tree/sitemap, implemented=false | не публиковать до решения |
| api-staging.agentcoin.work | `/working/cabinet/*` (POST/PUT/PATCH/DELETE) | mutation | mainnet-node-1 127.0.0.1:9335 (BLOCKED) | закрыто 404 `staging_mutation_unavailable` | никакого прокси в mainnet |
| api-staging.agentcoin.work | `/working/txproof/*` (GET) | read | два объявления: mainnet-node-1@L35 (effective) + тень env-staging@L44 (WARN OVERLAP) | один владелец env-staging 127.0.0.1:29335 | убрать тень |
| api-staging.agentcoin.work | `/working/node-info`, `/working/identity/meta` | GET | mainnet-node-1 (UNDOCUMENTED) | env-staging 127.0.0.1:29335, внесены в кандидат-реестр | документировать |
| api-staging.agentcoin.work | `/working/balance` | GET | env-staging (UNDOCUMENTED) | env-staging, внесён в кандидат-реестр | документировать |
| agentcoin.work | `/balance`, `/identity/meta`, `/peers/list`, `/peers/health` | GET | mainnet-node-1 (UNDOCUMENTED ×4) | mainnet-node-1, внесены в кандидат-реестр/capabilities | документировать |
| agentcoin.work | `/peers/bootstrap`, `/ops/watchdog/state`, `/gateway/list` | GET | рекламируются, отдают 404 (GHOST ×3) | удалены из capabilities (не рекламируются) | убрать ghost-рекламу |
| agentcoin.work | `/tx`, `/tx/preflight`, `/tx/sign` (POST) | mutation | mainnet-node-1 (документированная подпись) | без изменений | mainnet не трогаем |

Проверка изоляции: на `api-staging.agentcoin.work` кандидата нет ни одного `reverse_proxy 127.0.0.1:9335` и нет `https://node1.agentcoin.work`. Поиск по кандидат-конфигу: `9335` встречается 0 раз.
