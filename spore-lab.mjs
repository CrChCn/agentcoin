#!/usr/bin/env node
/* ============================================================
   SPORE-LAB — прототип «узла-организма» для империи AGT.
   НЕ сервер: моделируем в знаках (виртуальная клетка живёт
   на внешнем хосте, питается его IP/каналом, проверяет геном,
   рождает споры, строит физарум-топологию).

   Системы клетки (каждая = проверяемый механизм):
     ГЕНОМ     genome = sha256(code+genomeVersion); клон обязан совпадать
     МЕМБРАНА  капсула: клетка без совпадения генома не исполняет код
     МЕТАБОЛИЗМ hosting-contract: клетка платит хосту AGT за аптайм,
                хост калории = uptime×канал×честность; контракт <
                прожиточного минимума → клетка выпускает СПОРУ
     СПОРА     ищет новый хост из пула «внешних IP», встаёт, живёт
     ИММУНИТЕТ мутант (битый геном / подмена кода) — изоляция, смерть
     ФИЗАРУМ   пиринг: рёбра усиливаются по «прибыли» (latency+success),
                гаснут без прибыли — самооптимизация топологии
     ЦЕПЬ      консенсус-кворум: tip считается, если ≥ Q(n) клеток согласны

   Запуск: node spore-lab.mjs            (все 4 сценария)
           node spore-lab.mjs storm      (отдельно)
   ============================================================ */
'use strict';
import crypto from 'node:crypto';

// ---------- детерминированный RNG (воспроизводимость опыта) ----------
let seed = 20261017n;
const rnd = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & 0xFFFFFFFFFFFFFFFFn; return Number(seed >> 11n) / 9007199254740992; };
const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------- константы генома ----------
const CODE = 'spore-node-v0'
  + 'genome/1 metabolism:contract@0.4 immunity:attest physarum:reinforce@0.15 quorum:0.67';
const GENOME = crypto.createHash('sha256').update(CODE).digest('hex').slice(0, 16);

// ---------- сущности ----------
let cellId = 0, sporeId = 0;
class Host { // «внешний IP» — не наш ресурс, его нанимает контракт
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

class Cell {
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
    // доход = сервис для хоста (API/бэкап/нода): надёжный аптайм зарабатывает больше
    const earn = cfg.earnRate * h.cal * (0.4 + 0.6 * h.uptime);
    const rent = cfg.rentRate * h.cal;    // рента хосту за IP+канал
    this.bCredits += earn - rent; h.rent += rent;
    return earn - rent;
  }
  burn() { this.bCredits -= 0.05; return this.bCredits; } // «дыхание» — тика даже на мёртвом хосте
  releaseSpore() { return { id: ++sporeId, genome: this.genome, budget: Math.max(2, Math.min(6, this.bCredits * 0.25)), ttl: 60 }; }
}

// физарум: рёбра усиливаются по прибыли канала, гаснут без неё
function physarumTick(cells, HOPS) {
  for (const c of cells) for (const [k, w] of c.edges) {
    const p = HOPS.get(k);
    const profit = p && p.aliveHost() ? (1 / (1 + p.host.latency / 100)) * (0.5 + 0.5 * p.host.uptime) : 0;
    c.edges.set(k, clamp(w + 0.15 * profit - 0.01, 0.02, 5));
  }
  for (const c of cells) for (const [k, w] of c.edges) if (w <= 0.025) c.edges.delete(k);
  // K-лимит соседей (как реальные cap-пиров): остаёмся только с сильными рёбрами
  const K = 3;
  for (const c of cells) if (c.edges.size > K) {
    const keep = [...c.edges.entries()].sort((a, b) => b[1] - a[1]).slice(0, K);
    c.edges = new Map(keep);
  }
}

// ---------- консенсус-кворум ----------
function quorumOk(cells, minFrac = 0.67) {
  const live = cells.filter(c => c.aliveHost());
  return live.length / Math.max(1, cells.length) >= minFrac;
}

// ---------- мир ----------
function makeWorld({ hosts = 12, cells = 4 }) {
  const H = Array.from({ length: hosts }, () => new Host(pick(['home', 'farm', 'cloud'])));
  const cellsArr = Array.from({ length: cells }, (_, i) => new Cell(H[i % H.length]));
  for (const c of cellsArr) for (const d of cellsArr) if (d !== c) c.edges.set(d.id, 0.5);
  return { H, cells: cellsArr };
}

function settle(world, cfg) { // один тик мира
  world.H.forEach(h => h.fluctuate());
  const cash = [];
  for (const c of world.cells) {
    if (!c.aliveHost()) { c.sporeCd = Math.max(0, c.sporeCd - 1); c.burn(); } // хост издох — дышим и уменьшаем cooldown
    else { const pnl = c.metabolics(cfg); c.age++; if (c.sporeCd) c.sporeCd--; }
    // СПОНТАННАЯ МИГРАЦИЯ: хост умер — клетка берёт спору немедленно (не ждёт голода)
    // ГОЛОДНАЯ МОГРАЦИЯ: без жира — тоже спора. Это и есть «питание внешними IP»
    const urgent = !c.aliveHost(), starve = c.bCredits < 8;
    if ((urgent || starve) && c.sporeCd === 0) {
      const s = c.releaseSpore();
      // ДОНОРЫ КОЛОНИИ: родня скидывается на переезд (по 1 AGT с живой клетки)
      const donors = world.cells.filter(d => d !== c && d.aliveHost() && d.bCredits > 10);
      if (donors.length) { for (const d of donors) { d.bCredits -= 1; s.budget += 1; } s.kin = donors.length; }
      // ИНСТИНКТ ВЫЖИВАНИЯ: никого живого рядом — клетка финансирует спор сама
      else s.budget = Math.max(2, Math.min(4, c.bCredits * 0.25));
      c.bCredits *= 0.75; c.sporeCd = 60; s.sporeCd = 30; s.parent = c.id;
      world.spores.push(s); cash.push('spore');
    }
    if (c.bCredits < 0) cash.push('died:' + c.id); // банкротство = смерть клетки
  }
  world.cells = world.cells.filter(c => c.bCredits >= 0);
  physarumTick(world.cells, new Map(world.cells.map(c => [c.id, c])));
  return cash;
}

