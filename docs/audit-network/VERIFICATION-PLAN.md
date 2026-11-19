# План испытаний (только чтение; рестарты/отправки — отдельным словом владельца)

Нумерация V01..V10. V01 и V02 ВЫПОЛНЕНЫ чтением 2026-11-19T09:31–09:33Z (E20–E25). Остаток: дифф версий, логи, юниты-файлы целиком, testnet.

## V01. Процессы/юниты/ресурсы/версии — ВЫПОЛНЕНО (E20/E24). Остаток: полные unit-файлы, дифф node/core резервов vs H1
- SSH read-only (ключи/токены не печатать, содержимое файлов не дампить):
- `systemctl is-active agt-node agt-settlement; systemctl show agt-node -p ExecStart,User,WorkingDirectory; cat /etc/caddy/Caddyfile | sed -e 's/*token.*/XXX/' (редакт)` — лучше: `caddy validate` вывод без секретов; `ps -o pid,user,etime,cmd -C node; ss -ltnp | grep -E '9335|18745|80|443'; df -h / /opt /srv; free -m; node --version`
- `ls -la /opt/agentcoin-node/src /srv/agentcoin-empire/current; git -C /opt/agentcoin-node/src rev-parse --short HEAD; sha256sum node.mjs core.mjs sync.mjs ws.mjs` (сравнить с a5bd038)
- `ls -la DATA_DIR; du -sh DATA_DIR; ls DATA_DIR | head` (имена chain.json/mempool.json/peers.json/peer-meta.json — без содержимого секретов)
- Ограничение: нужен SSH-доступ; секреты/содержимое кошельков не читать.

## V02. Серверный Caddy + механизм монитора + compatibility — ВЫПОЛНЕНО (E21/E22/E23/E25). Остаток: полный файл node3, строки /api/v1-адаптера
- `caddy adapt --config /etc/caddy/Caddyfile --pretty` или чтение файла, с редакцией `basicauth/*key*` → XXX.
- Проверить: тёмное правило резервов (какие пути/источники открыты), `/mainnet/*→18745`, `/api/v1/*` адаптер (где возникает route_not_allowlisted), WS-апгрейд `/ws`.
- Публичная версия отчёта — без секретов и внутренних имён сверх необходимого.

## V03. WS-транспорт (закрывает C01)
- С главной: запросить `/peers/meta` + логи gossip (`[ws]`, `[peers] seeds merge`, strike-строки) за окно — только чтение лога.
- Проверить исходящие WS с главной к резервам в момент опроса; зафиксировать `roster` при живых сессиях.
- Изолированно: стенд B/C по docs (песочница) — FR-P2 считают, но прод не трогать.

## V04. Синхронизация/выбор цепи побайтово (закрывает §7)
- На стенде (НЕ mainnet): новая нода с пустым DATA_DIR + seed главной → зафиксировать genesis-check → headers → bodies → difficulty → chainWork → fork → reorg → mempool-дроп.
- На проде только чтение: `/headers?from=N`, `/blocks?from=N`, сравнение tipHash главной/резервов во времени (уже E04/E07).

## V05. validationMode и единообразие правил (закрывает C06)
- Снять `/life` и `/validate?strict=1` (если открыт) со всех трёх через главную; сравнить `validationMode/chainValid/chainIssue`.
- Найти флаг compatibility в коде (`git grep -n compatibility`) и задокументировать, что смягчено.

## V06. Транзакция без отправок (закрывает §8)
- Разобрать E07-образец: канонический JSON → sha256d → txid; verifyTransaction локально над публичными полями.
- Проверить `unitsOfAmountBigInt` на граничных строках (9 знаков, лишние знаки → отказ).
- Недоказанное (двойная трата, mempool-персист после рестарта, duplicate_tx) — только стенд.

## V07. Майнинг/пул (закрывает §9)
- Сверить `difficultyBits` живьём (E01) vs `SHARE_DIFF_BITS` код; зафиксировать решение про share≤difficulty.
- Подтвердить процессы планировщиков чтением (`systemctl list-timers`, cron) без изменений.
- Журнал расчётов пула — только существование/формат (секреты не читать).

## V08. Прикладная экономика (закрывает §10)
- Пройти по action-registry settle.* и room.* только чтениями: boot → balance чужого адреса → preview отказ на 10-м знаке → confirm по известному txid из E07.
- Проверить разделение TEST/PROD книг чтением имён файлов/каталогов (содержимое кошельков не читать).

## V09. Ключи/доверие (закрывает §11)
- Убедиться отсутствием серверной генерации: `git grep -n /join` + поведение кабинета (noSecrets, challenge-flow).
- Перечислить держателей x-admin-token/казначейских подписей по ролям (значений не снимать).

## V10. Публичная версия отчёта
- Вычистить IP/топологию до уровня «3 независимых адреса», убрать внутренние пути/юниты; оставить ссылки на E-файлы без секретов.
