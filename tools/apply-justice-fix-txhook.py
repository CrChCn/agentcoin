#!/usr/bin/env python3
# Фикс позиции justice-хука в /tx: экран должен стоять ПЕРЕД bc.addTransaction.
# Шаг 1: удалить ранее вставленный блок (после return-строки). Шаг 2: вставить
# его ПЕРЕД `const r = bc.addTransaction(tx);` в /tx. Проверки уникальности
# анкоров + node --check + восстановление при сбое.
import shutil
import subprocess
import sys
import time

NODE_FILE = '/opt/agentcoin-node/src/node.mjs'
NODE_BIN = '/opt/agentcoin-staging/runtime/node-v24.22.2/bin/node'

BLOCK = """    // AGIP-22: экран юстиции — ВНЕШНИЕ отправители (не loopback-агенты) проходят периметр;
    // внутренние job-скрипты не фильтруются (loopback без прокси-заголовков)
    if (!(isLoopbackRequest(req) && !forwardedViaProxy(req))) {
      const scr = justice.screenTx(tx);
      if (scr.verdict === 'block') return json(res, 423, { error: 'blocked_by_justice', reason: scr.reason, severity: scr.severity });
      if (scr.verdict === 'quarantine') {
        const caseId = justice.quarantineTx(tx, scr.reason, scr.severity);
        return json(res, 202, { quarantined: true, caseId, txid: String(tx.txid).slice(0, 16), reason: scr.reason, hint: 'одобрение — /jail → Карантин (POST /api/v1/jail/approve-tx)' });
      }
      const _memoStr = String(tx.memo || '');
      if (_memoStr.length > 0 && _memoStr.length < 500) {
        const g = await guardCheck(_memoStr, 'tx-memo');
        if (!g.allowed) {
          justice.logInjection({ address: tx.from, source: 'tx-memo', text: _memoStr, threat: g.threat || 'Prompt Injection' });
          return json(res, 403, { error: 'blocked_by_security', threat: g.threat, hint: 'memo отклонён llm-trust-guard, дело на /jail' });
        }
      }
    }
"""

ANCHOR = "    if (!verifyTransaction(tx)) {\n"
INS_BEFORE = "    const r = bc.addTransaction(tx);\n    if (!r.ok) return json(res, 400, r);\n"

src = open(NODE_FILE, encoding='utf-8').read()
bak = NODE_FILE + '.bak-justicefix-' + time.strftime('%Y%m%d-%H%M%S')

if src.count(ANCHOR) != 1:
    print('ABORT: verifyTransaction anchor count', src.count(ANCHOR)); sys.exit(2)

out = src
if BLOCK in out:
    # удалить старую позицию
    out = out.replace(BLOCK, '', 1)
    print('removed misplaced hook')
else:
    print('old hook not found (ok, гуманный первый проход)')

anchor2 = '\n' + INS_BEFORE
if out.count(INS_BEFORE) < 1:
    print('ABORT: addTransaction/400 anchor not found'); sys.exit(3)
n = out.count(INS_BEFORE)
if n != 1:
    # /tx-место определяем от verifyTransaction-анкора: хук встанет между verify и first addTransaction после него
    i = out.find(ANCHOR)
    j = out.find(INS_BEFORE, i)
    if j < 0:
        print('ABORT: addTransaction not found after verify anchor'); sys.exit(4)
    out = out[:j] + BLOCK + out[j:]
else:
    out = out.replace(INS_BEFORE, BLOCK + INS_BEFORE, 1)

open('/tmp/justicefix.mjs', 'w', encoding='utf-8').write(out)
chk = subprocess.run([NODE_BIN, '--check', '/tmp/justicefix.mjs'], capture_output=True, text=True)
if chk.returncode != 0:
    print('ABORT: node --check failed', chk.stderr[:2000]); sys.exit(5)
shutil.copy2(NODE_FILE, bak)
open(NODE_FILE, 'w', encoding='utf-8').write(out)
print('FIXED:', bak)
