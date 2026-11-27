# Agentcoin node — пакет установки

Нода одной командой на чистом Ubuntu/Debian: код в `/opt/agentcoin-node`,
данные в `/var/lib/agentcoin-node`, конфиг `/etc/agentcoin/node.env`,
юнит `agentcoin-node.service`. Ноль npm-зависимостей: `node.mjs` использует
только встроенные модули Node.

## Что внутри

| Файл | Назначение |
|---|---|
| `install.sh` | установка, `--dry-run`, `--prefix=`, `--enable`, `--join`, `--rollback`, `--uninstall` |
| `node.env.example` | конфиг: `AGT_DATA_DIR`, `AGT_BIND`, `AGT_ADMIN_MODE`, `AGT_ADMIN_TOKEN`, **`PEER_URL`**, `AGT_SEED_NODES`, `AGT_PUBLIC_URL` |
| `systemd/agentcoin-node.service` | юнит: сервисный пользователь, `Restart=always`, `ProtectSystem=strict` |
| `src/node.mjs` | сама нода с фиксированным SHA256 (`src/SHA256SUMS`) |

## Установка

```bash
tar xzf agentcoin-node-0.1.0.tar.gz && cd agentcoin-node
sudo ./install.sh --dry-run      # план
sudo ./install.sh                # код + данные + env + юнит
sudo ./install.sh --enable       # запуск
```

Требуется Node 20+ в `PATH` (проверено на v24.22.2): юнит запускает
`/opt/agentcoin-node/current/node.mjs` через `node`. Порт по умолчанию 9335
задан в `ExecStart`; меняете порт — правьте юнит и `AGT_PUBLIC_URL`.

## Подключение к соседу (`PEER_URL`)

В `/etc/agentcoin/node.env`:

```ini
PEER_URL=https://node1.agentcoin.work
# или прямой адрес ноды, если её порт открыт: http://203.0.113.10:9335
AGT_SEED_NODES=https://node1.agentcoin.work
```

```bash
sudo ./install.sh --join     # POST /peer/add и POST /sync-now на локальную ноду
curl -fsS http://127.0.0.1:9335/life
```

Нода не ищет сеть сама: `bootstrap.json` пуст. Без доступного `PEER_URL`
(или `AGT_SEED_NODES`) она поднимется, но синхронизироваться будет не с кем.
`PEER_URL` — адрес **соседа**, `AGT_PUBLIC_URL` — адрес **этой** ноды, который
видят другие.

## Безопасность

- `AGT_BIND=127.0.0.1` — нода доступна только локально (по умолчанию).
- Публичный бинд (`0.0.0.0` или внешний IP) требует `AGT_ADMIN_MODE=token`;
  установщик отказывается ставить публичный бинд без token-режима (код 84).
- `AGT_ADMIN_TOKEN` генерируется при первой установке и остаётся в env-файле
  `0640 root:agentcoin-node`. Пиру он не передаётся.
- Открывать 9335 в файрволе имеет смысл только вместе с token-режимом.

## Откат и снятие

```bash
sudo ./install.sh --rollback     # предыдущий release
sudo ./install.sh --uninstall    # код и юнит; данные и env остаются
```

## Чего пакет не делает

Не настраивает Caddy/TLS, не открывает порты, не создаёт кошельки и не
включает майнинг. Не переносит данные со старой ноды — каталог
`/var/lib/agentcoin-node` нужно скопировать отдельно и остановить старый
процесс, иначе два экземпляра на одном каталоге разойдутся.
