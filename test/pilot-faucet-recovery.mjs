import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createWallet } from '../core.mjs';
import { createPilot } from '../pilot.mjs';

test('faucet reserves the signed claim across a transient submit failure', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agt-faucet-recovery-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const fund = createWallet();
  const agent = createWallet();
  const other = createWallet();
  const env = { AGT_PILOT_FAUCET_FUND: fund.address, AGT_PILOT_PAYOUT_FUND: '',
    AGT_PILOT_REVOKED_FILE: '', AGT_PILOT_PAYOUT_REGISTRY: '', AGT_FAUCET_FUND: '' };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    process.env[key] = value;
  }

  let balance = 0;
  let reject = 'temporarily_unavailable';
  const attempts = [];
  const bc = {
    chain: [], mempool: [], knownChainTxids: () => new Set(), balances: () => ({ [fund.address]: balance }),
    addTransaction(tx) {
      attempts.push(structuredClone(tx));
      if (reject) return { ok: false, reason: reject };
      this.mempool.push(tx);
      return { ok: true };
    },
  };
  const start = () => createPilot({ dataDir, bc, announce() {},
    loadWallets: () => ({ [fund.address]: fund }),
    identity: { find: address => [agent, other].find(wallet => wallet.address === address), verify: () => ({ ok: true }) },
    isBanned: () => false,
  });
  let pilot = start();
  const claim = () => {
    const { challengeId, message } = pilot.faucetChallenge(agent.address);
    return pilot.faucetClaim(challengeId, sign(null, Buffer.from(message), agent.privKey).toString('hex'));
  };

  const original = pilot.faucetChallenge(agent.address);
  const db = new DatabaseSync(join(dataDir, 'pilot-payments.sqlite'));
  try {
    db.prepare('INSERT INTO challenges VALUES (?,?,?,?,?)').run('expired', agent.address, 500_000_000, 'expired', 0);
    for (let i = 0; i < 20; i++) assert.deepEqual(pilot.faucetChallenge(agent.address), original);
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM challenges').get().total, 1);
    const insert = db.prepare('INSERT INTO challenges VALUES (?,?,?,?,?)');
    db.exec('BEGIN');
    for (let i = 0; i < 2047; i++) {
      insert.run(`fixture-${i}`, `fixture-${i}`, 500_000_000, 'fixture', original.expiresAt);
    }
    db.exec('COMMIT');
    assert.equal(pilot.faucetChallenge(other.address).error, 'challenge_capacity');
    assert.deepEqual(pilot.faucetChallenge(agent.address), original);
    db.prepare('DELETE FROM challenges WHERE id LIKE ?').run('fixture-%');
  } finally {
    db.close();
  }
  assert.equal(pilot.faucetClaim(original.challengeId, '00'.repeat(64)).error, 'bad_signature');
  assert.deepEqual(pilot.faucetChallenge(agent.address), original);
  assert.equal(claim().error, 'fund_insufficient');
  assert.equal(pilot.status().counts.faucet, 0);
  assert.equal(attempts.length, 0);
  balance = 1;
  const initial = claim();
  assert.equal(initial.recorded, true);
  assert.equal(initial.txid, attempts[0].txid);
  pilot = start();
  assert.equal(claim().error, 'agent_cap_reached');
  reject = 'duplicate_tx';
  const collision = pilot.reconcile().faucet[0];
  assert.equal(collision.action, 'recorded');
  assert.equal(collision.reason, 'duplicate_tx');
  reject = null;
  assert.equal(pilot.reconcile().faucet[0].action, 'pending');
  assert.deepEqual(attempts[1], attempts[0]);
  assert.deepEqual(attempts[2], attempts[0]);
  pilot.reconcile();
  assert.equal(attempts.length, 3);
  assert.equal(bc.mempool.length, 1);
});
