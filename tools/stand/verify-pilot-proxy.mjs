#!/usr/bin/env node
// verify-pilot-proxy.mjs — стенд предлагаемых правил прокси перед реальной нодой.
// Правила (порядок важен): 1) ^/pilot/ → 403 JSON края, БЕЗ обращения к ноде;
// 2) POST /faucet/pilot/challenge|claim → forward; 3) GET /life и
// GET /api/v1/network/nodes → forward; 4) остальное → 404 края.
// Проверяет матрицу ТЗ §2 + что запрещённое не доходит до ноды (список forwarded).
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createWallet } from '../../core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const R = { startedAt: new Date().toISOString(), steps: [] };
const step = (n, ok, d = '') => { R.steps.push({ name: n, ok, detail: d }); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function pickPort() { const s = net.createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise((r) => s.close(r)); return p; }
const ADMIN = crypto.randomBytes(24).toString('hex');
let node = null;
const direct = (route, { method = 'GET', body, token = ADMIN } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (token) headers['x-admin-token'] = token;
  return fetch(node.url + route, { method, redirect: 'manual', signal: AbortSignal.timeout(20000), headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async (r) => ({ status: r.status, ct: r.headers.get('content-type'), loc: r.headers.get('location'), body: await r.json().catch(() => ({})) }));
};
const signMsg = (privPem, message) => crypto.sign(null, Buffer.from(message, 'utf8'), crypto.createPrivateKey(privPem)).toString('hex');

async function boot(extraEnv = {}) {
  const port = await pickPort();
  const root = node?.root || fs.mkdtempSync(path.join(os.tmpdir(), 'agt-proxy-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, AGT_DATA_DIR: dataDir, AGT_BOOTSTRAP_FILE: path.join(root, 'boot.json'),
    AGT_ADMIN_MODE: 'token', AGT_ADMIN_TOKEN: ADMIN, AGT_BIND: '127.0.0.1',
    AGT_SPORE: '0', AGT_SITE_SYNC: '0', AGT_PEER_DISCOVERY: '0', ...extraEnv };
  for (const k of ['AGT_CORE_P0_HEIGHT', 'AGT_TX_DIGEST_V2_HEIGHT', 'AGT_MGNT_HEIGHT', 'AGT_TRUSTED_ISSUERS_FILE', 'AGT_PASSPORT_ISSUER_FINGERPRINT']) if (!(k in extraEnv)) delete env[k];
  try { fs.writeFileSync(path.join(root, 'boot.json'), '{"bootstrap":[]}'); } catch {}
  const proc = spawn(process.execPath, [path.join(REPO, 'node.mjs'), String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  node = { url: `http://127.0.0.1:${port}`, child: proc, root, dataDir };
  for (let i = 0; i < 200 && proc.exitCode === null; i++) {
    try { const r = await fetch(node.url + '/identity/meta', { signal: AbortSignal.timeout(2000) }); if (r.status === 200) return; } catch {}
    await sleep(150);
  }
  throw new Error('node not ready');
}

async function main() {
  const forwarded = [];
  let proxy = null;
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-proxy-'));
    const faucetF = createWallet('proxy-faucet-fund');
    const payoutF = createWallet('proxy-payout-fund');
    const agent = createWallet('proxy-agent');
    const wallets = {};
    for (const w of [faucetF, payoutF]) wallets[w.address] = { label: w.label, pub: w.pub, privKey: w.privKey, createdAt: w.createdAt };
    const dataDir = path.join(tmp, 'data'); fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'wallets.json'), JSON.stringify(wallets, null, 1));
    const monday = (() => { const d = new Date(); const wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10); })();
    fs.writeFileSync(path.join(tmp, 'registry.json'), JSON.stringify(
      [{ operatorId: 'proxy-op', period: monday, address: agent.address, amountMinor: 1_000_000_000 }], null, 1));
    fs.writeFileSync(path.join(tmp, 'revoked.json'), '[]');
    await boot({ AGT_DATA_DIR: dataDir, AGT_PILOT_FAUCET_FUND: faucetF.address, AGT_PILOT_PAYOUT_FUND: payoutF.address,
      AGT_PILOT_REVOKED_FILE: path.join(tmp, 'revoked.json'), AGT_PILOT_PAYOUT_REGISTRY: path.join(tmp, 'registry.json') });
    for (let i = 0; i < 2; i++) await direct('/mine', { method: 'POST', body: { miner: faucetF.address } });
    // паспорт агента в локальном реестре (прямо к ноде, публичный маршрут)
    const ch0 = await direct('/identity/challenge', { method: 'POST', body: { address: agent.address, pub: agent.pub, handle: 'proxy-agent' }, token: null });
    if (ch0.status === 200 && ch0.body.ok) {
      await direct('/identity/register', { method: 'POST', body: { challengeId: ch0.body.challengeId, signature: signMsg(agent.privKey, ch0.body.message) }, token: null });
    }

    const pPort = await pickPort();
    proxy = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        const u = new URL(req.url, 'http://x');
        const send = (s, obj) => { const b = JSON.stringify(obj); res.writeHead(s, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b) }); res.end(b); };
        if (/^\/pilot\//.test(u.pathname)) return send(403, { error: 'proxy_admin_prefix_denied' }); // правило 1: до ноды не доходит
        if (/^\/api\/v1\/(pilot|faucet)\//.test(u.pathname)) return send(403, { error: 'proxy_admin_prefix_denied' }); // правило 1б: /api/v1-префикс не открывает admin/кран (как guard ноды)
        const m = `${req.method} ${u.pathname}`;
        const fwd = (m === 'POST /faucet/pilot/challenge' || m === 'POST /faucet/pilot/claim' ||
          m === 'GET /life' || m === 'GET /network/nodes');
        if (!fwd) return send(404, { error: 'proxy_not_published' }); // правило 4
        forwarded.push(m); // правило 2/3: только здесь обращаемся к ноде
        try {
          const r = await fetch(node.url + u.pathname, { method: req.method, redirect: 'manual',
            signal: AbortSignal.timeout(20000),
            headers: { 'content-type': 'application/json' }, body: raw || undefined });
          const txt = await r.text();
          res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json', ...(r.headers.get('location') ? { location: r.headers.get('location') } : {}) });
          res.end(txt);
        } catch (e) { send(502, { error: 'proxy_upstream_failed' }); }
      });
    });
    await new Promise((r) => proxy.listen(pPort, '127.0.0.1', r));
    const P = `http://127.0.0.1:${pPort}`;
    const via = (route, { method = 'GET', body, token } = {}) => {
      const headers = { 'content-type': 'application/json' };
      if (token) headers['x-admin-token'] = token;
      return fetch(P + route, { method, redirect: 'manual', signal: AbortSignal.timeout(20000), headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
        .then(async (r) => ({ status: r.status, ct: r.headers.get('content-type'), loc: r.headers.get('location'), text: await r.text() }));
    };
    const counts = async () => (await direct('/pilot/status')).body.counts;

    const g = await via('/pilot/status');
    step('P1 GET /pilot/status → явный отказ края 403 JSON (не HTML)', g.status === 403 && /application\/json/.test(g.ct || '') && g.text.includes('proxy_admin_prefix_denied') && !/<html/i.test(g.text), `${g.status} ${g.ct}`);
    step('P1b без редиректов', g.status !== 301 && g.status !== 302 && !g.loc, `loc=${g.loc}`);
    const p1 = await via('/pilot/payout', { method: 'POST', body: {} });
    step('P2 POST /pilot/payout → 403 до ноды', p1.status === 403 && !forwarded.includes('POST /pilot/payout'), `${p1.status}`);
    const p2 = await via('/pilot/reconcile', { method: 'POST', body: {} });
    step('P3 POST /pilot/reconcile → 403 до ноды', p2.status === 403 && !forwarded.includes('POST /pilot/reconcile'), `${p2.status}`);
    const c0 = await counts();
    const c1 = await via('/faucet/pilot/challenge', { method: 'POST', body: {} });
    step('P4 challenge {} → 400 bad_address, журнала нет', c1.status === 400 && c1.text.includes('bad_address') && (await counts()).faucet === c0.faucet, `${c1.status}`);
    const c2 = await via('/faucet/pilot/challenge', { method: 'POST', body: { address: 'AGTX' } });
    step('P5 challenge AGTX → 404 passport_not_found, журнала нет', c2.status === 404 && c2.text.includes('passport_not_found') && (await counts()).faucet === c0.faucet, `${c2.status}`);
    const c3 = await via('/faucet/pilot/claim', { method: 'POST', body: { challengeId: 'x', signature: 'y' } });
    step('P6 claim мусор → 400 bad_params, выплат нет', c3.status === 400 && c3.text.includes('bad_params') && (await counts()).faucet === c0.faucet, `${c3.status}`);
    const ch = await via('/faucet/pilot/challenge', { method: 'POST', body: { address: agent.address } });
    const chb = JSON.parse(ch.text);
    const cl = await via('/faucet/pilot/claim', { method: 'POST', body: { challengeId: chb.challengeId, signature: signMsg(agent.privKey, chb.message) } });
    step('P7 валидные challenge→claim через прокси → pending, +1 запись', ch.status === 200 && cl.status === 200 && cl.text.includes('pending') && (await counts()).faucet === c0.faucet + 1, `${ch.status}/${cl.status}`);
    const lf = await via('/life');
    step('P8 GET /life через прокси → 200 JSON', lf.status === 200 && /application\/json/.test(lf.ct || ''), `${lf.status} ${lf.ct}`);
    const rn = await via('/network/nodes'); // нода отдаёт /network/nodes; публичный /api/v1/* — rewrite края (вверх по тексту)
    step('P9 GET /network/nodes через прокси → 200 JSON', rn.status === 200 && /application\/json/.test(rn.ct || ''), `${rn.status}`);
    const gt = await via('/pilot/status', { token: 'wrong' });
    step('P10 токен не открывает /pilot/* через прокси → 403', gt.status === 403 && gt.text.includes('proxy_admin_prefix_denied'), `${gt.status}`);
    const a1 = await via('/api/v1/pilot/status');
    step('P13 GET /api/v1/pilot/status → 403 до ноды (префикс не открывает)', a1.status === 403 && a1.text.includes('proxy_admin_prefix_denied') && !forwarded.includes('GET /api/v1/pilot/status'), `${a1.status}`);
    const a2 = await via('/api/v1/faucet/pilot/challenge', { method: 'POST', body: {} });
    step('P14 POST /api/v1/faucet/pilot/challenge → 403 (кран только без префикса)', a2.status === 403 && !forwarded.includes('POST /api/v1/faucet/pilot/challenge'), `${a2.status}`);
    const lb = await direct('/pilot/status');
    step('P11 loopback с токеном → 200 (операторский путь жив)', lb.status === 200 && lb.body.faucetEnabled === true, `${lb.status}`);
    step('P12 запрещённое не доходило до ноды', !forwarded.some((m) => m.startsWith('GET /pilot/') || m.startsWith('POST /pilot/')), forwarded.join(',').slice(0, 160));
  } finally {
    try { proxy && proxy.close(); } catch {}
    try { node.child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(node.root, { recursive: true, force: true }); } catch {}
  }
  const failed = R.steps.filter((s) => !s.ok).length;
  console.log(`ИТОГ proxy-stand: ${R.steps.length - failed} pass / ${failed} fail`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error('STAND_ERROR', e); try { node.child.kill('SIGKILL'); } catch {} process.exit(1); });
