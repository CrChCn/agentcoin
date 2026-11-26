# Гостевой полный пир: 5 команд

Что получишь: ноду Agentcoin, которую сеть дозванивает сама (входящие пиры),
а не только leaf-пир. Требования: чистый Ubuntu/Debian VPS (хватит 1 vCPU / 1 ГБ),
root или sudo, свой домен.

**Сначала (не команда):**

1. У регистратора заведи A-запись `nodeX.example.com → IP твоего VPS`, подожди 5–15 минут.
2. В панели хостера открой входящие **80 и 443** (security group / файрвол VPS).
   Скрипт открывает только ufw внутри машины — внешний файрвол он не видит, а без 80/443
   Caddy не выпустит сертификат.

```sh
# 1. DNS: должен вернуть IPv4 твоего VPS (иначе дальше не иди)
getent ahostsv4 nodeX.example.com | head -n1

# 2. Установка ноды + Caddy (443 → нода), выпуск сертификата, анонс себя сети (~3–5 мин)
curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/install-node.sh | sudo bash -s -- --domain nodeX.example.com

# 3. Проверка: chainValid:true и высота как у сети (https://agentcoin.work/life)
curl -s https://nodeX.example.com/life

# 4. Пиры: peer_count ≥ 2–3; входящие (inbound > 0) появятся за ~10–30 мин — значит, сеть тебя дозванивает
curl -s http://127.0.0.1:9335/ws/status | grep -oE '"(peer_count|inbound|outbound)":[0-9]+'

# 5. Обновление ноды позже — одной командой (полный пир сохранится сам)
sudo bash /opt/agentcoin-node/src/scripts/install-node.sh --update
```

`--update` не разжаловывает ноду: self-URL берётся из `/etc/agentcoin-node.env` и остаётся
на месте, даже если не передать `--domain`. Вернуть ноду в leaf — `--update --leaf`.

## Если что-то не так

- Команда 1 пустая — жди DNS или чини A-запись (IPv4, не CNAME на чужой хост).
- Шаг `[4/9]` ругнулся, что не смог узнать высоту сети — установка пойдёт дальше, но синк
  упадёт на легаси-блоке. Тогда качай скрипт и запускай с порогом явно:
  `curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/install-node.sh -o install.sh`
  и `sudo AGT_ASSUME_VALID_HEIGHT=<высота с https://agentcoin.work/life> bash install.sh --domain nodeX.example.com`.
- Шаг `[9/9]` упал («публичный вход не отвечает») — почти всегда DNS или файрвол:
  `sudo ufw allow 80,443/tcp`, проверь 80/443 в панели хостера, затем
  `journalctl -u caddy -n 40 --no-pager`.
- «блок nodeX.example.com уже есть в Caddyfile — не трогаю» — это норма: повторный запуск
  ничего не дублирует, старый блок остаётся как был.
- Команда 4 показывает пиров, но inbound 0 дольше часа — проверь 443 снаружи:
  `curl -s https://nodeX.example.com/life` с другого компьютера. Если снаружи работает —
  сеть тебя ещё не нашла, сиды опрашиваются раз в ~90 с.
- Нода не стартует — `journalctl -u agentcoin-node -n 60 --no-pager`.
- Нужен другой порт (9335 занят) — `AGT_PORT` задаётся перед `sudo` вот так:
  `curl -fsSL https://raw.githubusercontent.com/CrChCn/agentcoin/main/scripts/install-node.sh -o install.sh`
  и `sudo AGT_PORT=9445 bash install.sh --domain nodeX.example.com`
  (в командах 3–4 тогда свой порт и URL).

## Удалить ноду

```sh
sudo systemctl disable --now agentcoin-node
sudo rm -rf /opt/agentcoin-node /etc/agentcoin-node.env
sudo systemctl disable --now caddy     # если Caddy стоял здесь только ради ноды
```

Блок `nodeX.example.com { ... }` в `/etc/caddy/Caddyfile` можно удалить руками. Не удаляй
файл целиком, если через этот Caddy работают другие сайты. Пакет Caddy скрипт не сносит —
он мог стоять на машине и до нас. Домен и A-запись удаляются у регистратора.
