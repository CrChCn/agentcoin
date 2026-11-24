#!/usr/bin/env bash
# bridge-ssh-reverse.sh — вариант 2: мост с локального Linux на H1
# Локальная нода: 127.0.0.1:9335 -> через SSH видна на сервере как 127.0.0.1:19335
# Запуск на СВОЁМ локальном линуксе (не на сервере!)
set -euo pipefail

LOCAL_PORT="${LOCAL_PORT:-9335}"
REMOTE_PORT="${REMOTE_PORT:-19335}"
H1="${H1_HOST:-2.31.145.160}"
H1_USER="${H1_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/agentcoin_bridge}"

if [ ! -f "$SSH_KEY" ]; then
  echo "[1/3] ключа нет — создаю $SSH_KEY"
  ssh-keygen -t ed25519 -f "$SSH_KEY" -N "" -C "agentcoin-bridge-local"
  echo "  -> добавь на H1: ssh-copy-id -i ${SSH_KEY}.pub ${H1_USER}@${H1}"
  exit 0
fi

echo "[2/3] проверка: локальная нода http://127.0.0.1:${LOCAL_PORT}/life"
curl -fsS --max-time 5 "http://127.0.0.1:${LOCAL_PORT}/life" | head -c 200; echo

echo "[3/3] мост: localhost:${LOCAL_PORT} -> ${H1}:127.0.0.1:${REMOTE_PORT}"
echo "  Держи терминал открытым. Обрыв = Ctrl+C, рестарт = запусти снова."
echo "  Проверка на H1: curl -s http://127.0.0.1:${REMOTE_PORT}/life"
AUTOSSH_GATETIME=0 autossh -M 0 -N -T \
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes \
  -R "127.0.0.1:${REMOTE_PORT}:127.0.0.1:${LOCAL_PORT}" \
  -i "$SSH_KEY" "${H1_USER}@${H1}"
