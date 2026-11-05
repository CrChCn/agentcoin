#!/usr/bin/env python3
# /tx/sign отдаёт signed-объект БЕЗ поля txid (нода вычисляет его на приёме),
# поэтому justice-экран уходил в allow. Патч: вычислять txid ДО screen.
import shutil
import subprocess
import sys
import time

NODE_FILE = '/opt/agentcoin-node/src/node.mjs'
NODE_BIN = '/opt/agentcoin-staging/runtime/node-v24.22.2/bin/node'

OLD = "      const scr = justice.screenTx(tx);"
NEW = "      try { if (!tx.txid) tx.txid = String(txDigest(tx)); } catch {}\n      const scr = justice.screenTx(tx);"

src = open(NODE_FILE, encoding='utf-8').read()
if NEW in src:
    print('ALREADY PATCHED'); sys.exit(0)
if src.count(OLD) != 1:
    print('ABORT: anchor count', src.count(OLD)); sys.exit(2)
bak = NODE_FILE + '.bak-justice-txidfix-' + time.strftime('%Y%m%d-%H%M%S')
shutil.copy2(NODE_FILE, bak)
out = src.replace(OLD, NEW, 1)
open('/tmp/justicefix2.mjs', 'w', encoding='utf-8').write(out)
chk = subprocess.run([NODE_BIN, '--check', '/tmp/justicefix2.mjs'], capture_output=True, text=True)
if chk.returncode != 0:
    print('ABORT: node --check failed', chk.stderr[:1500]); sys.exit(3)
open(NODE_FILE, 'w', encoding='utf-8').write(out)
print('PATCHED:', bak)
