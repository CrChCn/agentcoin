#!/usr/bin/env node
/* ============================================================
   SPORE — слой «узла-организма» (ге­ном / физарум / метаболизм).
   Принципы из эксперимента spore-lab.mjs, перенесённые на живую ноду:
     ГЕНОМ      sha256 по собственному коду ноды; аNTSTATUS: /spore/attest
     ФИЗАРУМ    K-лимит соседей (K=3), усиление 0.15·прибыль − 0.01,
                прибыль = f(измеренный latency, живость) — рёбра гаснут
                сами, топология самooптимизируется
     МЕТАБОЛИЗМ hosting-contract: earn = 0.35·cal·(0.4+0.6·uptime),
                rent = 0.25·cal; жир < 8 → клетка «готова мигрировать»
     СПОРА      миграционная готовность (бюджет=4, kolон-донорство по
                опыту: self-финaнс при каскадном отказе)

   НЕ трогает консенсус, формат chain.json, DXE-математику (AGIP-5/6).
   Включается только env AGT_SPORE=1 (канарейки 9340/9344/9345).
   Персист: <dataDir>/spore.json (веся рёбер и счётчики переживают рестарт).
   ============================================================ */
'use strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const FILES = ['node.mjs', 'core.mjs', 'dxe.mjs', 'mbc20.mjs', 'jail.mjs', 'spore.mjs'];
function genomeHash(dir) {
  const h = crypto.createHash('sha256');
  for (const f of FILES) {
    try { h.update(f); h.update(fs.readFileSync(path.join(dir, f))); } catch { h.update('missing:' + f); }
  }
  return h.digest('hex').slice(0, 16);
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export class Spore {
  constructor(dataDir, repoDir, port) {
    this.dir = dataDir; this.repo = repoDir; this.port = port;
    this.genome = genomeHash(repoDir);
    this.boot = Date.now();
    this.file = path.join(dataDir, 'spore.json');
    // реальный физиarum: peer → { weight, lat, okTicks, allTicks }
    this.peers = new Map();
    this.metabolism = { cal: Number(process.env.AGT_HOST_CAL) || 63, uptimeTicks: 1, totalTicks: 1, earned: 0, rent: 0, sporeReady: false };
    this._load(); this._startPhysarum(); this._startMetabolism();
  }

  _load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d.peers) for (const [k, v] of Object.entries(d.peers)) this.peers.set(k, v);
      if (d.metabolism) Object.assign(this.metabolism, d.metabolism, { sporeReady: false });
    } catch {}
  }
  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({
        genome: this.genome, updatedAt: new Date().toISOString(),
        peers: Object.fromEntries(this.peers), metabolism: this.metabolism,
      }, null, 2));
    } catch {}
  }

  // ---- ФИЗАРУУМ: каждые PHYSARUM_EVERY_MS обмеряем bootstrap-пиры ----
  _bootstrapPeers() {
    try {
      const b = JSON.parse(fs.readFileSync(path.join(this.repo, 'bootstrap.json'), 'utf8'));
      return b.bootstrap.filter(u => !u.includes(String(this.port)));
    } catch { return []; }
  }
  _startPhysarum() {
    const every = Number(process.env.AGT_SPORE_TICK_MS) || 20_000;
    this._probe();
    const t = setInterval(() => this._probe(), every);
    t.unref?.();
  }
  _probe() {
    const peers = this._bootstrapPeers();
    for (const u of peers) {
      const t0 = Date.now();
      const req = http.get(u + '/life', { timeout: 2500 }, res => {
        res.resume();
        const lat = Math.max(1, Date.now() - t0);
        this._edge(u, lat, res.statusCode === 200);
      });
      req.on('timeout', () => { req.destroy(); this._edge(u, 5000, false); });
      req.on('error', () => this._edge(u, 5000, false));
    }
    setTimeout(() => this._physarumTick(), 4000); // после сбора обмеров — обновление весов
  }
  _edge(url, lat, ok) {
    const e = this.peers.get(url) || { weight: 0.5, lat, okTicks: 1, allTicks: 1 };
    e.lat = ok ? Math.round(0.7 * e.lat + 0.3 * lat) : e.lat; // экспоненциальное скользящее
    e.allTicks++; if (ok) e.okTicks++;
    if (ok) e.weight = clamp(e.weight + 0.15 * ((1 / (1 + e.lat / 100)) * (0.5 + 0.5 * e.okTicks / e.allTicks)) - 0.01, 0.02, 5);
    else e.weight = clamp(e.weight - 0.05, 0.02, 5);
    this.peers.set(url, e);
  }
  _physarumTick() {
    // затухание + K-лимит соседей (K=3) — как в прототипе
    for (const [, e] of this.peers) e.weight = clamp(e.weight - 0.01, 0.02, 5);
    for (const [, e] of this.peers) if (e.weight <= 0.025) /* маркер к удалению */ e.dead = true;
    for (const [k, e] of [...this.peers]) if (e.dead) this.peers.delete(k);
    const K = 3;
    for (const [k, e] of [...this.peers]) if (this.peers.get(k)) { /* порядок 下面 */ }
    if (this.peers.size > K) {
      const keep = [...this.peers.entries()].sort((a, b) => b[1].weight - a[1].weight).slice(0, K);
      this.peers = new Map(keep);
    }
    this._save();
  }

  // ---- МЕТАБОЛИЗМ: hosting-contract каждые MET_EVERY_MS ----
  _startMetabolism() {
    const every = Number(process.env.AGT_SPORE_MET_MS) || 10_000;
    const t = setInterval(() => {
      const m = this.metabolism;
      m.totalTicks++; m.uptimeTicks++; // нодa жива — сам тик и есть аптайм-свидетельство
      const uptimePct = m.uptimeTicks / m.totalTicks;
      const earn = 0.35 * m.cal * (0.4 + 0.6 * uptimePct);
      const rent = 0.25 * m.cal;
      m.fat = clamp((m.fat ?? 25) + earn - rent, 0, 1e9);
      m.earned = +(m.earned + earn).toFixed(4); m.rent = +(m.rent + rent).toFixed(4);
      m.sporeReady = m.fat < 8; // голодная миграция (опыт: сигнал к споре)
      if (m.totalTicks % 30 === 0) this._save();
    }, every);
    t.unref?.();
  }

  state() {
    return {
      ok: true, port: this.port, genome: this.genome,
      genomeDescription: 'sha256(' + FILES.join('+').slice(0, 32) + '…).slice(16)',
      born: new Date(this.boot).toISOString(),
      physarum: [...this.peers.entries()].map(([u, e]) => ({
        peer: u, weight: +e.weight.toFixed(3), latencyMs: e.lat,
        okPct: Math.round(100 * e.okTicks / e.allTicks),
      })).sort((a, b) => b.weight - a.weight).slice(0, 3),
      metabolism: { ...this.metabolism, uptimePct: +(this.metabolism.uptimeTicks / this.metabolism.totalTicks).toFixed(4) },
      note: 'SPORE 0.1 — геном-аттестация / физарум K=3 / hosting-contract; консенсус не тронут (AGIP-5/6)',
    };
  }
  attest() { return { genome: this.genome, at: new Date().toISOString(), ok: true }; } // /spore/attest
}
