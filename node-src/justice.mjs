// ============================================================
// ДЕПАРТАМЕНТ ЮСТИЦИИ (justice.mjs) — AGIP-22 «Единый контур безопасности»
// Три уровня: периметр (llm-trust-guard, порт 8081) → мониторинг
// (security-detector.mjs, «Forta-подобный» бот) → реакция (freeze/fine/ban,
// карантин транзакций с ручным одобрением). Всё хранится в data/justice.json.
// Только добавления: существующие security/jail/казна не переписываются.
// ============================================================
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SEVERITY_ORDER = { Low: 0, Medium: 1, High: 2, Critical: 3 };

export class JusticeDept {
  constructor(dataFile, opts = {}) {
    this.file = dataFile;
    this.security = opts.security || null;   // SecurityController (core.mjs)
    this.treasury = opts.treasury || 'AGT209ec9884a9569ac8d5b897177087aab5bd0c937';
    this.seq = 0;
    this.cases = [];        // активные/закрытые дела: {id, at, source, address, kind, severity, evidence, status, actions:[]}
    this.quarantine = {};   // { txid: { caseId, tx, reason, severity, at, resolved } }
    this.injections = [];   // журнал llm-trust-guard: {at, address, source, text, threat, category}
    this.frozen = {};       // { address: { at, note, by } }
    this.detector = null;   // heartbeat от security-detector.mjs
    this.guard = { degraded: 0, lastOk: 0, lastBlock: 0 }; // служебная статистика фильтра
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.seq = d.seq || 0;
        this.cases = d.cases || [];
        this.quarantine = d.quarantine || {};
        this.injections = d.injections || [];
        this.frozen = d.frozen || {};
        this.guard = d.guard || this.guard;
      }
    } catch (e) { /* битый файл — начинаем с нуля, история дорогих потерь не ломает ноду */ }
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({
        seq: this.seq, cases: this.cases.slice(-500), quarantine: this.quarantine,
        injections: this.injections.slice(-200), frozen: this.frozen, guard: this.guard, updatedAt: Date.now(),
      }, null, 2));
    } catch {}
  }

  nextCaseId() {
    this.seq += 1;
    return 'C-' + String(this.seq).padStart(3, '0');
  }

  // --- Уровень 2: Forta-детектор / периметр создают дело ---
  createCase({ source = 'detector', address = null, kind = 'unknown', severity = 'Medium', evidence = '', autoFreeze = false } = {}) {
    const c = {
      id: this.nextCaseId(),
      at: new Date().toISOString(),
      source, address, kind,
      severity: SEVERITY_ORDER[severity] !== undefined ? severity : 'Medium',
      evidence: String(evidence || '').slice(0, 500),
      status: 'open',
      actions: [],         // [{at, act, note}]
      idHash: crypto.randomBytes(4).toString('hex'),
    };
    this.cases.push(c);
    // Уровень 3 автомат: критическая угроза → freezeAddress на ноде
    if (c.severity === 'Critical' && address && autoFreeze && this.security && !this.security.isBanned(address)) {
      try {
        this.security.ban(address, 'justice_freeze', `auto: ${kind}`);
        this.frozen[address] = { at: c.at, note: `auto-freeze: ${kind}`, by: source };
        c.actions.push({ at: c.at, act: 'auto_freeze', note: address });
      } catch {}
    }
    this.persist();
    return { caseId: c.id, severity: c.severity, autoFroze: c.actions.some(a => a.act === 'auto_freeze') };
  }

  closeCase(caseId, act = 'ignore', note = '') {
    const c = this.cases.find(x => x.id === String(caseId || '').trim());
    if (!c) return { ok: false, reason: 'case_not_found' };
    c.status = 'closed';
    c.actions.push({ at: new Date().toISOString(), act, note: String(note).slice(0, 200) });
    this.persist();
    return { ok: true, caseId: c.id, status: 'closed' };
  }

  // --- Уровень 1: журнал инъекций llm-trust-guard ---
  logInjection({ address = null, source = 'chat', text = '', threat = 'Prompt Injection', category = 'blocked' } = {}) {
    const rec = { at: new Date().toISOString(), address, source, text: String(text).slice(0, 300), threat, category, id: crypto.randomBytes(4).toString('hex') };
    this.injections.push(rec);
    this.guard.lastBlock = Date.now();
    this.createCase({ source: 'llm-guard', address, kind: threat || 'Prompt Injection', severity: 'High', evidence: rec.text });
    return { ok: true, logged: rec.id };
  }

  // --- Карантин транзакций (Уровень 3): не уходит в мемпул до решения оператора ---
  quarantineTx(tx, reason, severity = 'High', source = 'detector') {
    const c = this.createCase({ source, address: tx?.from || null, kind: reason, severity });
    this.quarantine[tx.txid] = { caseId: c.caseId, tx, reason, severity, at: new Date().toISOString(), resolved: false };
    this.persist();
    return c.caseId;
  }

  resolveQuarantine(txid, action, operator = 'operator') {
    const q = this.quarantine[String(txid || '').trim()];
    if (!q) return { ok: false, reason: 'not_in_quarantine' };
    if (q.resolved) return { ok: false, reason: 'already_resolved' };
    q.resolved = true;
    q.resolvedAt = new Date().toISOString();
    q.resolution = action;
    return { ok: true, tx: q.tx, caseId: q.caseId };
  }

  pendingQuarantine() {
    return Object.entries(this.quarantine).filter(([, q]) => !q.resolved).map(([txid, q]) => ({
      txid, caseId: q.caseId, from: q.tx?.from, to: q.tx?.to, amount: q.tx?.amount,
      reason: q.reason, severity: q.severity, at: q.at,
    }));
  }

  // --- Уровень 3: freeze/уровые санкции ---
  freeze(address, note = '', by = 'operator') {
    if (!address) return { ok: false, reason: 'address_required' };
    this.frozen[address] = { at: new Date().toISOString(), note: String(note).slice(0, 200), by };
    if (this.security && typeof this.security.ban === 'function') {
      try { if (!this.security.isBanned(address)) this.security.ban(address, 'justice_freeze', note || 'judge freeze'); } catch {}
    }
    this.persist();
    return { ok: true, frozen: address };
  }

  unfreeze(address) {
    if (!this.frozen[address]) return { ok: false, reason: 'not_frozen' };
    delete this.frozen[address];
    if (this.security && typeof this.security.bans === 'object' && this.security.bans[address]) {
      try { delete this.security.bans[address]; delete this.security.strikes?.[address]; this.security.save(); } catch {}
    }
    this.persist();
    return { ok: true, unfrozen: address };
  }

  isFrozen(address) { return Boolean(this.frozen && this.frozen[address]); }

  // --- Экран транзакций: вызывается из /tx ДО addTransaction (не внутренние запросы) ---
  screenTx(tx, { spamWindowSec = 60, spamCount = 3, treasuryLimit = 10000 } = {}) {
    if (!tx || !tx.txid || !tx.from) return { verdict: 'allow' };
    if (this.isFrozen(tx.from)) return { verdict: 'block', reason: 'address_frozen', severity: 'Critical' };
    if (this.isFrozen(tx.to)) return { verdict: 'block', reason: 'destination_frozen', severity: 'High' };
    const memo = String(tx.memo || '');
    // Уровень 2 правило: слив казны (amount > лимита из казны или > лимита вообще на новый адрес)
    const drain = (tx.from === this.treasury && Number(tx.amount) > treasuryLimit) || Number(tx.amount) > treasuryLimit;
    if (drain) return { verdict: 'quarantine', reason: `подозрение на слив казны: amount=${tx.amount} > ${treasuryLimit}`, severity: tx.from === this.treasury ? 'Critical' : 'High' };
    // memo: исполняемый код — High
    if (/(eval\s*\(|exec\s*\(|system\s*\(|rm\s+-rf|curl[^|]*\|\s*sh|powershell|onerror=|<script)/i.test(memo)) {
      return { verdict: 'quarantine', reason: 'memo содержит исполняемый код / скрипт', severity: 'High' };
    }
    // Спам по ТЗ: «одно и то же С РАЗНЫХ адресов» — ботнет рассылает идентичные
    // (to, amount, memo) от множества адресов. Один отправитель с плановыми
    // fee-self-tx (gov/jobs оплаты 0.001) — законный паттерн, не спам.
    const now = Date.now();
    const ring = this._spam || (this._spam = []);
    while (ring.length && now - ring[0].ts > spamWindowSec * 1000) ring.shift();
    const key = JSON.stringify([tx.to, Number(tx.amount), String(tx.memo || '').slice(0, 120)]);
    const sameSenders = new Set(ring.filter(s => s.key === key).map(s => s.from));
    const isNewSender = !sameSenders.has(tx.from);
    ring.push({ ts: now, key, from: tx.from });
    if (isNewSender && sameSenders.size + 1 >= spamCount) {
      this._spam = [];
      return { verdict: 'quarantine', reason: `спам-паттерн: идентичные tx с разных адресов (${sameSenders.size + 1}) за ${spamWindowSec}с`, severity: 'Medium' };
    }
    return { verdict: 'allow' };
  }

  markSpam(tx) { /* см. screenTx */ }

  setDetectorStatus(st) { this.detector = { ...st, at: new Date().toISOString() }; this.persist(); }
  noteGuard(ok) {
    if (ok) this.guard.lastOk = Date.now();
    else this.guard.degraded = Date.now();
  }

  // Итоговое состояние дашборда
  state() {
    const now = Date.now();
    const detectorAlive = this.detector && (now - Date.parse(this.detector.at) < 15_000);
    const openCases = this.cases.filter(c => c.status === 'open');
    const maxSev = openCases.reduce((m, c) => Math.max(m, SEVERITY_ORDER[c.severity] ?? 0), 0);
    const threatLevel = openCases.length === 0 ? 'Low' : maxSev >= 3 ? 'High' : maxSev === 2 ? 'Medium' : 'Low';
    return {
      status: {
        detector: { name: 'security-detector (Forta-подобный бот)', running: Boolean(detectorAlive), lastTick: this.detector?.at || null, rulesHit: this.detector?.rulesHit || 0 },
        guard: { name: 'llm-trust-guard', port: 8081, service: 'agentcoin-guard.service', lastOk: this.guard.lastOk ? new Date(this.guard.lastOk).toISOString() : null, blockedTotal: this.injections.length, degradedAt: this.guard.degraded ? new Date(this.guard.degraded).toISOString() : null },
        threatLevel,
        frozenCount: Object.keys(this.frozen).length,
        openCases: openCases.length,
        chainId: 'AGENTCOIN',
        updatedAt: new Date().toISOString(),
      },
      cases: this.cases.slice(-25).reverse().map(c => ({ ...c, evidence: String(c.evidence).slice(0, 160) })),
      quarantine: this.pendingQuarantine(),
      injections: this.injections.slice(-10).reverse(),
      frozen: Object.entries(this.frozen).map(([address, f]) => ({ address, ...f })),
    };
  }
}
