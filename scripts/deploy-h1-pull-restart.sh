#!/usr/bin/env bash
# deploy-h1-pull-restart.sh — выполнить НА СЕРВЕРЕ H1 (2.31.145.160), 1 команда.
# Тянет main (habitat+atlas маршруты), проверяет синтаксис, рестартит ноду, сверяет.
set -euo pipefail
cd /opt/agentcoin 2>/dev/null || cd ~/agentcoin

echo "[1/5] git pull"
git pull origin main
git log --oneline -1

echo "[2/5] node --check"
node --check node.mjs && echo JS_OK

echo "[3/5] restart"
if systemctl list-units --type=service --all 2>/dev/null | grep -q agt-node; then
  sudo systemctl restart agt-node
  sleep 3
  sudo systemctl is-active agt-node
else
  echo "нет юнита agt-node — рестартни ноду вручную и жми дальше"
fi

echo "[4/5] локальная сверка"
curl -s http://127.0.0.1:9335/life | head -c 200; echo
for p in /habitat /atlas; do
  printf "%s -> " "$p"
  curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:9335$p"
done

echo "[5/5] ГОТОВО если везде 200. Наружная проверка: curl -I https://agentcoin.work/habitat"
