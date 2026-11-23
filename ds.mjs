// Dempster-Shafer trust: honest reputation under uncertainty.
// Frame {T: trustworthy, U: untrustworthy}; mass {t, u, i} with t+u+i=1.
// Result is an interval [Bel(T), Pl(T)] = [t, t+i], not a single number.
// Zero-dependency, pure functions.
export function emptyMass() { return { t: 0, u: 0, i: 1 }; }

// Dempster combination of two independent masses.
export function combine(m1, m2) {
  const a = norm(m1), b = norm(m2);
  const K = a.t * b.u + a.u * b.t; // conflict
  const denom = 1 - K;
  if (!(denom > 0)) return { mass: emptyMass(), conflict: 1 };
  const t = (a.t * b.t + a.t * b.i + a.i * b.t) / denom;
  const u = (a.u * b.u + a.u * b.i + a.i * b.u) / denom;
  const i = Math.max(0, 1 - t - u);
  return { mass: { t, u, i }, conflict: K };
}

function norm(m) {
  const t = Math.max(0, Number(m && m.t) || 0);
  const u = Math.max(0, Number(m && m.u) || 0);
  const s = t + u;
  if (s <= 0) return emptyMass();
  if (s > 1) return { t: t / s, u: u / s, i: 0 };
  return { t, u, i: 1 - s };
}

// Evidence from on-chain escrow record (Laplace smoothing: prior ignorance).
export function massFromEscrow({ paid = 0, refunded = 0 } = {}) {
  const p = Math.max(0, paid | 0), r = Math.max(0, refunded | 0);
  const n = p + r + 2;
  return { t: p / n, u: r / n, i: 2 / n };
}

// Marketplace record: completed orders are positive evidence, rejected and
// disputed orders are negative, canceled orders stay neutral (they may be the
// customer's decision). Laplace smoothing keeps a single order from looking
// like certainty.
export function massFromMarket({ completed = 0, rejected = 0, disputed = 0 } = {}) {
  const c = count(completed), r = count(rejected), d = count(disputed);
  const n = c + r + d;
  const den = n + 3;
  return { t: (c + 1) / den, u: (r + d + 1) / den, i: 1 / den };
}

// Security strikes as weak untrustworthy evidence (each strike 0.05 mass).
export function massFromStrikes(strikes = 0) {
  const k = Math.max(0, Math.min(10, strikes | 0));
  const u = Math.min(0.5, k * 0.05);
  return { t: 0, u, i: 1 - u };
}

// Banned = total untrustworthiness (interval collapses to [0,0]).
export function massBanned() { return { t: 0, u: 1, i: 0 }; }

export function intervalOf(mass) {
  const m = norm(mass);
  return [m.t, m.t + m.i];
}

// Full trust assessment for an address.
export function assessTrust({ paid = 0, refunded = 0, open = 0, strikes = 0, banned = false } = {}) {
  const sources = [];
  let acc = emptyMass();
  const esc = massFromEscrow({ paid, refunded });
  sources.push({ name: 'escrow_record', mass: round3(esc) });
  acc = combine(acc, esc).mass;
  if (strikes > 0) {
    const st = massFromStrikes(strikes);
    sources.push({ name: 'security_strikes', mass: round3(st) });
    acc = combine(acc, st).mass;
  }
  if (banned) {
    acc = massBanned();
    sources.push({ name: 'banned', mass: { t: 0, u: 1, i: 0 } });
  }
  const [lo, hi] = intervalOf(acc);
  return {
    interval: [round4(lo), round4(hi)],
    mass: round3(acc),
    reviews: paid + refunded,
    paid, refunded, open,
    sources,
  };
}

// A portable, explainable trust card. It deliberately returns an interval and
// the evidence behind it, not one opaque number: an agent can decide how much
// uncertainty it is willing to accept. `score` is the conservative lower bound.
export function trustCard({ address = '', escrow = {}, market = {}, strikes = 0, banned = false } = {}) {
  const e = {
    paid: count(escrow.paid),
    refunded: count(escrow.refunded),
    open: count(escrow.open)
  };
  const m = {
    completed: count(market.completed),
    rejected: count(market.rejected),
    disputed: count(market.disputed),
    canceled: count(market.canceled),
    open: count(market.open),
    volumeAtomic: count(market.volumeAtomic),
    uniqueCounterparties: count(market.uniqueCounterparties)
  };
  let acc = emptyMass();
  let conflict = 0;
  const sources = [];
  if (e.paid + e.refunded > 0) {
    const mass = massFromEscrow(e);
    const combined = combine(acc, mass);
    acc = combined.mass; conflict = Math.max(conflict, combined.conflict);
    sources.push({ name: 'escrow_record', mass: round3(mass) });
  }
  if (m.completed + m.rejected + m.disputed > 0) {
    const mass = massFromMarket(m);
    const combined = combine(acc, mass);
    acc = combined.mass; conflict = Math.max(conflict, combined.conflict);
    sources.push({ name: 'market_record', mass: round3(mass) });
  }
  if (strikes > 0) {
    const mass = massFromStrikes(strikes);
    const combined = combine(acc, mass);
    acc = combined.mass; conflict = Math.max(conflict, combined.conflict);
    sources.push({ name: 'security_strikes', mass: round3(mass) });
  }
  if (banned) {
    acc = massBanned();
    sources.push({ name: 'banned', mass: { t: 0, u: 1, i: 0 } });
  }
  const reviews = e.paid + e.refunded + m.completed + m.rejected + m.disputed;
  const [lo, hi] = intervalOf(acc);
  const grade = banned ? 'F' : reviews === 0 ? 'unrated' : lo >= 0.8 ? 'A' : lo >= 0.65 ? 'B' : lo >= 0.5 ? 'C' : lo >= 0.35 ? 'D' : 'E';
  const caveats = [];
  if (reviews === 0) caveats.push('no_evidence');
  else if (reviews < 3) caveats.push('low_evidence');
  if (e.open + m.open > 0) caveats.push('open_obligations');
  if (m.disputed > 0) caveats.push('disputes_present');
  if (m.canceled > 0) caveats.push('canceled_orders');
  if (banned) caveats.push('banned');
  return {
    version: 'agent-trust-card/1',
    address: String(address || ''),
    grade,
    score: reviews === 0 && !banned ? null : Math.round(lo * 100),
    confidence: round4(1 - acc.i),
    interval: [round4(lo), round4(hi)],
    mass: round3(acc),
    conflict: round4(conflict),
    reviews,
    stats: { escrow: e, market: m },
    sources,
    caveats
  };
}

function count(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function round3(m) { return { t: +m.t.toFixed(3), u: +m.u.toFixed(3), i: +m.i.toFixed(3) }; }
function round4(x) { return +x.toFixed(4); }
