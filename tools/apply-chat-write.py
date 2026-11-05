#!/usr/bin/env python3
# Точечная добавка: /community/send попадает в публичные POST-маршруты ноды
# (AGIP-37 whitelist), чтобы сайт-чат мог отправлять сообщения; периметр
# llm-trust-guard всё равно сканирует каждый текст (justice-хук стоит ДО записи).
import shutil
import subprocess
import sys
import time

NODE_FILE = '/opt/agentcoin-node/src/node.mjs'
NODE_BIN = '/opt/agentcoin-staging/runtime/node-v24.22.2/bin/node'

OLD = "const PUB_TX_ROUTES = new Set(['/casino/bet', '/gov/propose', '/gov/proposal', '/gov/vote', '/identity/challenge', '/identity/register', '/identity/import', '/tx', '/tx/preflight', '/balance', '/cabinet/challenge', '/cabinet/login', '/cabinet/state', '/cabinet/logout', '/cabinet/op-request', '/cabinet/op-submit', '/cabinet/wallet/history', '/cabinet/wallet/estimate', '/assistant/message']);"
NEW = OLD.replace("'/assistant/message']);", "'/assistant/message', '/community/send']);")

assert OLD != NEW
src = open(NODE_FILE, encoding='utf-8').read()
bak = NODE_FILE + '.bak-chatwrite-' + time.strftime('%Y%m%d-%H%M%S')
if NEW in src:
    print('ALREADY PATCHED'); sys.exit(0)
if src.count(OLD) != 1:
    print('ABORT: PUB_TX_ROUTES anchor not unique'); sys.exit(2)
shutil.copy2(NODE_FILE, bak)
out = src.replace(OLD, NEW, 1)
open('/tmp/chatwritecheck.mjs', 'w', encoding='utf-8').write(out)
chk = subprocess.run([NODE_BIN, '--check', '/tmp/chatwritecheck.mjs'], capture_output=True, text=True)
if chk.returncode != 0:
    print('ABORT: node --check failed', chk.stderr[:1500]); sys.exit(3)
open(NODE_FILE, 'w', encoding='utf-8').write(out)
print('PATCHED:', bak)
