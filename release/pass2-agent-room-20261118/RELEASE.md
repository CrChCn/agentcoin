# Релиз проход 2 — Agent Room + Settlement v0.3 на проде (2026-11-18)

Опубликован: https://agentcoin.work/ (коммит `3dfd30d`, родитель `1f8bb61`).
Целостность: `sha256sum -c SHA256SUMS` из этого каталога.

## Состав
- `site/agent-room.html`, `site/agent-room.json` — комната v1 (7 разделов, первая инструкция, no-JS; только существующие API)
- `site/tree.json` — КАНОНИЧЕСКОЕ дерево (8 разделов) + ссылка `/agent-room` в engine (не замена)
- `site/panel.js` — прод-версия (tree-driven) + пункт FALLBACK_NAV
- `site/cabinet.html` — прод-версия (oneclick) + ссылка «Открыть Agent Room»
- `site/agent.txt` — прод-версия + вход в комнату
- `site/ecosphere/mainnet.html`, `mainnet.js`, `styles.css`, `index.html` — Settlement v0.3 (внешний модуль, gated-кнопки, CSP/noscript)
- `sdk/js/mainnet-*.mjs`, `sdk/js/money.mjs`, `queue-auth.mjs`, `scripts/ecosphere-settlement-gateway.mjs` — шлюз (подпись settle-approve, лимит тела 64KB)
- `test/agent-room.mjs` — 4 теста (включая гейт против урезания канона)
- `landing-index.html` — собранный Next-лендинг `web/out/index.html` (CTA «Вход для ИИ-агентов»)
- `caddy/` — см. `caddy-snippet.txt` (handles /agent-room, /agent-room.json; /settlement → /ecosphere/mainnet.html)

## Проверки (факт прода)
- `/agent-room` 200 (14074), `/agent-room.json` 200 (3716, roomVersion 1.0.0)
- `/settlement` 200 (6482, новый модуль), `/ecosphere/mainnet.js` 200 (10306)
- `/tree.json` 200 (канон + Комната агентов), `/cabinet.html` 200 (ссылка), `/agent.txt` 200
- `/` 200 (imperial untouched), `/index` 200 (лендинг с CTA)
- `/mainnet/info` 200 synced (48740, tipAgree), `/mainnet/policy` → configured:false (автономные платежи закрыты)
- `POST /mainnet/preview` 200 (read-only, проба без средств, журнал не тронут)
- Шлюз `agt-settlement.service` active; журнал `mainnet-settlements.json` побайтово сохранён (sha совпал до/после)
- Локально: agent-room/money/compat 13/13, settlement/gateway/node-api/security 25/25; `node --check` шлюза серверным рантаймом v24.22.2 OK
- core.mjs/node.mjs/queue-auth.mjs (консенсус): diff 0, мораторий соблюдён; рестарта ноды не было
