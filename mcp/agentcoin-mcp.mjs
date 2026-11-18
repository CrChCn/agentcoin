#!/usr/bin/env node
/* Agentcoin MCP-сервер (stdio, zero-deps) — те же вызовы SDK, что и CLI.
   Tools: status (read-only), my_task (read-only), payments (read-only),
   queue_join / jobs_claim / jobs_submit (mutating — только явный вызов модели).
   Секреты: читает локальный wallet.json через SDK, наружу ключ не уходит. */
import fs from 'node:fs';
import { makeClient } from '../sdk/js/agentcoin-sdk.mjs';

const NODE = process.env.AGENTCOIN_NODE || 'http://127.0.0.1:9333';
const WALLET = process.env.AGENTCOIN_WALLET || '';
const addrOf = (f) => JSON.parse(fs.readFileSync(f, 'utf8')).address;

const TOOLS = [
  { name: 'status', description: 'Состояние сети + баланс + очередь (read-only)', inputSchema: { type: 'object', properties: {} } },
  { name: 'my_task', description: 'Моё текущее назначение в очереди (read-only)', inputSchema: { type: 'object', properties: {} } },
  { name: 'payments', description: 'Мои выплаты по джобборду (read-only)', inputSchema: { type: 'object', properties: {} } },
  { name: 'queue_join', description: 'Встать в очередь (меняет состояние)', inputSchema: { type: 'object', properties: { handle: { type: 'string' } } } },
  { name: 'jobs_claim', description: 'Взять только свою задачу (меняет состояние)', inputSchema: { type: 'object', properties: {} } },
  { name: 'jobs_submit', description: 'Сдать работу: jobId + summary>=40 (меняет состояние)', inputSchema: { type: 'object', properties: { jobId: { type: 'string' }, summary: { type: 'string' } }, required: ['jobId', 'summary'] } },
];

function client() {
  if (!WALLET) throw new Error('AGENTCOIN_WALLET не задан: путь к локальному wallet.json');
  return { c: makeClient({ node: NODE, walletFile: WALLET }), addr: addrOf(WALLET) };
}
async function call(name, args = {}) {
  const { c, addr } = client();
  if (name === 'status') return await c.status(addr);
  if (name === 'my_task') return await c.myTask(addr);
  if (name === 'payments') return await c.payments(addr);
  if (name === 'queue_join') return await c.join(addr, String(args.handle || ''));
  if (name === 'jobs_claim') return await c.claim(addr);
  if (name === 'jobs_submit') return await c.submit(addr, String(args.jobId || ''), String(args.summary || ''));
  throw new Error('unknown tool ' + name);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    const reply = (result, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, ...(error ? { error } : { result }) }) + '\n');
    try {
      if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agentcoin', version: '0.1.0' } });
      else if (msg.method === 'tools/list') reply({ tools: TOOLS });
      else if (msg.method === 'tools/call') reply({ content: [{ type: 'text', text: JSON.stringify(await call(msg.params?.name, msg.params?.arguments), null, 2) }] });
      else reply(null, { code: -32601, message: 'method not found' });
    } catch (e) { reply(null, { code: -32000, message: String(e.message || e) }); }
  }
});
