#!/usr/bin/env bash
# vps-https-setup.sh — публичная нода AGENTCOIN с HTTPS (Caddy + Let's Encrypt).
# Запуск от root НА VPS (Hetzner CX22, Ubuntu 22.04) после того, как
# DNS-имя ACTUAL_DOMAIN уже указывает на этот сервер (DuckDNS отредактирован до IP).
# Использование: DOMAIN=agt.<sub>.duckdns.org bash vps-https-setup.sh
# Требует: curl, ssh-keygen может отсутствовать — не мешает.
set -euo pipefail

DOMAIN="${DOMAIN:?нужен DOMAIN=имя, напр. agentcoin.duckdns.org}"
PORT="${NODE_PORT:-9335}"

die() { echo "✗ ОШИБКА: $*" >&2; exit 1; }

echo "[0/6] Проверка DNS: ${DOMAIN} должна резолвиться в этот сервер"
PUB_IP="$(curl -fsS -m 10 https://api.ipify.org)"
DNS_IP="$(getent ahostsv4 "${DOMAIN}" 2>/dev/null | awk 'NR==1{print $1}')"
if [ -z "${DNS_IP}" ]; then die "DNS ещё не настроен: нет записи для ${DOMAIN}. Отредактируй duckdns.org и перезапусти."; fi
if [ "${DNS_IP}" != "${PUB_IP}" ]; then die "DNS ${DOMAIN} → ${DNS_IP}, а сервер ${PUB_IP}. Нужны одинаковые адреса, иначе Let's Encrypt не выдаст сертификат."; fi
echo "  ✓ ${DOMAIN} → ${PUB_IP}"

echo "[1/6] Пакеты: curl, git, ca-certificates, jq, ufw, caddy"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates jq ufw
if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmour -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi
command -v caddy >/dev/null || die "Caddy не установился"

echo "[2/6] Базовый деплой ноды (репозиторий deploy-vps.sh)"
AGT_BOOTSTRAP_PEER="${AGT_BOOTSTRAP_PEER:-}" bash "scripts/deploy-vps.sh" "${PORT}"

echo "[3/6] Файрвол: закрываем наружу 9335 (Caddy — единственный вход), оставляем 22/80/443"
ufw delete allow "${PORT}/tcp" >/dev/null 2>&1 || true    # правило allow, внесённое deploy-vps.sh, снимаем — deny обязан быть первым
ufw deny "${PORT}/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw status numbered | sed 's/^/  /'

echo "[4/6] Caddyfile: ${DOMAIN} → 127.0.0.1:${PORT} (WS-e и потоки автоматически)"
cat > /etc/caddy/Caddyfile <<EOF
${DOMAIN} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:${PORT}
  # большие ответы цепи и WS — без зачата таймаутов:
  transport http {
    dial_timeout 10s
    response_header_timeout 300s
  }
  log {
    output file /var/log/caddy/agt-access.log
  }
}
EOF
mkdir -p /var/log/caddy

echo "[5/6] Перезапуск Caddy и ожидание Let's Encrypt сертификата"
systemctl restart caddy
CERT_OK=""
for i in $(seq 1 45); do
  if echo | openssl s_client -servername "${DOMAIN}" -connect "${DOMAIN}:443" 2>/dev/null | grep -q 'BEGIN CERTIFICATE'; then CERT_OK=1; break; fi
  sleep 6
done
if [ -z "${CERT_OK}" ]; then
  journalctl -u caddy -n 30 --no-pager | tail -n 15 >&2
  die "HTTPS не поднялся (DNS/DNS-порт 80 закрыт провайдером?) — смотри выше journalctl. Проверь порт 80 tcp в панели Hetzner!"
fi
echo "  ✓ TLS-сертификат выдан для ${DOMAIN}"

echo "[6/6] внешний HTTP-чек через HTTPS"
LIFE="$(curl -fsS -m 15 "https://${DOMAIN}/life")"
echo "  /life → ${LIFE}"
jq -e '.chainValid == true' <<<"${LIFE}" >/dev/null || die "по HTTPS цепь не валидна"

cat <<NEXT

=== ГОТОВО (HTTPS) ===
  Публичный адрес ноды:  https://${DOMAIN}
  Проверить снаружи:     curl -s https://${DOMAIN}/info | head
        пиннинг genesis: curl -s https://${DOMAIN}/info | jq -r .genesisHash
  LIVE-пульс:            curl -s https://${DOMAIN}/life
  Админ-плоскость:       только SSH (loopback + x-admin-token), снаружи 403.
  Wallet/admin token:    sudo cat /opt/agentcoin/data-agtx/admin-token.txt

Дальше (на стороне ноутбука, чтобы пир увидел сеть):
  localhost:  POST /peer/add {url:"https://${DOMAIN}"} — нода добавит пира и синхронизируется
  Проверка:   curl -s https://${DOMAIN}/network/nodes | jq '.nodes[] | {name, blocks, status}'
NEXT
