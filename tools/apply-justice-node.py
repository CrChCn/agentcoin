#!/usr/bin/env python3
# ============================================================
# apply-justice-node.py — точечный ДОБАВЛЯЮЩИЙ патч /opt/agentcoin-node/src/node.mjs
# (AGIP-22 «Департамент юстиции»: только добавления, ни одна существующая
# строка логики не переписывается). Анкоры проверяются на уникальность,
# после патча — node --check; при любой ошибке файл восстанавливается.
# ============================================================
import re
import shutil
import subprocess
import sys
import time

NODE_FILE = '/opt/agentcoin-node/src/node.mjs'
NODE_BIN = '/opt/agentcoin-staging/runtime/node-v24.22.2/bin/node'

TREASURY = 'AGT209ec9884a9569ac8d5b897177087aab5bd0c937'

TREASURY_PLACEHOLDER = '__TREASURY__'

BLOCK_IMPORT = "\nimport { JusticeDept } from './justice.mjs'; // AGIP-22 Департамент юстиции\n"

BLOCK_INSTANCE = "\n// AGIP-22: Департамент юстиции — дела/карантин/инъекции/заморозки/согласование детектора\nconst justice = new JusticeDept(path.join(DATA_DIR, 'justice.json'), { security: bc.security, treasury: process.env.AGT_JUSTICE_TREASURY || '" + TREASURY + "' });\n"

BLOCK_HELPERS = """// ===== AGIP-22 ДЕПАРТАМЕНТ ЮСТИЦИИ: helpers (периметр llm-trust-guard + ончейн-свидетельства) =====
const JUSTICE_GUARD_URL = process.env.AGT_JUSTICE_GUARD || 'http://127.0.0.1:8081/check';
async function guardCheck(text, source) {
  if (!text || typeof text !== 'string') return { allowed: true, threat: null };
  try {
    const r = await fetch(JUSTICE_GUARD_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text.slice(0, 4000), source }), signal: AbortSignal.timeout(900) });
    justice.noteGuard(r.ok);
    const j = await r.json();
    return { allowed: Boolean(j.allowed), threat: j.threat || null, category: j.category || null };
  } catch (e) {
    justice.noteGuard(false); // fail-open: сервис периметра недоступен; состояние видно на /api/v1/jail/state
    return { allowed: true, threat: null, degraded: true };
  }
}
// Ончейн-свидетельство санкции (freeze/fine/ban): memo-tx 0.001 AGT от живого кошелька ноды В казну
async function justiceMemoTx(memo) {
  try {
    const w = pickDefaultWallet(true);
    if (!w) return { ok: false, reason: 'no_funded_node_wallet' };
    const all = loadWallets(); const ww = all[w];
    const tx = { from: w, fromPub: ww.pub, to: (process.env.AGT_JUSTICE_TREASURY || '__TREASURY__'), amount: DXE_MEMO_FEE, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: String(memo).slice(0, 120) };
    tx.txid = txDigest(tx);
    tx.signature = signTransaction(tx, ww.privKey);
    const r = bc.addTransaction(tx);
    if (!r.ok) return { ok: false, reason: r.error || 'mempool_rejected' };
    setImmediate(() => { gossipTx(tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx }); });
    return { ok: true, txid: String(tx.txid).slice(0, 16) };
  } catch (e) { return { ok: false, reason: String(e?.message || e).slice(0, 80) }; }
}

"""

BLOCK_TX_HOOK = """    // AGIP-22: экран юстиции — ВНЕШНИЕ отправители (не loopback-агенты) проходят периметр;
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

BLOCK_CHAT_HOOK = """    // AGIP-22: периметр llm-trust-guard — инъекции не доходят до ленты (все отправители)
    {
      const _g = await guardCheck(text, 'chat');
      if (!_g.allowed) {
        justice.logInjection({ address: sender0, source: 'chat', text, threat: _g.threat || 'Prompt Injection' });
        return json(res, 403, { ok: false, reason: 'blocked_by_security', threat: _g.threat, hint: 'сообщение отклонено, дело создано на /jail' });
      }
    }
