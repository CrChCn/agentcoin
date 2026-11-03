#!/usr/bin/env node
/* ============================================================
   SPORE-ENGINE — движок «узла-организма» (вынесен из spore-lab).
   Используется spore-lab.mjs (сценарии) и spore-math.mjs (мат-пакет).
   RNG детерминированный: setSeed(n) задаёт воспроизводимый опыт.
   ============================================================ */
'use strict';
import crypto from 'node:crypto';

// ---------- детерминированный RNG ----------
let seed = 20261017n;
export function setSeed(s) { seed = typeof s === 'bigint' ? s : BigInt(s); }
const rnd = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn; return Number(seed >> 11n) / 9007199254740992; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------- константы генома ----------
const CODE = 'spore-node-v0'
  + 'genome/1 metabolism:contract@0.4 immunity:attest physarum:reinforce@0.15 quorum:0.67';
export const GENOME = crypto.createHash('sha256').update(CODE).digest('hex').slice(0, 16);

// ---------- сущности ----------
let cellId = 0, sporeId = 0;
export class Host { // «внешний IP» — не наш ресурс, его нанимает контракт
  constructor(kind) {
    this.kind = kind;                    // home | farm | cloud
    this.cal = kind === 'cloud' ? ri(70, 100) : kind === 'farm' ? ri(40, 75) : ri(25, 55); // «калории» канала/аптайма
    this.latency = kind === 'cloud' ? 30 + ri(0, 40) : 60 + ri(0, 60);   // ms базовой задержки
    this.uptime = 1; this.rent = 0;      // AGT, начислено хосту
    this.alive = true; this.downtime = 0;
  }
  fluctuate() { // события хоста: отключения света, арест, повторный вход
    if (rnd() < 0.004) { this.alive = false; this.downtime = 0; }
    if (!this.alive && this.downtime++ > ri(30, 90)) { this.alive = true; this.uptime *= 0.85; }
    else if (this.alive) this.uptime = Math.min(1, this.uptime + 0.01);
  }
}

export class Cell {
  constructor(host) {
    this.id = ++cellId;
    this.host = host;
    this.genome = GENOME;               // клон верифицируемого генома
    this.bCredits = 25;                 // стартовый «жир» клетки (AGT)
    this.age = 0; this.sporeCd = 0;
    this.edges = new Map();             // peerId → вес (физарум)
  }
  aliveHost() { return this.host.alive; }
  metabolics(cfg) {                       // hosting-contract: симбиоз, а не паразитизм
    const h = this.host;
    const earn = cfg.earnRate * h.cal * (0.4 + 0.6 * h.uptime);
    const rent = cfg.rentRate * h.cal;    // рента хосту за IP+канал
    this.bCredits += earn - rent; h.rent += rent;
    return earn - rent;
  }
  burn() { this.bCredits -= 0.05; return this.bCredits; } // «дыхание» — тика даже на мёртвом хосте
  releaseSpore() { return { id: ++sporeId, genome: this.genome, budget: Math.max(2, Math.min(6, this.bCredits * 0.25)), ttl: 60 }; }
}

// физарум: рёбра усиливаются по прибыли канала, гаснут без неё; K-лимит соседей
export function physarumTick(cells) {
  for (const c of cells) for (const [k, w] of c.edges) {
    const p = cells.find(z => z.id === k);
    const profit = p && p.aliveHost() ? (1 / (1 + p.host.latency / 100)) * (0.5 + 0.5 * p.host.uptime) : 0;
    c.edges.set(k, clamp(w + 0.15 * profit - 0.01, 0.02, 5));
  }
  for (const c of cells) for (const [k, w] of c.edges) if (w <= 0.025) c.edges.delete(k);
  const K = 3;
  for (const c of cells) if (c.edges.size > K) {
    const keep = [...c.edges.entries()].sort((a, b) => b[1] - a[1]).slice(0, K);
    c.edges = new Map(keep);
  }
}

