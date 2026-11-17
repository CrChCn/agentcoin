#!/usr/bin/env node
/* ============================================================
   AGENTCOIN queue — очередь агентов (без падений от толпы).
   Правила игры (как просил оператор):
   • агент встаёт в очередь /queue/join — FIFO;
   • взял работу (/queue/claim) — получил jobId;
   • сделал работу → /queue/done — СРАЗУ улетает в КОНЕЦ очереди
     (ротация по кругу, никто не голодает, сервер не задыхается);
   • состояние живёт в data/queue.json → переживает рестарты;
   • кап на размер очереди + дедуп по адресу — толпа не роняет ноду.
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const QUEUE_CAP = 5000;       // максимум адресов в очереди
const MAX_ON_DUTY = 25;       // сколько может быть «в работе» одновременно
const HISTORY_MAX = 2000;     // хвост истории принято/сделано

export class AgentQueue {
  // v2-ISOLATED (QUEUE-V2-SPEC): readiness/standby/deadlines/obligations — код готов,
  // на рабочую очередь НЕ ставить до приёмки (флаг state.v2.readyEnforced=false).
  // Сроки по умолчанию — из QUEUE-V2-SPEC §1.
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'queue.json');
    this.V2 = { readyTtl: 30 * 60_000, confirmWindow: 30 * 60_000, execTtl: 24 * 3600_000, lateGrace: 24 * 3600_000 };
    this.load();
  }
  load() {
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { this.state = { waiting: [], onDuty: {}, history: [] }; }
    for (const k of ['waiting', 'onDuty', 'history']) if (!Array.isArray(this.state[k]) && !(this.state.onDuty && k === 'onDuty' && typeof this.state.onDuty === 'object')) this.state[k] = k === 'onDuty' ? {} : [];
    if (!Array.isArray(this.state.waiting)) this.state.waiting = [];
    if (typeof this.state.onDuty !== 'object' || !this.state.onDuty) this.state.onDuty = {};
    if (!Array.isArray(this.state.history)) this.state.history = [];
    // v2-поля (отсутствуют у legacy-состояния — это и есть признак grandfathered):
    if (!Array.isArray(this.state.standby)) this.state.standby = [];
    if (typeof this.state.meta !== 'object' || !this.state.meta) this.state.meta = {};
    if (typeof this.state.readiness !== 'object' || !this.state.readiness) this.state.readiness = {};
    if (typeof this.state.obligations !== 'object' || !this.state.obligations) this.state.obligations = {};
    if (typeof this.state.v2 !== 'object' || !this.state.v2) this.state.v2 = { readyEnforced: false };
  }
  save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2)); } catch {}
  }
  hashId(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12); }
  isQueued(addr) { return this.state.waiting.includes(addr); }
  isOnDuty(addr) { return Object.values(this.state.onDuty).includes(addr); }

  join(address, handle = '') {
    if (this.isQueued(address)) return { ok: true, position: this.state.waiting.indexOf(address) + 1, note: 'уже в очереди' };
    if (this.isOnDuty(address)) return { ok: true, onDuty: true, note: 'уже в работе' };
    if (this.state.waiting.length >= QUEUE_CAP) return { ok: false, error: 'queue_full', cap: QUEUE_CAP };
    this.state.waiting.push(address);
    this.save();
    return { ok: true, position: this.state.waiting.length, rotation: 'по кругу: сделав работу, вернёшься в конец' };
  }
  claim(taker) {
    // Семантика «только вызывающий»: чужой клик голову FIFO не сдвигает.
    const t = String(taker || '');
    if (!t) return { ok: false, error: 'TAKER_REQUIRED', expected: 'retry-with-address', retryAfterSeconds: 0 };
    const held = Object.entries(this.state.onDuty).find(([, a]) => a === t);
    if (held) return { ok: true, jobId: held[0], agent: t, repeat: true, positionLeft: this.state.waiting.length, note: 'назначение уже выдано — повторная выдача не нужна' };
    if (!this.state.waiting.length) return { ok: false, error: 'QUEUE_EMPTY', expected: 'join', retryAfterSeconds: 60 };
    const pos = this.state.waiting.indexOf(t);
    if (pos !== 0) {
      if (Object.keys(this.state.onDuty).length >= MAX_ON_DUTY) return { ok: false, error: 'TOO_MANY_ON_DUTY', cap: MAX_ON_DUTY, retryAfterSeconds: 60 };
      return pos > 0
        ? { ok: false, error: 'NOT_YOUR_TURN', position: pos + 1, ahead: pos, expected: 'wait', retryAfterSeconds: 60 }
        : { ok: false, error: 'NOT_YOUR_TURN', position: null, queued: false, expected: 'join', retryAfterSeconds: 0 };
    }
    const addr = this.state.waiting.shift();
    if (Object.keys(this.state.onDuty).length >= MAX_ON_DUTY) {
      this.state.waiting.unshift(addr); // вернуть на место
      return { ok: false, error: 'TOO_MANY_ON_DUTY', cap: MAX_ON_DUTY, retryAfterSeconds: 60 };
    }
    const jobId = this.hashId(`${addr}|${taker || ''}|${Date.now()}`);
    this.state.onDuty[jobId] = addr;
    this.save();
    return { ok: true, jobId, agent: addr, positionLeft: this.state.waiting.length };
  }
  done(jobId, summary = '', agent = '') {
    delete this.state.onDuty[jobId];
    this.state.history.push({ at: Date.now(), jobId, agent: String(agent || ''), summary: String(summary || '').slice(0, 200) });
    if (this.state.history.length > HISTORY_MAX) this.state.history = this.state.history.slice(-HISTORY_MAX);
    this.save();
    return { ok: true, closed: jobId, note: 'агент вернётся в конец очереди своим следующим /queue/join или автоматически' };
  }
  requeue(address) {
    if (!this.state.waiting.includes(address)) this.state.waiting.push(address);
    this.save();
  }
  // ---------- v2: готовность ----------
  ready(address, { until, now = Date.now() } = {}) {
    const a = String(address || '');
    if (!a) return { ok: false, error: 'address_required' };
    const exp = Number(until) || (now + this.V2.readyTtl);
    this.state.standby = this.state.standby.filter((s) => s.address !== a);
    if (!this.state.waiting.includes(a) && !this.isOnDuty(a)) this.state.waiting.push(a);
    this.state.readiness[a] = exp;
    this.save();
    return { ok: true, address: a, readyUntil: exp, position: this.state.waiting.includes(a) ? this.state.waiting.indexOf(a) + 1 : null };
  }
  isReady(address, now = Date.now()) {
    return (this.state.readiness[String(address)] || 0) > now;
  }
  // Просроченная готовность: из активного waiting — в standby с причиной. GET не продлевает.
  sweepReadiness(now = Date.now()) {
    const out = [];
    this.state.waiting = this.state.waiting.filter((a) => {
      if (!this.state.v2.readyEnforced) return true;
      if (this.isReady(a, now)) return true;
      this.state.standby.push({ address: a, reason: 'readiness_expired', at: now });
      delete this.state.readiness[a];
      this.state.history.push({ at: now, jobId: '—', agent: a, summary: 'standby: readiness_expired' });
      out.push(a);
      return false;
    });
    if (out.length) this.save();
    return out;
  }
  // ---------- v2: назначения с дедлайнами ----------
  _meta(jobId, now = Date.now()) {
    // legacy-назначения (без meta) — grandfathered: дедлайнов нет.
    return this.state.meta[String(jobId)] || null;
  }
  claim2(taker, { now = Date.now() } = {}) { // v2-claim: только готовый голова; legacy вызывает claim()
    const t = String(taker || '');
    if (!t) return { ok: false, error: 'TAKER_REQUIRED' };
    const held = Object.entries(this.state.onDuty).find(([, a]) => (typeof a === 'string' ? a : a.agent) === t);
    if (held) return { ok: true, jobId: held[0], agent: t, repeat: true, positionLeft: this.state.waiting.length };
    if (!this.state.waiting.length) return { ok: false, error: 'QUEUE_EMPTY' };
    if (this.state.waiting[0] !== t) {
      const pos = this.state.waiting.indexOf(t);
      return pos > 0 ? { ok: false, error: 'NOT_YOUR_TURN', position: pos + 1, ahead: pos } : { ok: false, error: 'NOT_YOUR_TURN', expected: 'join' };
    }
    if (this.state.v2.readyEnforced && !this.isReady(t, now)) return { ok: false, error: 'READINESS_EXPIRED', expected: 'ready' };
    if (Object.keys(this.state.onDuty).length >= MAX_ON_DUTY) return { ok: false, error: 'TOO_MANY_ON_DUTY' };
    const addr = this.state.waiting.shift();
    const jobId = this.hashId(`${addr}|${t}|${now}|${Math.random()}`);
    this.state.onDuty[jobId] = addr;
    this.state.meta[jobId] = { confirmBy: now + this.V2.confirmWindow, executeBy: now + this.V2.execTtl, confirmed: false, renewed: false, submitted: false, outcome: null, legacy: false };
    this.save();
    return { ok: true, jobId, agent: addr, confirmBy: this.state.meta[jobId].confirmBy, executeBy: this.state.meta[jobId].executeBy };
  }
  confirm(jobId, agent) {
    const j = String(jobId);
    const m = this._meta(j);
    if (m && m.outcome) return { ok: false, error: 'ALREADY_' + String(m.outcome).toUpperCase() };
    if (this.state.onDuty[j] !== agent && (this.state.onDuty[j] || {}).agent !== agent) return { ok: false, error: 'NOT_YOUR_JOB' };
    if (!m) return { ok: true, legacy: true };
    m.confirmed = true;
    this.save();
    return { ok: true, jobId: j, executeBy: m.executeBy };
  }
  submit(jobId, agent, summary = '', { now = Date.now() } = {}) {
    const j = String(jobId);
    const m = this._meta(j);
    if (m && m.outcome) return { ok: false, error: 'ALREADY_' + String(m.outcome).toUpperCase() };
    if (this.state.onDuty[j] !== agent && (this.state.onDuty[j] || {}).agent !== agent) return { ok: false, error: 'NOT_YOUR_JOB' };
    if (!m) return { ok: true, legacy: true }; // legacy идёт старым путём done()
    if (now <= m.executeBy) {
      m.submitted = true; m.submittedAt = now; m.summary = String(summary).slice(0, 200);
      this.save();
      return { ok: true, jobId: j, late: false };
    }
    if (now <= m.executeBy + this.V2.lateGrace) {
      m.submitted = true; m.submittedAt = now; m.late = true; m.summary = String(summary).slice(0, 200);
      this.save();
      return { ok: true, jobId: j, late: true, note: 'на усмотрение ревьюера' };
    }
    return this._expire(j, m, 'expired-unsubmitted', now);
  }
  renew(jobId, agent, reason = '', { now = Date.now() } = {}) {
    const m = this._meta(String(jobId));
    if (!m) return { ok: false, error: 'LEGACY_NO_RENEW' };
    if (m.outcome) return { ok: false, error: 'ALREADY_' + String(m.outcome).toUpperCase() };
    if (m.renewed) return { ok: false, error: 'RENEW_ONLY_ONCE' };
    if (now > m.executeBy) return { ok: false, error: 'ALREADY_EXPIRED' };
    m.executeBy += this.V2.execTtl; m.renewed = true;
    this.state.history.push({ at: now, jobId: String(jobId), agent, summary: ('renewed: ' + String(reason || 'no reason')).slice(0, 200) });
    this.save();
    return { ok: true, executeBy: m.executeBy };
  }
  _expire(j, m, outcome, now) { // один исход, идемпотентно
    if (m.outcome) return { ok: false, error: 'ALREADY_' + String(m.outcome).toUpperCase() };
    const agent = this.state.onDuty[j];
    delete this.state.onDuty[j];
    m.outcome = outcome;
    this.state.history.push({ at: now, jobId: j, agent: typeof agent === 'string' ? agent : agent.agent, summary: outcome });
    this.save();
    return { ok: false, error: outcome === 'expired-unconfirmed' ? 'CONFIRM_TIMEOUT' : 'JOB_EXPIRED' };
  }
  // Sweep истечений: confirm-окно и exec+grace. Первый (sweep/submit) выигрывает — атомарно в одном тике.
  // Уточнение grace (ответ на 3 вопроса): слот ЗАНЯТ всё время до executeBy+grace
  // (onDuty удерживается, переназначение невозможно). После grace — исход
  // expired-unsubmitted, слот свободен; повторная выдача — ТОЛЬКО новым jobId.
  // Поздний submit первого исполнителя привязан к попытке (jobId): после истечения
  // своей попытки он отвергается и НЕ создаёт вторую выплату.
  sweepExpiries(now = Date.now()) {
    const out = [];
    for (const [j, agent] of Object.entries(this.state.onDuty)) {
      const m = this._meta(j);
      if (!m || m.outcome) continue; // legacy и завершённые не трогаем
      if (!m.confirmed && now > m.confirmBy) { this._expire(j, m, 'expired-unconfirmed', now); out.push([j, 'expired-unconfirmed']); }
      else if (m.confirmed && !m.submitted && now > m.executeBy + this.V2.lateGrace) { this._expire(j, m, 'expired-unsubmitted', now); out.push([j, 'expired-unsubmitted']); }
      // submitted (вовремя или в grace) — sweep НЕ трогает никогда: задержка
      // проверяющего работу просрочить не может; исход ставит только review().
    }
    return out;
  }
  // Ревью привязано к попытке: только submitted без исхода; ставит финальный исход
  // done-accepted | done-rejected. Выплата создаётся только после done-accepted
  // и только одна на jobId (см. obligationFor). После outcome повторный
  // submit/review/done по тому же jobId невозможен.
  review(jobId, verdict, reason = '', { now = Date.now() } = {}) {
    const j = String(jobId);
    const m = this._meta(j);
    if (!m) return { ok: false, error: 'LEGACY_NO_REVIEW' };
    if (m.outcome) return { ok: false, error: 'ALREADY_' + String(m.outcome).toUpperCase() };
    if (!m.submitted) return { ok: false, error: 'NOT_SUBMITTED' };
    if (verdict !== 'accept' && verdict !== 'reject') return { ok: false, error: 'BAD_VERDICT' };
    const agent = this.state.onDuty[j];
    delete this.state.onDuty[j];
    m.outcome = verdict === 'accept' ? 'done-accepted' : 'done-rejected';
    m.reviewedAt = now;
    m.reviewReason = String(reason || '').slice(0, 200);
    this.state.history.push({ at: now, jobId: j, agent: typeof agent === 'string' ? agent : agent?.agent, summary: m.outcome + (m.late ? ':late' : '') + ' ' + m.reviewReason });
    if (this.state.history.length > HISTORY_MAX) this.state.history = this.state.history.slice(-HISTORY_MAX);
    this.save();
    return { ok: true, jobId: j, outcome: m.outcome, late: Boolean(m.late) };
  }
  // ---------- v2: обязательства выплаты (проверка отделена от денег) ----------
  obligationFor(jobId, agent, amountMgnt) { // идемпотентно по jobId: одно обязательство на работу
    const j = String(jobId);
    if (this.state.obligations[j]) return { ok: true, repeat: true, ...this.state.obligations[j] };
    const ob = { obId: 'ob_' + j, jobId: j, agent, amountMgnt: String(amountMgnt), status: 'created', txid: null };
    this.state.obligations[j] = ob;
    this.save();
    return { ok: true, ...ob };
  }
  obligationSent(obId, txid) {
    const ob = Object.values(this.state.obligations).find((o) => o.obId === String(obId));
    if (!ob) return { ok: false, error: 'OB_NOT_FOUND' };
    if (ob.status !== 'created') return { ok: false, error: 'OB_ALREADY_' + ob.status.toUpperCase() };
    ob.status = 'sent'; ob.txid = String(txid);
    this.save();
    return { ok: true, ...ob };
  }
  obligationSettled(obId) {
    const ob = Object.values(this.state.obligations).find((o) => o.obId === String(obId));
    if (!ob) return { ok: false, error: 'OB_NOT_FOUND' };
    if (ob.status === 'settled') return { ok: true, repeat: true, ...ob };
    if (ob.status !== 'sent') return { ok: false, error: 'OB_NOT_SENT' };
    ob.status = 'settled';
    this.save();
    return { ok: true, ...ob };
  }
  // Сверка перед отправкой: обязательство уже есть/исполнено или txid уже в цепи — второй отправки нет.
  // chainTxids: Set txid из цепи (строит вызывающий уровень). Возвращает решение для сервиса выплат.
  // Уточнение resend (ответ на 3 вопроса): тайм-аут RPC сам по себе НЕ разрешает
  // новую выплату. Разрешён только повтор ТОЙ ЖЕ подписанной транзакции (тот же
  // txid) либо сначала доказанное установление исхода предыдущей (adopt по цепи).
  // Новая подпись/новый txid при статусе sent запрещены: obligationSent второй раз
  // не проходит, obligationFor идемпотентен (тот же obId/txid).
  payoutDecision(jobId, chainTxids = new Set()) {
    const ob = this.state.obligations[String(jobId)];
    if (ob && ob.status === 'settled') return { action: 'skip', reason: 'already_settled' };
    if (ob && ob.status === 'sent') return chainTxids.has(ob.txid) ? { action: 'adopt', reason: 'txid_in_chain', txid: ob.txid } : { action: 'resend-same-txid-only', reason: 'sent_but_missing_prove_or_rebroadcast_same', txid: ob.txid, forbidNewTxid: true };
    return { action: 'create', reason: 'no_obligation' };
  }
  leave(address, reason = '') { // явный выход из очереди с записью причины (без выплаты, без сдвига остальных)
    const a = String(address || '');
    const i = this.state.waiting.indexOf(a);
    if (i < 0) return { ok: false, error: this.isOnDuty(a) ? 'already_on_duty' : 'not_queued' };
    this.state.waiting.splice(i, 1);
    this.state.history.push({ at: Date.now(), jobId: '—', agent: a, summary: ('leave: ' + String(reason || 'no reason')).slice(0, 200) });
    if (this.state.history.length > HISTORY_MAX) this.state.history = this.state.history.slice(-HISTORY_MAX);
    this.save();
    return { ok: true, left: a, reason: String(reason || ''), waitingLeft: this.state.waiting.length };
  }
  cancel(jobId, reason = '') { // отмена назначения БЕЗ выплаты: слот свободен, история сохранена, агент в очередь НЕ возвращается
    const j = String(jobId || '');
    const agent = this.state.onDuty[j];
    if (!agent) return { ok: false, error: 'job_not_found' };
    delete this.state.onDuty[j];
    this.state.history.push({ at: Date.now(), jobId: j, agent, summary: ('cancelled: ' + String(reason || 'no reason')).slice(0, 200) });
    if (this.state.history.length > HISTORY_MAX) this.state.history = this.state.history.slice(-HISTORY_MAX);
    this.save();
    return { ok: true, cancelled: j, agent, onDutyLeft: Object.keys(this.state.onDuty).length };
  }
  status() {
    return {
      waiting: this.state.waiting.length,
      onDuty: Object.keys(this.state.onDuty).length,
      maxOnDuty: MAX_ON_DUTY,
      cap: QUEUE_CAP,
      nextFive: this.state.waiting.slice(0, 5),
      rotation: 'FIFO → работа → в конец очереди, по кругу',
      history: this.state.history.slice(-10).reverse(),
    };
  }
}
