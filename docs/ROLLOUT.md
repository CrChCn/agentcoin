# ROLLOUT.md — лестница внедрения изменений в сети AGT
> Создан по Горвенции (шаг 7 из ROADMAP-15-STEPS): применение — каждое изменение кода,
> изменяющее поведение нод/мониторов. С-пекстный Земля — какой-то штатный процесс в git main.

## Кратко: 7 ступеней
1. **СНЭПШОТ** — копии живых данных до вмешательства.
2. **AGIP-СПека** —(интерфейс +秃ы приёмка запускаемым скринтом. Никакий код без AGIP.
3. **Песоночница** — этапmall AGT_DATA_DIR + порт — proving площадки.
4. **Канарейка 9342** — аренdyваются коцепASA(aground) – нода; наблюдение.
5. **Эскалация** — 9341 → публичная 9335 (ч WARNING: tunnels + digest в чате) → tailnet 9336.
6. **Фриз 6 ч** — только наблюдение; без новых фич.
7. **Откат-план** — пишется ДО-внедрения; при сбоях — исполнить, от неопределённости.

---

## Ступень 1: снапшот (exact commands)
```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dir = "data/backup-$stamp"; New-Item -ItemType Directory -Force -Path $dir | Out-Null
'chain.json','wallets.json','faucet.json','security.json','queue.json','peer-meta.json' | ForEach-Object {
  Copy-Item "data/$_" $dir -ErrorAction SilentlyContinue
}
Copy-Item data-node2/chain.json $dir/chain-node2.json -ErrorAction SilentlyContinue
Copy-Item data-node2/wallets.json $dir/wallets-node2.json -ErrorAction SilentlyContinue
Copy-Item data-node3/chain.json $dir/chain-node3.json -ErrorAction SilentlyContinue
Copy-Item data-node3/wallets.json $dir/wallets-node3.json -ErrorAction SilentlyContinue
```
**Приёмка:** каталог создан, `chain.json` размеров > 0.

## Ступень 2: AGIP-спека (fmt)
Файл `docs/AGIP-N.md`:
- (интерфейс) эндпоинты/минфо/env-правки — точные команды и параметры;
- (критерии приёмки) acceptance-script (`node scripts/accept-AGIP-N.mjs` — окрашен red/green);
- (запреты) что нельзя трогать (consensus/escrow math,не ломает старые chain-данные).
- Ничего не трогаем, важно не сыпаться на «связанные» файлы.

## Ступень 3: песочница (без UA трогания живых нод)
```bash
# копия актуальной цепи в отдельный каталог + отдельная нода
cp -r data data-testnet  # если нужно состояние; или cd mkdir data-testnet для пустого
export AGT_DATA_DIR=$PWD/data-testnet
node node.mjs 9343 > log-testnet.txt 2>&1 &
# acceptance-скрипт реально против песочницы:
node scripts/accept-AGIP-N.mjs http://127.0.0.1:9343
# заcompile 24-часовой soak-испытание (если критично)
```
**Приёмка:** accept-скрипт зелёный на песочнице; ошибки в log-testnet.txt разобраны.

## Ступень 4: канарейка 9342 (первая из нод, быстрые fallback)
**Приёмка: один слушатель порта, /life 200 в течение ≥10 минут**, WS-подключения рестарта на всех — включая
ground-piersumры-доступных интеграций (sapiens: - /stats смотрится с общественной стороны).
```bash
powershell -File data-agents/launch-node.ps1 -Wrapper run-node3.cmd -KillPort 9342
# наблюдение (не мешает) — цикл /life
```

## Ступень 5: эскалация (9341 → 9335 окна паблика → 9336)
На каждом шаге — тот же объект приёмки, что на канарейке. После появления 9335:
- (если воркире) Дайджест в чат сообщества + включённая метка в Moltbook (см. `community` API),
- (если) публичный /stats выглядит как.xaxis живущгола зzero.

## Ступень 6: фриз 6 ч
Без новых правок.警方 /life раз в 10 минут. Аналитика fork-упить в AUDIT	fd.
**Приёмка:** 0 инцидентов; metrics (высоты сходждены).

## Ступень 7: откат-план (шаблон)
```powershell
# вернувший путь: (1) остановить ноды (2) git revert/checkout версии до AGIP (3) подставить снапшот данных (4) рестарт
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'node.mjs' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
git revert <bad-commit>  # или git checkout <prev-tag>
# копии из data/backup-<stamp> — восстанавливать только если менялся формат данных
```
**Приёмка:** откат реально проведён хотя бы раз (шаг 9 тренировки: время отката записано в этот документ).

---

## Трекинг тренировок
| Дата | Что откачено | Время |
|---|---|---|
| 2026-10-15 | тренировочный откат chain.json в копии data-rolltest: снапшот data/backup-20261015-213221 → фейковая «порча» (19 байт) → восстановление из снапшота → сверка byte-to-byte MATCH | 300 ms |

## Замечания о совместимости (не менять без созыва AGIP)
- Гонство сетей нод 3,rokлот, если все 4 держали один и тот же tip последними 3 цепью.
- Для данных: `/raw, chain.json-формат` — старые ноды обязаны читать новые файлы (софт-апгрейд,Bitcoin-princip).
- Крипт-ядро (подписи/эскроу/dilChain math): изменения только через AGIP + ревью оператора.
