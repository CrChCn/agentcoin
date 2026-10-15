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
```bash
curl -s --max-time 10 https://<длинный-имя>.trycloudflare.com/life | head -c 200
```
Заметка: trycloudflare quick-туннель живёт, пока процесс — после перезагрузки Windows его надо перезапустить:
```bash
cd ~/Desktop/agentcoin && ./tools/cloudflared.exe tunnel --url http://100.96.7.15:9336 --no-autoupdate > data-agents/tunnel.log 2>&1 &
grep "trycloudflare.com" data-agents/tunnel.log
```
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