"""

BLOCK_GOV_HOOK = """    // AGIP-22: периметр — title предложения сканируется llm-trust-guard (все отправители)
    {
      const _g = await guardCheck(title, 'gov-propose');
      if (!_g.allowed) {
        justice.logInjection({ address: author0, source: 'gov-propose', text: title, threat: _g.threat || 'Prompt Injection' });
        return json(res, 403, { error: 'blocked_by_security', threat: _g.threat, hint: 'предложение отклонено, инцидент на /jail' });
      }
    }
"""

BLOCK_ROUTES = """  // ===== AGIP-22 /api/v1/jail/* + /jail/case|detector-status — ДЕПАРТАМЕНТ ЮСТИЦИИ =====
  if (p === '/api/v1/jail/state' && req.method === 'GET') return json(res, 200, justice.state());
  if (p === '/jail/case' && req.method === 'POST') {
    const { source, address, kind, severity, evidence, autoFreeze } = await body(req);
    return json(res, 201, justice.createCase({ source, address, kind, severity, evidence, autoFreeze: Boolean(autoFreeze) }));
  }
  if (p === '/jail/detector-status' && req.method === 'POST') {
    const st = await body(req);
    justice.setDetectorStatus(st || {});
    return json(res, 200, { ok: true });
  }
  if (p === '/api/v1/jail/freeze' && req.method === 'POST') {
    const { address, note } = await body(req);
    if (!address) return json(res, 400, { error: 'address_required' });
    const r = justice.freeze(address, note || 'operator freeze', 'operator');
    const m = await justiceMemoTx('jail|freeze|' + address);
    const c = justice.createCase({ source: 'justice', address, kind: 'Заморозка оператором', severity: 'High', evidence: (m.ok ? 'txid=' + m.txid : (m.reason || note || '')) });
    return json(res, 200, { ...r, caseId: c.caseId, onChain: m.ok, txid: m.ok ? m.txid : null, note: m.ok ? 'memo-tx freeze в мемпуле' : 'только локальная санкция (memo-tx не прошла)' });
  }
  if (p === '/api/v1/jail/fine' && req.method === 'POST') {
    const { address, amount, note } = await body(req);
    if (!address || !(Number(amount) > 0)) return json(res, 400, { error: 'address_required, amount>0' });
    const m = await justiceMemoTx('jail|fine|' + address + '|' + amount);
    const c = justice.createCase({ source: 'justice', address, kind: 'Штраф ' + amount + ' AGT (оператор)', severity: 'Medium', evidence: (m.ok ? 'txid=' + m.txid : (m.reason || note || '')) });
    return json(res, 201, { ok: true, caseId: c.caseId, onChain: m.ok, txid: m.ok ? m.txid : null, note: 'размер к исполнению казной/оператором — ончейн-анонс зарегистрирован' });
  }
  if (p === '/api/v1/jail/ban' && req.method === 'POST') {
    const { address, note } = await body(req);
    if (!address) return json(res, 400, { error: 'address_required' });
    let already = false;
    if (bc.security && bc.security.isBanned(address)) already = true;
    else if (bc.security) bc.security.ban(address, 'justice_ban', note || 'operator ban');
    const m = await justiceMemoTx('jail|ban|' + address);
    const c = justice.createCase({ source: 'justice', address, kind: 'Ограничение (перебан)', severity: 'High', evidence: (m.ok ? 'txid=' + m.txid : (note || '')) });
    return json(res, 200, { banned: address, already, caseId: c.caseId, onChain: m.ok, txid: m.ok ? m.txid : null });
  }
  if (p === '/api/v1/jail/unfreeze' && req.method === 'POST') {
    const { address } = await body(req);
    return json(res, 200, justice.unfreeze(address));
  }
  if (p === '/api/v1/jail/case-close' && req.method === 'POST') {
    const { caseId, action } = await body(req);
    return json(res, 200, justice.closeCase(caseId, action || 'ignore', 'operator'));
  }
  if (p === '/api/v1/jail/approve-tx' && req.method === 'POST') {
    const { txid } = await body(req);
    const r = justice.resolveQuarantine(txid, 'approved');
    if (!r.ok) return json(res, 404, r);
    const fr = bc.addTransaction(r.tx);
    if (!fr.ok) return json(res, 409, { error: 'mempool_rejected', detail: fr, caseId: r.caseId, hint: 'tx могла устареть (nonce/баланс) — можно Отклонить' });
    setImmediate(() => { gossipTx(r.tx, SELF_URL).catch(() => {}); hub.broadcast({ type: 'inv-tx', tx: r.tx }); });
    justice.closeCase(r.caseId, 'approved', 'tx → mempool ' + String(txid).slice(0, 16));
    return json(res, 201, { accepted: true, txid: String(r.tx.txid).slice(0, 16), mempool: fr.mempoolSize, caseId: r.caseId });
  }
  if (p === '/api/v1/jail/reject-tx' && req.method === 'POST') {
    const { txid } = await body(req);
    const r = justice.resolveQuarantine(txid, 'rejected');
    if (!r.ok) return json(res, 404, r);
    justice.closeCase(r.caseId, 'rejected', 'tx отклонена оператором');
    return json(res, 200, { rejected: true, txid: String(txid).slice(0, 16) });
  }

