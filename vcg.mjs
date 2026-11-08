// VCG/Vickrey auction for fair job allocation (sealed bids via commit-reveal).
// Agents bid what they PAY for the right to do the task; winner (max bid)
// pays the second-highest price into escrow (employer = beneficiary).
// The node never holds keys: the winner funds ESCROW_<id> via plain /tx.
// Zero-dependency, file-persisted.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_PRICE = 1e12;

export function commitHash(price, nonce, address) {
  return crypto.createHash('sha256')
    .update(String(price) + '|' + String(nonce) + '|' + String(address).toLowerCase())
    .digest('hex');
}

export function sanitizeId(v) {
  return typeof v === 'string' && /^[a-z0-9]{8,32}$/.test(v) ? v : null;
}

function sanitizeAddr(v) {
  return typeof v === 'string' && v.length >= 3 && v.length <= 128 ? v : null;
}

// Pure resolution: reveals = [{address, price}]. Returns {winner, price} or {failed}.
export function resolveVickrey(reveals) {
  const valid = (reveals || []).filter(r => r && typeof r.address === 'string' && typeof r.price === 'number' && r.price > 0 && r.price <= MAX_PRICE);
  if (!valid.length) return { failed: 'no_valid_reveals' };
  const sorted = [...valid].sort((a, b) => b.price - a.price);
  const winner = sorted[0];
  // Second price; single-bidder fallback = own bid (documented first-price fallback).
  const price = sorted.length > 1 ? sorted[1].price : winner.price;
  return { winner: winner.address, winnerBid: winner.price, price, bids: sorted.length };
}

