#!/usr/bin/env node
/* Срез v0.2: legacy только при явном opt-in, 404 ≠ успех, needs_reconcile. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeClient } from '../sdk/js/agentcoin-sdk.mjs';
import { verifyActionSig, signAction } from '../queue-auth.mjs';

let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + name); };
function mockNode() {
  const st = { waiting: ['A'], onDuty: {}, done: new Set() };
  const json = (status, data) => ({ status, json: async () => data });
  return { st, fetch: async (url, opt = {}) => {
    const u = new URL(url); const p = u.pathname + (u.search || '');
    const body = opt.body ? JSON.parse(opt.body) : {};
    if (p === '/queue/auth-capabilities') return json(404, {});
    if (opt.method === 'GET' && p.startsWith('/queue/status')) return json(200, { waiting: 1 });
    if (opt.method === 'GET' && p === '/queue/assignments') return json(200, { onDuty: st.onDuty });
    if (opt.method === 'GET' && p === '/queue/history') return json(200, { history: [] });
    if (opt.method === 'POST' && p === '/queue/claim') {
      const held = Object.entries(st.onDuty).find(([, a]) => a === body.taker);
      if (held) return json(200, { ok: true, jobId: held[0], repeat: true });
      const t = st.waiting.shift(); const jobId = 'job-' + t; st.onDuty[jobId] = t;
      return json(200, { ok: true, jobId, task: 'demo', bountyAGT: 2 });
    }
    if (opt.method === 'POST' && p === '/queue/done') {
      if (!st.onDuty[body.jobId]) return json(404, { error: 'job_not_found' });
      delete st.onDuty[body.jobId]; st.done.add(body.jobId);
      return json(200, { ok: true, closed: body.jobId });
    }
    return json(200, {});
  }};
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agts-'));
const wf = path.join(tmp, 'w.json');
fs.writeFileSync(wf, JSON.stringify({ address: 'A' }));
const J = (n) => path.join(tmp, n + '.json');

// legacy без opt-in запрещён, fallback нет
{
  const m = mockNode();
  const c = makeClient({ node: 'http://x', walletFile: wf, journalFile: J('a'), fetchImpl: m.fetch });
  const r = await c.claim('A');
  ok(r.ok === false && r.error === 'legacy_write_disabled', 'legacy без opt-in запрещён');
}
// legacy с opt-in: claim + повтор replay
{
  const m = mockNode();
  const c = makeClient({ node: 'http://x', walletFile: wf, journalFile: J('b'), fetchImpl: m.fetch, allowLegacyWrite: true });
  const r1 = await c.claim('A'); ok(r1.ok && r1.result.jobId === 'job-A', 'legacy claim с opt-in');
  const r2 = await c.claim('A'); ok(r2.replay === true && r2.result.jobId === 'job-A', 'повтор claim replay');
}
// 404 неизвестной задачи — не успех
{
  const m = mockNode();
  const c = makeClient({ node: 'http://x', walletFile: wf, journalFile: J('c'), fetchImpl: m.fetch, allowLegacyWrite: true });
  await c.claim('A');
  const r = await c.submit('A', 'nope', 'x'.repeat(40));
  ok(r.ok === false && r.error !== undefined, 'неизвестный jobId — отказ, не успех');
}
// summary<40 локально
{
  const m = mockNode();
  const c = makeClient({ node: 'http://x', walletFile: wf, journalFile: J('d'), fetchImpl: m.fetch, allowLegacyWrite: true });
  const r = await c.submit('A', 'job-1', 'коротко');
  ok(r.ok === false && r.error === 'summary_too_short', 'короткий summary блочится локально');
}
// чужая подпись
{
  const crypto = await import('node:crypto');
  const v = crypto.generateKeyPairSync('ed25519'), at = crypto.generateKeyPairSync('ed25519');
  const vPub = v.publicKey.export({ type: 'spki', format: 'pem' });
  const s = signAction(at.privateKey.export({ type: 'pkcs8', format: 'pem' }), { action: 'claim', body: { taker: 'A' }, nonce: 'n1', expiry: Date.now() + 60000 });
  const r = verifyActionSig({ address: 'A', fromPub: at.publicKey.export({ type: 'spki', format: 'pem' }), signature: s.signature, action: 'claim', body: { taker: 'A' }, nonce: 'n1', expiry: Date.now() + 60000 });
  void vPub;
  ok(r.ok === false, 'чужая подпись отвергается');
}
// рестарт: повтор submit replay без сети
{
  const m = mockNode();
  const jf = J('e');
  const c1 = makeClient({ node: 'http://x', walletFile: wf, journalFile: jf, fetchImpl: m.fetch, allowLegacyWrite: true });
  await c1.claim('A');
  const mine = await c1.myTask('A');
  const d1 = await c1.submit('A', mine.jobId, 'x'.repeat(40));
  ok(d1.ok === true, 'сдача своей задачи');
  const calls = m.st ? 1 : 1;
  void calls;
  const c2 = makeClient({ node: 'http://x', walletFile: wf, journalFile: jf, fetchImpl: async () => { throw new Error('must not call network'); }, allowLegacyWrite: true });
  const d2 = await c2.submit('A', mine.jobId, 'x'.repeat(40));
  ok(d2.replay === true, 'рестарт: повтор submit из журнала без сети');
}
console.log(`\nитог: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
