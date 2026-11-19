# Stage 4 — кандидат устранения трёх блокеров (production не изменялся)

## Что внутри

- `site/` — три shell-страницы (`index.html`, `agent-room.html`, `settlement.html`)
  + общий shell (`_shell/shell.css`, `_shell/shell.js`), общий модуль (`app.js`),
  единый release-маркер `stage4-candidate-20261119` из `release.json`.
- `site-patches/` — 5 HTML с одной правкой ссылок (`href="/imperial"` → `href="/"`)
  + `tree.json` (`/` → `index.html`, `/imperial*` — редирект, не продукт).
- `Caddyfile.candidate` — два site-блока; diff поведения — `CADDY_DIFF.md`,
  карта маршрутов — `ROUTE_MAP.md`.
- `stand/` — изолированный стенд (mock-mainnet 18081, mock-staging 18082,
  router 18080, логика 1:1 с `Caddyfile.candidate`) + `accept.mjs` (30/30).
- `gate/` — кандидат-реестр, наблюдения, diff, политика `stage4-candidate`,
  evidence (26 файлов), `verdict.json`/`TRUTH-GATE.md`, `PACK-FILES.txt`,
  `SHA256SUMS`.
- `DEPLOY.md` (план окна, не выполнялся), `ROLLBACK.md` (откат только из
  серверного бэкапа), `REMAINING.md` (WARN/UNKNOWN), `TEST-RESULTS.md`.

## Решения по ТЗ п.4 (staging mutation)

Настоящего staging-обработчика mutation на срезе нет (всё вело в mainnet),
поэтому маршруты закрыты явным `404 {"ok":false,"error":"staging_mutation_unavailable"}`,
а не направлены на staging-mock. Mainnet-маршруты не менялись.

## Приёмка

- Стенд: `node candidate-stage4/stand/accept.mjs` → 30/30.
- Гейт: `node tools/truth-gate.mjs --registry candidate-stage4/gate/registry.candidate.json --observations candidate-stage4/gate/observations.candidate.json --diff candidate-stage4/gate/diff.candidate.json --policy candidate-stage4/gate/policy.candidate.json` → WARN, блокеров 0.
- Регрессия: registry 33/33, net 43/43, gate 42/42.

## Явная строка

Production не изменялся: ни одна команда против production, Caddy, systemd,
запущенных процессов, цепи, балансов и ключей не выполнялась.
