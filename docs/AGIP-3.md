# AGIP-3: merkle-пруф транзакции — `GET /txproof/:txid`

**Статус:** спека → реализована; прогнана по лестнице ROLLOUT (см. docs/ROLLOUT.md).
**Автор:** оператор + Buffy (агент), дата 2026-10-15.

## Мотивация
По шагу 11 плана (docs/ROADMAP-15-STEPS.md): подтверждение транзакции должно проверяться
**внешне**, без доверия к ноде и без скачивания всей цепи. Merkle-ветка даёт
O(log n) доказательство включения txid в блок.

## Интерфейс
`GET /txproof/<txid>` → (только чтение, guard не нужен):
```json
{
  "txid": "...", "height": N, "blockHash": "...", "txIndex": i,
  "merkleBranch": [{ "hash": "...", "side": "right"|"left" }, ...],
  "header": { version, prevHash, merkleRoot, timestamp, difficultyBits, nonce, chainId },
  "note": "инструкция recompute"
}
```
Не найден → 404 `{ error: 'txid_not_in_chain' }` (tx может быть в mempool).

## Правило независимой проверки (внешний скрипт, не нода)
1. `cur = txid`;
2. для каждой записи ветки: `cur = side=='right' ? sha256d(cur+hash) : sha256d(hash+cur)`;
3. `cur == header.merkleRoot`;
4. `computeBlockHash(header) == blockHash` (импорт того же core.mjs — мат, не состояние ноды).

## КритерииAcceptance (исполняемые)
`node test/accept-AGIP-3.mjs http://127.0.0.1:<port>` → green, если:
1. на чистой песочнице: кошелёк → подписанная tx через `/tx/sign` → `POST /tx` → `POST /mine`;
2. txid вычислен скриптом **сам** (sha256d от tx) — мерчант не верит ноде на слово;
3. `GET /txproof/<txid>` → 200; recompute ветки = `header.merkleRoot`;
4. `computeBlockHash(header)` = `blockHash` — пруф привязан к заголовку;
5. неизвестный txid → 404.

## Запреты
- Не менять consensus/retarget/адрес-схемы; эндпоинт только читает существующую цепь.
- Не менять формат merkleRoot (fold пар a+b, недостающий парнёр = дубликат) — пруф обязан совпасть с нодой.

## Почему это полезно
Мерчан/agents-приложения и будущие SPV-клиенты подтверждают платёж внешне —
фундамент кошельков-без-полной-цепи (следующий этап децентрализации из DECENTRALIZATION.md).
