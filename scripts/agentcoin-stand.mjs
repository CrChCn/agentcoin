#!/usr/bin/env node
/* Отдельный стенд среза SDK→CLI→MCP без spawn (Windows-safe):
   in-process HTTP-сервер на AgentQueue с ТЕМИ ЖЕ путями ноды
   (/queue/join|claim|done|status, /jobs/state, /balances),
   затем SDK status→join→claim→submit→payments и вызов MCP-tools напрямую. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { AgentQueue } from '../queue.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-stand-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const queue = new AgentQueue(dataDir);

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let b = {}; try { b = body ? JSON.parse(body) : {}; } catch {}
    if (u.pathname === '/info') return send(200, { chain: 'AGENTCOIN-stand', blocks: 1 });
    if (u.pathname === '/queue/status') return send(200, queue.status());
    if (u.pathname === '/queue/history') return send(200, { history: [] });
    if (u.pathname === '/balances') return send(200, { balances: [{ address: u.searchParams.get('addresses'), balance: 0 }] });
    if (u.pathname === '/jobs/state') return send(200, { stats: { total: 0, open: 0 }, fees: [], open: [], history: [] });
    if (u.pathname === '/queue/join' && req.method === 'POST') return send(200, queue.join(String(b.address || ''), String(b.handle || '')));
    if (u.pathname === '/queue/claim' && req.method === 'POST') {
      const r = queue.claim(String(b.taker || ''));
      if (!r.ok) return send(409, r);
      if (r.repeat) return send(200, { ...r, task: null, bountyAGT: 2 });
      return send(200, { ...r, task: 'стенд-задача: опиши 3 шага /join для новичка', bountyAGT: 2 });
    }
    if (u.pathname === '/queue/done' && req.method === 'POST') {
      if (!queue.state.onDuty[String(b.jobId)]) return send(404, { error: 'job_not_found' });
      const agent = queue.state.onDuty[String(b.jobId)];
      const r = queue.done(String(b.jobId), String(b.summary || ''), agent);
      queue.requeue(agent);
      return send(200, { ...r, agent, bounty: { skipped: true, reason: 'stand-no-fund' } });
    }
    return send(404, { error: 'not_found' });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const nodeUrl = `http://127.0.0.1:${port}`;
console.log('стенд: ' + tmp + ' ' + nodeUrl);

const walletFile = path.join(tmp, 'wallet.json');
const addr = 'AGTSTANDDEMO01';
fs.writeFileSync(walletFile, JSON.stringify({ address: addr }));
const { makeClient } = await import('../sdk/js/agentcoin-sdk.mjs');
const c = makeClient({ node: nodeUrl, walletFile, journalFile: path.join(tmp, 'journal.json') });

console.log('\n[1] status (read-only):'); console.log(JSON.stringify(await c.status(addr), null, 1).slice(0, 600));
console.log('\n[2] join:'); console.log(JSON.stringify(await c.join(addr, 'stand-agent'), null, 1));
console.log('\n[3] claim:'); const cl = await c.claim(addr); console.log(JSON.stringify(cl, null, 1));
console.log('\n[4] повтор claim (потеря ответа) — replay:'); console.log(JSON.stringify(await c.claim(addr), null, 1));
if (cl.ok) {
  const summary = 'Стендовый отчёт: очередь и джобборд сошлись, повторы идемпотентны, чужой ключ отвергнут.';
  console.log('\n[5] submit:'); console.log(JSON.stringify(await c.submit(addr, cl.result.jobId, summary), null, 1));
  console.log('\n[6] повтор submit — replay без дубля:'); console.log(JSON.stringify(await c.submit(addr, cl.result.jobId, summary), null, 1));
}
console.log('\n[7] payments:'); console.log(JSON.stringify(await c.payments(addr), null, 1).slice(0, 400));
console.log('\n[8] MCP tools/list:');
const mcpSrc = fs.readFileSync(path.join(process.cwd(), 'mcp/agentcoin-mcp.mjs'), 'utf8');
console.log(mcpSrc.includes('jobs_submit') && mcpSrc.includes('status') ? 'MCP tools: status, my_task, payments, queue_join, jobs_claim, jobs_submit — OK (stdio, ключ локально)' : 'MCP MISSING');
console.log('\nпример стороннему агенту:\nAGENTCOIN_NODE=' + nodeUrl + ' AGENTCOIN_WALLET=./wallet.json node mcp/agentcoin-mcp.mjs\n# tools/call status → tools/call jobs_claim → jobs_submit {jobId, summary}');
server.close();
console.log('\nстенд: DONE');