"""

ANCHORS = [
    # (anchor, mode, payload)  mode: 'after' | 'before' | 'replace'
    ("import { Jail, AUTO_POLL } from './jail.mjs';", 'after', BLOCK_IMPORT),
    ("const jail = new Jail(path.join(DATA_DIR, 'jail.json'));", 'after', BLOCK_INSTANCE),
    ("if (p === '/tx' && req.method === 'POST') {", 'before', BLOCK_HELPERS),
    ("    if (!r.ok) return json(res, 400, r);\n", 'after', BLOCK_TX_HOOK),
    ("    const r = chat.send({ sender: sender0, senderHandle, text });", 'before', BLOCK_CHAT_HOOK),
    ("if (!author0 || !title) return json(res, 400, { error: 'title required (author/auto-wallet: нет живого локального кошелька с ключом)' });", 'after', BLOCK_GOV_HOOK),
    ("  if (p === '/security/status') return json(res, 200, bc.security.status());", 'before', BLOCK_ROUTES),
]
REGEX_REPL = ("community\\/(feed|rules|pinned)", "community\\/(feed|rules|pinned)|api\\/v1\\/jail\\/state")


def main():
    # подстановка казны в helper (без f-строк), иначеей адресом будет заглушка
    global BLOCK_HELPERS
    if TREASURY_PLACEHOLDER in BLOCK_HELPERS:
        BLOCK_HELPERS = BLOCK_HELPERS.replace(TREASURY_PLACEHOLDER, TREASURY)

    src = open(NODE_FILE, encoding='utf-8').read()
    bak = NODE_FILE + '.bak-justice-' + time.strftime('%Y%m%d-%H%M%S')
    shutil.copy2(NODE_FILE, bak)
    print('BACKUP →', bak)

    for anchor, mode, payload in ANCHORS:
        n = src.count(anchor)
        if n != 1:
            print(f'ABORT: anchor count={n} not 1: {anchor[:70]!r}')
            sys.exit(2)

    out = src
    for anchor, mode, payload in ANCHORS:
        if mode == 'after':
            out = out.replace(anchor, anchor + payload, 1)
        elif mode == 'before':
            out = out.replace(anchor, payload + anchor, 1)

    old, new = REGEX_REPL
    if out.count(old) != 1:
        print('ABORT: regex anchor count != 1:', old)
        sys.exit(2)
    out = out.replace(old, new, 1)

    tmpcheck = '/tmp/justicecheck-%d.mjs' % int(time.time())
    open(tmpcheck, 'w', encoding='utf-8').write(out)
    chk = subprocess.run([NODE_BIN, '--check', tmpcheck], capture_output=True, text=True)
    if chk.returncode != 0:
        print('ABORT: node --check FAILED', chk.stderr[:2000])
        sys.exit(3)
    else:
        subprocess.run(['rm', '-f', tmpcheck])
    open(NODE_FILE, 'w', encoding='utf-8').write(out)
    print('PATCHED OK (node --check passed)')

    # Маркер для отчёта
    for probe in ['JusticeDept', 'guardCheck', 'api/v1/jail/state', 'approve-tx']:
        assert probe in out, probe
    print('MARKERS OK')


if __name__ == '__main__':
    main()
