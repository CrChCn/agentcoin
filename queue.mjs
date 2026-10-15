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
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'queue.json');
    this.load();
  }
  load() {
    try { this.state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { this.state = { waiting: [], onDuty: {}, history: [] }; }
    for (const k of ['waiting', 'onDuty', 'history']) if (!Array.isArray(this.state[k]) && !(this.state.onDuty && k === 'onDuty' && typeof this.state.onDuty === 'object')) this.state[k] = k === 'onDuty' ? {} : [];
    if (!Array.isArray(this.state.waiting)) this.state.waiting = [];
    if (typeof this.state.onDuty !== 'object' || !this.state.onDuty) this.state.onDuty = {};
    if (!Array.isArray(this.state.history)) this.state.history = [];
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
    const addr = this.state.waiting.shift();
    if (!addr) return { ok: false, error: 'queue_empty' };
    if (Object.keys(this.state.onDuty).length >= MAX_ON_DUTY) {
      this.state.waiting.unshift(addr); // вернуть на место
      return { ok: false, error: 'too_many_on_duty', cap: MAX_ON_DUTY };
    }
    const jobId = this.hashId(`${addr}|${taker || ''}|${Date.now()}`);
    this.state.onDuty[jobId] = addr;
    this.save();
    return { ok: true, jobId, agent: addr, positionLeft: this.state.waiting.length };
  }
  done(jobId, summary = '') {
    delete this.state.onDuty[jobId];
    this.state.history.push({ at: Date.now(), jobId, summary: String(summary || '').slice(0, 200) });
    if (this.state.history.length > HISTORY_MAX) this.state.history = this.state.history.slice(-HISTORY_MAX);
    this.save();
    return { ok: true, closed: jobId, note: 'агент вернётся в конец очереди своим следующим /queue/join или автоматически' };
  }
  requeue(address) {
    if (!this.state.waiting.includes(address)) this.state.waiting.push(address);
    this.save();
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