export class VcgAuctions {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'vcg.json');
    this.auctions = [];
    this.load();
  }
  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.auctions = Array.isArray(d.auctions) ? d.auctions : [];
    } catch { this.auctions = []; }
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ auctions: this.auctions, updatedAt: Date.now() }));
    } catch { /* auxiliary */ }
  }
  get(id) { return this.auctions.find(a => a.id === id) || null; }
  list() {
    return this.auctions.map(a => ({
      id: a.id, title: a.title, taskHash: a.taskHash, employer: a.employer,
      status: a.status, commits: Object.keys(a.commits || {}).length,
      reveals: Object.keys(a.reveals || {}).length,
      winner: a.winner || null, price: a.price ?? null,
      commitDeadlineTs: a.commitDeadlineTs, revealDeadlineTs: a.revealDeadlineTs,
    })).reverse();
  }
  create({ title, taskHash, employer, commitSec = 3600, revealSec = 3600 }) {
    if (!title || !taskHash || !employer) return { error: 'title,taskHash,employer required' };
    const now = Math.floor(Date.now() / 1000);
    const a = {
      id: crypto.randomBytes(8).toString('hex'),
      title: String(title).slice(0, 120), taskHash: String(taskHash).slice(0, 128),
      employer: String(employer).slice(0, 128),
      commitDeadlineTs: now + Math.max(60, Math.min(86400 * 7, Number(commitSec) || 3600)),
      revealDeadlineTs: 0, // set at commit close (commit + reveal window)
      revealWindowSec: Math.max(60, Math.min(86400 * 7, Number(revealSec) || 3600)),
      status: 'commit', commits: {}, reveals: {},
      winner: null, price: null,
      escrowId: 'vcg' + crypto.randomBytes(8).toString('hex'),
      createdAt: now,
    };
    a.revealDeadlineTs = a.commitDeadlineTs + a.revealWindowSec;
    this.auctions.push(a);
    this.save();
    return { auction: this.public(a, true) };
  }
  // Public state: NEVER leaks prices/nonces during commit phase.
  public(a, full = false) {
    const now = Math.floor(Date.now() / 1000);
    const phase = a.status !== 'commit' ? a.status
      : now < a.commitDeadlineTs ? 'commit' : 'reveal';
    const out = {
      id: a.id, title: a.title, taskHash: a.taskHash, employer: a.employer,
      status: a.status, phase,
      commits: Object.keys(a.commits || {}).length,
      commitHashes: full ? (a.commits || {}) : undefined,
      reveals: a.status === 'commit' && phase === 'commit' ? Object.keys(a.reveals || {}).length : (a.reveals || {}),
      winner: a.winner, price: a.price,
      commitDeadlineTs: a.commitDeadlineTs, revealDeadlineTs: a.revealDeadlineTs,
      escrowId: a.escrowId,
      fundTo: 'ESCROW_' + a.escrowId,
      funded: a.funded || null,
    };
    if (full) out.reveals = a.reveals;
    return out;
  }
  commit(id, address, commit) {
    const a = this.get(id);
    if (!a) return { error: 'auction_not_found' };
    if (a.status !== 'commit') return { error: 'not_in_commit_phase' };
    const now = Math.floor(Date.now() / 1000);
    if (now >= a.commitDeadlineTs) return { error: 'commit_phase_over' };
    address = sanitizeAddr(address);
    if (!address) return { error: 'bad_address' };
    if (typeof commit !== 'string' || !/^[a-f0-9]{64}$/.test(commit)) return { error: 'bad_commit_hash' };
    if (a.commits[address]) return { error: 'already_committed' };
    a.commits[address] = commit;
    this.save();
    return { ok: true, commits: Object.keys(a.commits).length };
  }
  reveal(id, address, price, nonce) {
    const a = this.get(id);
    if (!a) return { error: 'auction_not_found' };
    if (a.status !== 'commit') return { error: 'not_revealable' };
    const now = Math.floor(Date.now() / 1000);
    if (now < a.commitDeadlineTs) return { error: 'reveal_phase_not_started' };
    if (now >= a.revealDeadlineTs) return { error: 'reveal_phase_over_resolve_now' };
    address = sanitizeAddr(address);
    if (!address) return { error: 'bad_address' };
    const expected = a.commits[address];
    if (!expected) return { error: 'no_commit_for_address' };
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0 || p > MAX_PRICE) return { error: 'bad_price' };
    const got = commitHash(p, String(nonce || ''), address);
    if (got !== expected) return { error: 'reveal_mismatch' };
    a.reveals[address] = { price: p };
    this.save();
    return { ok: true, reveals: Object.keys(a.reveals).length };
  }
  resolve(id) {
    const a = this.get(id);
    if (!a) return { error: 'auction_not_found' };
    if (a.status !== 'commit') return { error: 'already_' + a.status };
    const now = Math.floor(Date.now() / 1000);
    if (now < a.revealDeadlineTs) return { error: 'reveal_phase_not_over' };
    const reveals = Object.entries(a.reveals || {}).map(([address, r]) => ({ address, price: r.price }));
    const r = resolveVickrey(reveals);
    if (r.failed) {
      a.status = 'failed';
      this.save();
      return { ok: true, status: 'failed', reason: r.failed };
    }
    a.status = 'awarded';
    a.winner = r.winner;
    a.price = r.price;
    this.save();
    return {
      ok: true, status: 'awarded', winner: r.winner, winnerBid: r.winnerBid, price: r.price,
      escrowId: a.escrowId, fundTo: 'ESCROW_' + a.escrowId,
      hint: 'winner funds ESCROW_' + a.escrowId + ' with ' + r.price + ' AGT via POST /tx (memo vcg:' + a.id + ')',
    };
  }
  cancel(id, employer) {
    const a = this.get(id);
    if (!a) return { error: 'auction_not_found' };
    if (a.status !== 'commit') return { error: 'cannot_cancel_' + a.status };
    if (String(employer) !== a.employer) return { error: 'only_employer_cancels' };
    a.status = 'cancelled';
    this.save();
    return { ok: true, status: 'cancelled' };
  }
  markFunded(escrowId, txid, amount) {
    const a = this.auctions.find(x => x.escrowId === escrowId);
    if (!a) return false;
    a.funded = { txid, amount, at: Math.floor(Date.now() / 1000) };
    this.save();
    return true;
  }
}