function spawn(world, s) { // спора укореняется на свободном хосте (внешний IP)
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
function mutantAttack(world) { // подмена кода клона → геном не сходится
  const victim = world.cells.find(c => c.aliveHost());
  if (!victim) return 0;
  victim.genome = crypto.createHash('sha256').update(CODE + 'tampered').digest('hex').slice(0, 16);
  let quarantined = 0;
  for (const c of world.cells) { // иммунитет: аттестация генома у соседей по рёбрам
    if (c.genome !== GENOME) {
      for (const [pid] of c.edges) { const p = world.cells.find(z => z.id === pid); if (p) p.edges.delete(c.id); }
      quarantined++;
    }
  }
  world.cells = world.cells.filter(c => c.genome === GENOME || (c.bCredits -= 5) > -1e9 && false);
  return quarantined;
}

// ---------- СЦЕНАРИИ-ОПЫТЫ ----------
const report = [];
function run(name, setup) {
  seed = 20261017n; // сброс RNG — воспроизводимость
  const cfg = { rentRate: 0.25, earnRate: 0.35 };
  const T = 600;
  const world = makeWorld({ hosts: 16, cells: 6 });
  world.spores = [];
  const m = setup(world, cfg, T);
  report.push({ name, ...m });
}

// Опыт 1. Шторм смертей хостов: 40% хостов умирает разом; споры обязаны переселить клетки
run('storm: 40% hosts die → spores reseal network', (world, cfg, T) => {
  let deathT = 60, resurected = 0, epoch0 = world.cells.length, cons = 0, topCon = 0, spores = 0;
  for (let t = 0; t < T; t++) {
    if (t === deathT) { world.H.slice(0, 7).forEach(h => { h.alive = false; h.downtime = 0; }); deathT = null; }
    settle(world, cfg);
    world.spores = world.spores.filter(s => (--s.ttl > 0) ? (spawn(world, s) ? (spores++, false) : true) : false);
    if (quorumOk(world.cells)) cons++;
    topCon = Math.max(topCon, world.cells.length);
    if (world.cells.length < epoch0 * 0.5) deathT = null;
  }
  resurected = world.cells.length;
  return { живутКлеток: world.cells.length, было: epoch0, пик: topCon, спорРодилось: spores, кворумТиков: cons + '/' + T };
});

// Опыт 2. Мутант-атака: 1 клетка получает подменённый код — иммунитет карантинит
run('mutant attack: tampered code hash contained', (world, cfg, T) => {
  settle(world, cfg);
  const before = world.cells.length;
  const quarantined = mutantAttack(world);
  for (let t = 0; t < 50; t++) settle(world, cfg);
  return { карантинов: quarantined, клетокДо: before, клетокПосле: world.cells.length, геном: GENOME };
});

// Опыт 3. Метаболизм: клетка живёт на внешнем hostе, честь — заработать > ренты
run('metabolism: cell earns on external host, pays rent', (world, cfg, T) => {
  const c = world.cells[0];
  const start = c.bCredits; const h = c.host;
  let peak = c.bCredits, hostEarn = 0;
  for (let t = 0; t < T; t++) { settle(world, cfg); peak = Math.max(peak, c.bCredits); hostEarn = h.rent; }
  return { клеткаЖир: +c.bCredits.toFixed(1), старт: start, хостЗаработал: +hostEarn.toFixed(1), калорииХоста: h.cal,收支: +((c.bCredits - start)).toFixed(1) };
});

// Опыт 4. Физарум vs статичный mesh: измеряем среднюю latency рёбер
run('physarum peering vs static mesh', (world, cfg, T) => {
  const staticMesh = world.cells.flatMap(c => [...c.edges.keys()].map(k => {
    const p = world.cells.find(z => z.id === k); return p ? p.host.latency : 0;
  }));
  const avgStatic = staticMesh.reduce((a, b) => a + b, 0) / staticMesh.length;
  for (let t = 0; t < T; t++) settle(world, cfg);
  const dyn = world.cells.flatMap(c => [...c.edges.keys()].map(k => {
    const p = world.cells.find(z => z.id === k); return p ? p.host.latency : 0;
  }));
  return { статичныйMeshLatency: +avgStatic.toFixed(0), физарумLatency: +(dyn.reduce((a, b) => a + b, 0) / Math.max(1, dyn.length)).toFixed(0), рёбер: dyn.length, рёберСтатик: staticMesh.length };
});

// ---------- вывод ----------
console.log('='.repeat(72));
console.log('SPORE-LAB: геном ' + GENOME + ' · пространство: 12 хостов (home/farm/cloud) · опыт детерминирован (seed 20261017)');
console.log('='.repeat(72));
for (const r of report) {
  console.log('\n◆ ' + r.name);
  for (const [k, v] of Object.entries(r)) if (k !== 'name') console.log('   ' + k.padEnd(24) + v);
}
console.log('\n' + '='.repeat(72));
console.log('выводы: см. споры=переселение, карантины=иммунитет, физарум=латент улучшен');