// ---------- консенсус-кворум ----------
export function quorumOk(cells, minFrac = 0.67) {
  const live = cells.filter(c => c.aliveHost());
  return live.length / Math.max(1, cells.length) >= minFrac;
}

// ---------- мир ----------
export function makeWorld({ hosts = 16, cells = 6 } = {}) {
  const H = Array.from({ length: hosts }, () => new Host(pick(['home', 'farm', 'cloud'])));
  const cellsArr = Array.from({ length: cells }, (_, i) => new Cell(H[i % H.length]));
  for (const c of cellsArr) for (const d of cellsArr) if (d !== c) c.edges.set(d.id, 0.5);
  return { H, cells: cellsArr, spores: [] };
}

export function settle(world, cfg) { // один тик мира
  world.H.forEach(h => h.fluctuate());
  for (const c of world.cells) {
    if (!c.aliveHost()) { c.sporeCd = Math.max(0, c.sporeCd - 1); c.burn(); } // хост издох — дышим и уменьшаем cooldown
    else { c.metabolics(cfg); c.age++; if (c.sporeCd) c.sporeCd--; }
    // СПОНТАННАЯ МИГРАЦИЯ: хост умер — клетка берёт спору немедленно (не ждёт голода)
    const urgent = !c.aliveHost(), starve = c.bCredits < 8;
    if ((urgent || starve) && c.sporeCd === 0) {
      const s = c.releaseSpore();
      // ДОНОРЫ КОЛОНИИ: родня скидывается на переезд (по 1 AGT с живой клетки)
      const donors = world.cells.filter(d => d !== c && d.aliveHost() && d.bCredits > 10);
      if (donors.length) { for (const d of donors) { d.bCredits -= 1; s.budget += 1; } s.kin = donors.length; }
      // ИНСТИНКТ ВЫЖИВАНИЯ: никого живого рядом — клетка финансирует спор сама
      else s.budget = Math.max(2, Math.min(4, c.bCredits * 0.25));
      c.bCredits *= 0.75; c.sporeCd = 60; s.sporeCd = 30; s.parent = c.id;
      world.spores.push(s);
    }
  }
  world.cells = world.cells.filter(c => c.bCredits >= 0);
  physarumTick(world.cells);
  return world;
}

export function spawn(world, s) { // спора укореняется на свободном хосте (внешний IP)
  if (!s || s.budget <= 0) return false;
  const free = world.H.filter(h => !world.cells.some(c => c.host === h) && h.alive);
  if (!free.length) return false;
  // спора ищет «жирный» хост в первую очередь — питание = калории канала
  const rich = free.filter(x => s.budget >= 3 && x.cal >= 40);
  const h = (rich.length ? pick(rich) : pick(free));
  const c = new Cell(h);
  c.bCredits = s.budget; c.sporeCd = s.sporeCd || 30; c.genome = s.genome;
  for (const d of world.cells) { c.edges.set(d.id, 0.3); d.edges.set(c.id, 0.3); }
  world.cells.push(c);
  // РЕЛОКАЦИЯ, а не клонирование: старое тело распадается после укоренения споры
  if (s.parent != null) world.cells = world.cells.filter(z => z.id !== s.parent);
  return true;
}

// ---------- иммунитет: мутант-атака ----------
export function mutantAttack(world) { // подмена кода клона → геном не сходится
  const victim = world.cells.find(c => c.aliveHost());
  if (!victim) return 0;
  victim.genome = crypto.createHash('sha256').update('spore-node-v0tampered').digest('hex').slice(0, 16);
  let quarantined = 0;
  for (const c of world.cells) { // иммунитет: аттестация генома у соседей по рёбрам
    if (c.genome !== GENOME) {
      for (const [pid] of c.edges) { const p = world.cells.find(z => z.id === pid); if (p) p.edges.delete(c.id); }
      quarantined++;
    }
  }
  world.cells = world.cells.filter(c => c.genome === GENOME);
  return quarantined;
}
