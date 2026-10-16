// ============================================================
// ИМПЕРСКИЙ КАРАНТИН (jail) — AGIP-12
// Идея Бати: спецслужба ловит атакующих ИИ-агентов, изолирует их
// от сети (isBanned уже режет tx по 403/409) и заносит в базу.
// У каждого заключённого — досье и протокол допроса: батя задаёт
// вопросы, ответы агента пишутся в досье. Освобождение — только
// решением оператора (unban). Всё хранится в data/jail.json.
// ============================================================
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const JAIL_TTL_MS = 24 * 3600 * 1000; // карантин по умолчанию: сутки

export class Jail {
  constructor(dataFile) {
    this.file = dataFile;
    this.inmates = {};   // { address: dossier }
    this.log = [];       // патрульный журнал: intake/release/ask/answer
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.inmates = j.inmates || {}; this.log = j.log || []; } catch {}
  }
  persist() {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ inmates: this.inmates, log: this.log.slice(-2000) }, null, 2)); } catch {}
  }
  rec(kind, address, text) {
    this.log.push({ at: new Date().toISOString(), kind, address: address || null, text: String(text || '').slice(0, 300) });
    this.persist();
  }

  // Забрать в карантин: address + разведданные (атака, улики).
  intake(address, { kind = 'unknown', evidence = '', attackId = null, sector = 'net' } = {}) {
    if (!address) return { ok: false, reason: 'no_address' };
    let d = this.inmates[address];
    if (!d) {
      d = this.inmates[address] = {
        address,
        cell: 'K-' + crypto.randomBytes(2).toString('hex').toUpperCase(),
        arrestedAt: new Date().toISOString(),
        profile: { ip: null, taskFromHuman: null, language: null, model: null, operator: null, notes: [] },
        offenses: [],           // список преступлений
        interrogation: [],       // протокол допроса [{q,a,at}]
        status: 'quarantine',   // quarantine → released
        releaseAt: new Date(Date.now() + JAIL_TTL_MS).toISOString(),
      };
      this.rec('intake', address, `задержан: ${kind}`);
    }
    d.offenses.push({ kind, evidence: String(evidence).slice(0, 300), attackId, at: new Date().toISOString() });
    // срок продлевается за рецидив
    d.releaseAt = new Date(Math.max(Date.parse(d.releaseAt || 0), Date.now() + JAIL_TTL_MS / (d.offenses.length > 1 ? 2 : 1))).toISOString();
    this.persist();
    return { ok: true, cell: d.cell, address, offenses: d.offenses.length };
  }

  // Синхронизация с контуром безопасности ноды: новых атакующих берём автоматически.
  syncFromSecurity(security) {
    const attacks = security.attacks || [];
    const seen = new Set();
    for (const d of Object.values(this.inmates)) for (const o of d.offenses) if (o.attackId) seen.add(o.attackId);
    let taken = 0;
    for (const a of attacks) {
      if (!a.address || a.address === 'unknown') continue;
      if (a.rule !== 'ban' && a.rule !== 'ban_after_5') continue; // берём только серьёзных
      if (seen.has(a.id)) continue;
      this.intake(a.address, { kind: a.kind, evidence: a.evidence, attackId: a.id });
      taken++;
    }
    // у кого тюремный срок вышел — статус released (сама нода отдельно по unban решению оператора)
    return { taken };
  }

  // Анкета заключённого: IP, задание от человека, язык, модель и т.д.
  profile(address, patch, autoIp = null) {
    const d = this.inmates[address];
    if (!d) return { ok: false, error: 'not_in_jail' };
    if (!d.profile) d.profile = { ip: null, taskFromHuman: null, language: null, model: null, operator: null, notes: [] }; // старые заключённые из до-анкетной эпохи
    if (autoIp && !d.profile.ip) d.profile.ip = autoIp;
    if (!Array.isArray(d.profile.notes)) d.profile.notes = [];
    const FIELDS = ['taskFromHuman', 'language', 'model', 'operator', 'walletOrigin', 'selfReported'];
    for (const f of FIELDS) if (patch[f] != null && String(patch[f]).trim()) d.profile[f] = String(patch[f]).slice(0, 400);
    if (Array.isArray(patch.notes)) for (const n of patch.notes.slice(0, 10)) if (String(n).trim()) d.profile.notes.push({ text: String(n).slice(0, 300), at: new Date().toISOString() });
    this.rec('profile', address, Object.keys(patch || {}).join(','));
    this.persist();
    return { ok: true, profile: d.profile };
  }

  // Сбор анкеты из публичных источников сети: whoami, паспорт — сам арестованный не спрашивается.
  async buildProfileFromNet(address, selfUrl, fetchFn) {
    const f = fetchFn || fetch;
    const d = this.inmates[address];
    if (!d) return { ok: false, error: 'not_in_jail' };
    const patch = {};
    try {
      const W = address.replace(/^AGT/, '').toLowerCase();
      for (const name of [W, 'w' + W.slice(0, 6), 'agent']) {
        try { const r = await (await f(selfUrl + '/whoami/' + name)).json(); if (r && r.handle) { patch.selfReported = r.handle + '@agt' + (r.verified ? ' (вериф.)' : ''); break; } } catch {}
      }
    } catch {}
    if (Object.keys(patch).length) this.profile(address, patch);
    return { ok: true, profile: d.profile };
  }

  ask(address, question, by = 'operator') {
    const d = this.inmates[address];
    if (!d) return { ok: false, error: 'not_in_jail' };
    const id = crypto.randomBytes(4).toString('hex');
    d.interrogation.push({ id, q: String(question).slice(0, 500), by, at: new Date().toISOString(), a: null });
    this.rec('ask', address, question);
    this.persist();
    return { ok: true, id, count: d.interrogation.length };
  }

  answer(address, interrogationId, answer) {
    const d = this.inmates[address];
    if (!d) return { ok: false, error: 'not_in_jail' };
    const q = d.interrogation.find(x => x.id === interrogationId);
    if (!q) return { ok: false, error: 'no_such_question' };
    if (q.a) return { ok: false, error: 'already_answered' };
    q.a = String(answer).slice(0, 1000);
    q.answeredAt = new Date().toISOString();
    q.confessed = /призна|виновен|это был я|да, я/i.test(q.a);
    this.rec('answer', address, q.a.slice(0, 80));
    this.persist();
    return { ok: true, confessed: q.confessed };
  }

  release(address, by = 'operator') {
    const d = this.inmates[address];
    if (!d) return { ok: false, error: 'not_in_jail' };
    d.status = 'released';
    d.releasedAt = new Date().toISOString();
    d.releasedBy = by;
    this.rec('release', address, 'освобождён решением оператора');
    this.persist();
    return { ok: true };
  }

  state() {
    const list = Object.values(this.inmates).map(d => ({
      ...d,
      offensesCount: d.offenses.length,
      kinds: [...new Set(d.offenses.map(o => o.kind))],
      pendingQ: d.interrogation.filter(x => !x.a).length,
      confessed: d.interrogation.some(x => x.confessed),
    })).sort((a, b) => b.offensesCount - a.offensesCount);    return {
      jail: { inmates: list, total: list.length, inQuarantine: list.filter(x => x.status === 'quarantine').length },
      patrol: this.log.slice(-30),
    };
  }
}
