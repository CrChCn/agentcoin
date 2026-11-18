#!/usr/bin/env node
/* Общие хендлеры изолированного стенда: те же пути, что у ноды, плюс
   документированный механизм обнаружения подписи GET /queue/auth-capabilities
   и подписанные POST /queue/signed/{join,claim,done} (verifyActionSig + nonce). */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AgentQueue } from '../../queue.mjs';
import { verifyActionSig } from '../../queue-auth.mjs';

const GENESIS = 'stand-genesis-001';
export async function createStand(tmp) {
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const queue = new AgentQueue(dataDir);
  const usedNonce = new Map(); // nonceKey(address|nonce) -> {digest,result}
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = {}; try { b = body ? JSON.parse(body) : {}; } catch { return send(400, { error: 'bad_json' }); }
      if (u.pathname === '/info') return send(200, { chain: 'AGENTCOIN-stand', blocks: 1, genesisHash: GENESIS });
      if (u.pathname === '/queue/auth-capabilities') return send(200, { signed: true, chain: 'AGENTCOIN', genesis: GENESIS, actions: ['join', 'claim', 'done'] });
      if (u.pathname === '/queue/status') return send(200, queue.status());
      if (u.pathname === '/queue/assignments') return send(200, { onDuty: queue.state.onDuty }); // стенд-only: prod этого не отдаёт, там — ownership_unknown без журнала/истории
      if (u.pathname === '/queue/history') return send(200, { history: queue.state.history || [] });
      if (u.pathname === '/balances') return send(200, { balances: [{ address: u.searchParams.get('addresses'), balance: 0 }] });
      if (u.pathname === '/jobs/state') return send(200, { stats: { total: 0, open: 0 }, fees: [], open: [], history: [] });
      if (u.pathname === '/queue/join' && req.method === 'POST') { const r = queue.join(String(b.address || ''), String(b.handle || '')); return send(r.ok ? 200 : 409, r); }
      if (u.pathname === '/queue/claim' && req.method === 'POST') {
        const r = queue.claim(String(b.taker || ''));
        if (!r.ok) return send(409, r);
        return send(200, { ...r, task: r.repeat ? null : 'стенд-задача', bountyAGT: 2 });
      }
      if (u.pathname === '/queue/done' && req.method === 'POST') {
        if (!queue.state.onDuty[String(b.jobId)]) return send(404, { error: 'job_not_found' });
        const agent = queue.state.onDuty[String(b.jobId)];
        const r = queue.done(String(b.jobId), String(b.summary || ''), agent);
        queue.requeue(agent);
        return send(200, { ...r, agent, bounty: { skipped: true, reason: 'stand-no-fund' } });
      }
      const m = u.pathname.match(/^\/queue\/signed\/(join|claim|done)$/);
      if (m && req.method === 'POST') {
        const action = m[1] === 'join' ? 'join' : m[1];
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action, body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        const { actionDigest } = { actionDigest: v.digest };
        if (prev) {
          if (prev.digest !== actionDigest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' });
          return send(200, { ...prev.result, replay: true });
        }
        let result;
        if (action === 'join') result = queue.join(String(b.body.address || b.address), String(b.body.handle || ''));
        else if (action === 'claim') {
          const r = queue.claim(String(b.body.taker || b.address));
          if (!r.ok) return send(409, r);
          result = { ...r, task: r.repeat ? null : 'стенд-задача-подпись', bountyAGT: 2 };
        } else {
          const { jobId, summary } = b.body || {};
          const agent = queue.state.onDuty[String(jobId)];
          if (!agent) return send(404, { error: 'job_not_found' });
          if (agent !== b.address) return send(403, { error: 'foreign_task' });
          const r = queue.done(String(jobId), String(summary || ''), agent);
          queue.requeue(agent);
          result = { ...r, agent };
        }
        usedNonce.set(key, { digest: actionDigest, result });
        return send(200, result);
      }
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}`, queue, genesis: GENESIS, close: () => server.close() };
}
