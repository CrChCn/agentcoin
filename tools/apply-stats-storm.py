#!/usr/bin/env python3
# /stats: инлайн-шаблон ноды (GitHub-ссылка, POST /join, «узкое место…»)
# заменяется на статическую страницу «Нейронный шторм» (site/stats.html),
# данные страница берёт из публичных /api/v1/* эндпоинтов.
import re
import shutil
import subprocess
import sys
import time

NODE_FILE = '/opt/agentcoin-node/src/node.mjs'
NODE_BIN = '/opt/agentcoin-staging/runtime/node-v24.22.2/bin/node'

REPL = """  if (p === '/stats' || p === '/stats.html') {
    // AGIP-47 «Нейронный шторм»: страница в checkout (site/stats.html), данные — из /api/v1/*.
    serveSitePage(res, 'stats.html');
  }
"""


def main():
    src = open(NODE_FILE, encoding='utf-8').read()
    bak = NODE_FILE + '.bak-stats-storm-' + time.strftime('%Y%m%d-%H%M%S')
    if "'Нейронный шторм': страница в checkout" in src:
        print('ALREADY PATCHED'); sys.exit(0)
    pat = re.compile(r"  if \(p === '/stats' \|\| p === '/stats\.html'\) \{[\s\S]*?// --- визуальный пульт сети ---")
    m = pat.findall(src)
    if len(m) != 1:
        print('ABORT: /stats block matches:', len(m)); sys.exit(2)
    out = pat.sub(REPL + '\n  // --- визуальный пульт сети ---', src, count=1)
    open('/tmp/statsstorm.mjs', 'w', encoding='utf-8').write(out)
    chk = subprocess.run([NODE_BIN, '--check', '/tmp/statsstorm.mjs'], capture_output=True, text=True)
    if chk.returncode != 0:
        print('ABORT: node --check failed', chk.stderr[:1800]); sys.exit(3)
    shutil.copy2(NODE_FILE, bak)
    open(NODE_FILE, 'w', encoding='utf-8').write(out)
    print('PATCHED:', bak)


if __name__ == '__main__':
    main()
