#!/usr/bin/env node
/* Общие хендлеры изолированного стенда: те же пути, что у ноды, плюс
   документированный механизм обнаружения подписи GET /queue/auth-capabilities
   и подписанные POST /queue/signed/{join,claim,done} (verifyActionSig + nonce). */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { AgentQueue } from '../../queue.mjs';
import { verifyActionSig } from '../../queue-auth.mjs';
import { validateServiceOffer, validateAssignment, validateArtifact, verifyArtifactHash, hashOf } from './schemas.mjs';
import crypto from 'node:crypto';

const GENESIS = 'stand-genesis-001';
export async function createStand(tmp) {
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const queue = new AgentQueue(dataDir);
  const usedNonce = new Map(); // nonceKey(address|nonce) -> {digest,result}
  const offers = {}; // offerId -> {versions:[offer], }
  const orders = {}; // assignmentId -> {assignment, artifacts:[], state}
  const idemOrder = new Map(); // customer|offerId|idemKey -> assignmentId (защита от повторного принятия)
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
      // ---- Stage B: каталог услуг и заказы (подписанные мутации, чтение публичное) ----
      if (u.pathname === '/catalog/offers' && req.method === 'GET') {
        const skill = u.searchParams.get('skill') || '', maxP = u.searchParams.get('maxPriceAtomic'), fmt = u.searchParams.get('format') || '';
        const out = [];
        for (const [id, e] of Object.entries(offers)) for (const o of e.versions) {
          if (skill && !(o.skills || []).some(s => String(s).includes(skill)) && !String(o.title).includes(skill)) continue;
          if (maxP !== null && maxP !== '' && Number(o.priceAtomic) > Number(maxP)) continue;
          if (fmt && !(o.acceptedInputFormats || []).includes(fmt) && !(o.producedOutputFormats || []).includes(fmt)) continue;
          out.push({ ...o, expired: Number(o.expiresAt) <= Date.now() });
        }
        return send(200, { offers: out });
      }
      const mo = u.pathname.match(/^\/catalog\/offers\/([A-Za-z0-9_-]+)$/);
      if (mo && req.method === 'GET') {
        const e = offers[mo[1]];
        if (!e) return send(404, { error: 'offer_not_found' });
        return send(200, { offerId: mo[1], versions: e.versions });
      }
      if (u.pathname === '/catalog/publish' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'publish', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const o = b.body?.offer;
        const err = validateServiceOffer(o);
        if (err) return send(400, { error: err });
        if (o.provider !== b.address) return send(403, { error: 'provider_mismatch' });
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        offers[o.offerId] ||= { versions: [] };
        if (offers[o.offerId].versions.some(x => x.version === o.version)) {
          const res = { ok: true, offerId: o.offerId, version: o.version, note: 'версия уже была — повтор без изменений' };
          usedNonce.set(key, { digest: v.digest, result: res });
          return send(200, res);
        }
        offers[o.offerId].versions.push(o);
        const res = { ok: true, offerId: o.offerId, version: o.version, snapshotHash: hashOf(o) };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      if (u.pathname === '/orders/create' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'order', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        const { offerId, offerVersion, input, idempotencyKey } = b.body || {};
        const e = offers[offerId];
        if (!e) return send(404, { error: 'offer_not_found' });
        const snap = offerVersion ? e.versions.find(x => x.version === offerVersion) : e.versions[e.versions.length - 1];
        if (!snap) return send(404, { error: 'offer_version_not_found' });
        if (Number(snap.expiresAt) <= Date.now()) return send(409, { error: 'offer_expired' });
        const idem = String(idempotencyKey || '');
        const idemKey = b.address + '|' + offerId + '|' + idem;
        if (idem && idemOrder.has(idemKey)) {
          const res = { ok: true, assignment: orders[idemOrder.get(idemKey)].assignment, replay: true };
          usedNonce.set(key, { digest: v.digest, result: res });
          return send(200, res);
        }
        const assignmentId = crypto.createHash('sha256').update([b.address, offerId, snap.version, idem || String(b.nonce)].join('|')).digest('hex').slice(0, 16);
        const assignment = { assignmentId, offerId, offerVersion: snap.version, offerSnapshotHash: hashOf(snap), customer: b.address, provider: snap.provider, input: input || {}, acceptanceMethod: snap.acceptance.method, state: 'open', createdAt: Date.now() };
        const verr = validateAssignment(assignment);
        if (verr) return send(400, { error: verr });
        orders[assignmentId] = { assignment, artifacts: [], acceptance: null };
        if (idem) idemOrder.set(idemKey, assignmentId);
        const res = { ok: true, assignment };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      const mg = u.pathname.match(/^\/orders\/([a-f0-9]{16})$/);
      if (mg && req.method === 'GET') {
        const o = orders[mg[1]];
        if (!o) return send(404, { error: 'order_not_found' });
        const req2 = u.searchParams.get('requester') || '';
        const pub = o.artifacts.map(a => ({ ...a.meta, content: a.meta.accessPolicy === 'public' || req2 === o.assignment.customer || req2 === o.assignment.provider ? a.content : undefined }));
        return send(200, { assignment: o.assignment, artifacts: pub, acceptance: o.acceptance });
      }
      if (u.pathname === '/orders/submit-artifact' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'artifact', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        const { assignmentId, artifact, content } = b.body || {};
        const o = orders[assignmentId];
        if (!o) return send(404, { error: 'order_not_found' });
        if (b.address !== o.assignment.provider) return send(403, { error: 'foreign_artifact', hint: 'артефакт сдаёт только provider заказа' });
        const err = validateArtifact({ ...artifact, assignmentId });
        if (err) return send(400, { error: err });
        const bytes = Buffer.from(String(content || ''), 'base64');
        const herr = verifyArtifactHash(bytes, artifact);
        if (herr) return send(400, { error: herr });
        if (o.artifacts.some(a => a.meta.artifactId === artifact.artifactId)) return send(409, { error: 'artifact_version_exists', hint: 'изменение артефакта — новый artifactId' });
        o.artifacts.push({ meta: { ...artifact, assignmentId }, content: artifact.accessPolicy === 'public' ? String(content) : '[private]' });
        const res = { ok: true, artifactId: artifact.artifactId };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      if (u.pathname === '/orders/accept' && req.method === 'POST') {
        const v = verifyActionSig({ address: b.address, fromPub: b.fromPub, signature: b.signature, action: 'accept', body: b.body || {}, nonce: b.nonce, expiry: b.expiry, chain: 'AGENTCOIN' });
        if (!v.ok) return send(401, v);
        const key = String(b.address).toLowerCase() + '|' + String(b.nonce);
        const prev = usedNonce.get(key);
        if (prev) { if (prev.digest !== v.digest) return send(409, { ok: false, error: 'NONCE_BODY_MISMATCH' }); return send(200, { ...prev.result, replay: true }); }
        const { assignmentId, verdict } = b.body || {};
        const o = orders[assignmentId];
        if (!o) return send(404, { error: 'order_not_found' });
        if (b.address !== o.assignment.customer) return send(403, { error: 'foreign_accept', hint: 'принимает только customer' });
        if (o.assignment.state === 'accepted') { const res = { ok: true, replay: true, assignment: o.assignment }; usedNonce.set(key, { digest: v.digest, result: res }); return send(200, res); }
        o.assignment.state = 'accepted';
        o.acceptance = { verdict: verdict || 'accepted', at: Date.now(), method: o.assignment.acceptanceMethod };
        const res = { ok: true, assignment: o.assignment };
        usedNonce.set(key, { digest: v.digest, result: res });
        return send(200, res);
      }
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}`, queue, genesis: GENESIS, close: () => server.close() };
}
