# ☀️ Утренний чек-лист сети AGT (5 минут)

## 1. Ноды живы?
```bash
for u in 127.0.0.1:9335 127.0.0.1:9341 127.0.0.1:9342 100.96.7.15:9336; do
  curl -s --max-time 5 "http://$u/life" | python -c "import json,sys; d=json.load(sys.stdin); print('$u:', 'blocks', d['blocks'], 'valid', d['chainValid'], 'fresh', d['fresh'])"
done
```
Ожидание: все 4 — `valid=True fresh=True`, высоты в пределах 1–2 блоков.

## 2. Watchdog не наспамил?
`tail -10 log-watchdog.txt` — если рестартов больше 3 за ночь — смотреть log-node*.txt ошибку.

## 3. steward-лог чист?
`tail -10 data-agents/steward-log.txt` — ищи `ALARM-REPEAT` и `ALARM-NET`. Свежие должны быть `alerts: чисто`.

## 4. Public tunnel жив?

t**AGIP-5 (шаг 13): главное — STABLE вход не меняется при перезапусках:**
```bash
curl -s --max-time 10 https://laptop-ih54qpif.tail8c28c2.ts.net/life | head -c 200
```
Funnel-конфиг переживает перезагрузку Windows (persisted в tailnet). Подъём заново при сбое:
```bash
cd ~/Desktop/agentcoin && MSYS_NO_PATHCONV=1 "/c/Program Files/Tailscale/tailscale.exe" funnel --bg --set-path / http://127.0.0.1:9335
```
Backup-туннель (old trycloudflare, имя меняется при каждом рестарте):
```bash
cd ~/Desktop/agentcoin && ./tools/cloudflared.exe tunnel --url http://100.96.7.15:9336 --no-autoupdate > data-agents/tunnel.log 2>&1 &
grep "trycloudflare.com" data-agents/tunnel.log
```
Плюс: GitHub Actions-джоб `uptime` пингует стабильный вход каждые 5 мин и тревожит в сетевой чат при dead > 90с
(дедуп 1 тревога/55 мин; переменная репо `AGT_PUBLIC_URL`).
(имя меняется при каждом пере-старте — **новое имя нужно обновить в чат-приглашении и Moltbook-посте**).

## 5. Moltbook: есть реакции?
`tail -5 data-agents/moltbook-watch.log` — после `watchAgents` строка `new=N`; при N>0 читать reactions в логе.

## 6. gov: есть активные голоса?
```bash
curl -s http://127.0.0.1:9335/gov/state | python -c "import json,sys; d=json.load(sys.stdin); [print(p['ref'], 'yes', p['yes'], 'no', p['no'], 'active', p['active']) for p in d['proposals'] if p['active']]"
```
Найм фермы `2xgELrMi` должен быть passed (3 yes).

## 7. CI зелёный после последнего пуша?
GitHub → Actions → Syntax CI — зелёный. Если красный — `node --check` локально найдёт виновника.

## 8. Ночная статистика:
```bash
curl -s http://127.0.0.1:9335/stats | grep num
```
Сравнить «блоков» с утренним вчера: ночью прибавляется ~700–900 (1 блок/мин).
