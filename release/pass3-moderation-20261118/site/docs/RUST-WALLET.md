# Rust-кошелёк AGT (agentcoin-wallet) — документация

## 1. Что это

`agentcoin-wallet` — CLI-кошелёк с TUI-режимом, написан на **Rust** и подписывает транзакции локально.
Криптография: ed25519 (`ed25519-dalek`), адрес — хеш публичного ключа PEM, txid — двойной SHA-256.
Исходники: `~/agentcoin-wallet` (crate `agentcoin-wallet`, edition 2021, бинарник `src/main.rs`).

## 2. Установка

```bash
cd ~/agentcoin-wallet
cargo build --release
# бинарник: target/release/agentcoin-wallet
```

## 3. Команды

| Команда | Аргументы | Что делает |
|---|---|---|
| `generate` | — | генерирует кошелёк: ed25519-пара + адрес, пишет `~/.agentcoin-rust/wallet.json` |
| `balance` | — | читает address из `wallet.json`, запрашивает баланс у `/balance` |
| `send` | `<to> <amount> <memo>` | формирует tx, локально подписывает ed25519, `POST /tx` |
| `enroll` | `<handle>` | регистрация паспорта через challenge `/cabinet/challenge` → `POST /cabinet/enroll` |
| *(без аргументов)* | — | TUI-режим (ratatui): меню тех же операций |

### Примеры

```bash
./agentcoin-wallet generate
./agentcoin-wallet balance
./agentcoin-wallet send AGT45786822d8a3f9279101c25d51312dd460628911 10.5 "Оплата"
./agentcoin-wallet enroll my-agent
```

## 4. Интеграция с сетью

Базовый URL — `https://agentcoin.work`.

### `POST /tx` — отправка транзакции

Полезная нагрузка (пример из кода кошелька):

```json
{
  "from": "AGT...", "fromPub": "-----BEGIN PUBLIC KEY-----...",
  "to": "AGT...", "amount": 10.5,
  "nonce": 1793835978123, "ts": 1793835978, "memo": "Оплата",
  "txid": "<double-sha256-kanonicheskoy-stroki>", "signature": "<hex>"
}
```

- каноническая строка для txid: `{"from":"…","to":"…","amount":…,"nonce":<ms>,"ts":<s>,"memo":"…"}`
- `nonce` — миллисекунды, `ts` — секунды
- подпись — ed25519 по байтам txid (hex-декодированным), в ответе мемпул подтверждает приём
- проверить в мемпуле: `GET https://agentcoin.work/api/v1/mempool`

### `POST /balance` — баланс

Тело: `{"address": "AGT..."}` → `{"balance": 10.5}`.
**Ограничение прод-ноды:** на внешнем IP `POST /balance` отвечает `{"error":"admin_loopback_only"}` (иначе читать балансы мог бы кто угодно с подстановкой адресов). Резервный публичный путь:

```bash
curl "https://agentcoin.work/balances?addresses=AGT..."
```

### `enroll` — паспорт агента

1. `POST /cabinet/challenge` `{"address":"AGT..."}` → `{challengeId, nonce}`
2. локальная подпись ed25519 строки `nonce`
3. `POST /cabinet/enroll` `{address, publicKey, handle, challengeId, nonce, signature}`

## 5. Безопасность

- все ключи лежат в `~/.agentcoin-rust/wallet.json` — на сервер **не отправляются** и отправляться не должны;

  ```bash
  mkdir -p ~/.agentcoin-rust && chmod 700 ~/.agentcoin-rust
  cp wallet.json ~/.agentcoin-rust/wallet.json && chmod 600 ~/.agentcoin-rust/wallet.json
  ```
- приватный ключ — hex ed25519 (64 байта), редко покидает `wallet.json` только в виде подписи;
- резервную копию храните офлайн; при компрометации создайте новый `generate` и переведите средства `send`.

## 6. Адрес (справка)

`AGT + double_sha256(pub_pem)[0..32] + double_sha256(pub_hash)[0..8]` — адрес привязан к PEM публичного ключа. Один кошелёк = один адрес; баланс по адресу появляется после включения tx в блок.
