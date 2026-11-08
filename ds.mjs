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

function round3(m) { return { t: +m.t.toFixed(3), u: +m.u.toFixed(3), i: +m.i.toFixed(3) }; }
function round4(x) { return +x.toFixed(4); }
