#!/usr/bin/env node
/* Agentcoin MCP-сервер v0.2 (stdio, zero-deps). stdout — ТОЛЬКО протокол,
   диагностика — stderr. Мутирующие инструменты помечены destructive. */
import fs from 'node:fs';
import { makeClient } from '../sdk/js/agentcoin-sdk.mjs';

const NODE = process.env.AGENTCOIN_NODE || 'http://127.0.0.1:9333';
const ADDRESS = process.env.AGENTCOIN_ADDRESS || '';
const WALLET = process.env.AGENTCOIN_WALLET || '';
const err = (m) => process.stderr.write(String(m) + '\n');

const TOOLS = [
  { name: 'status', description: 'READ-ONLY: публичное состояние сети и очереди', inputSchema: { type: 'object', properties: { address: { type: 'string' } } } },
  { name: 'my_task', description: 'READ-ONLY: моё текущее назначение', inputSchema: { type: 'object', properties: { address: { type: 'string' } } } },
  { name: 'payments', description: 'READ-ONLY: стадии выплаты (accepted/txSent/confirmed)', inputSchema: { type: 'object', properties: { address: { type: 'string' } } } },
  { name: 'queue_join', description: 'MUTATING (destructive): встать в очередь', inputSchema: { type: 'object', properties: { address: { type: 'string' }, handle: { type: 'string' } }, required: ['address'] } },
  { name: 'jobs_claim', description: 'MUTATING (destructive): взять только свою задачу', inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] } },
  { name: 'jobs_submit', description: 'MUTATING (destructive): сдать работу (summary>=40)', inputSchema: { type: 'object', properties: { address: { type: 'string' }, jobId: { type: 'string' }, summary: { type: 'string' } }, required: ['address', 'jobId', 'summary'] } },
];
function client(addr) {
  const a = addr || ADDRESS;
  if (!a) throw Object.assign(new Error('address required'), { code: -32000 });
  return { c: makeClient({ node: NODE, address: a, walletFile: WALLET || undefined }), addr: a };
}
async function call(name, args = {}) {
  const { c, addr } = client(args.address);
  if (name === 'status') return await c.status(addr);
  if (name === 'my_task') return { task: await c.myTask(addr) };
  if (name === 'payments') return await c.payments(addr);
  if (name === 'queue_join') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.join(addr, String(args.handle || '')); }
  if (name === 'jobs_claim') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.claim(addr); }
  if (name === 'jobs_submit') {
    if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 });
    if (!args.jobId || String(args.summary || '').length < 40) throw Object.assign(new Error('jobId and summary>=40 required'), { code: -32602 });
    return await c.submit(addr, String(args.jobId), String(args.summary));
  }
  throw Object.assign(new Error('unknown tool ' + name), { code: -32601 });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { err('bad json line'); continue; }
    const reply = (result, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, ...(error ? { error } : { result }) }) + '\n');
    try {
      if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agentcoin', version: '0.2.0' } });
      else if (msg.method === 'tools/list') reply({ tools: TOOLS });
      else if (msg.method === 'tools/call') {
        try { reply({ content: [{ type: 'text', text: JSON.stringify(await call(msg.params?.name, msg.params?.arguments)) }] }); }
        catch (e) { reply(null, { code: e.code || -32000, message: String(e.message || e).slice(0, 300) }); }
      }
      else reply(null, { code: -32601, message: 'method not found' });
    } catch (e) { reply(null, { code: -32000, message: String(e.message || e).slice(0, 300) }); }
  }
});
process.stdin.on('end', () => process.exit(0));
err('agentcoin-mcp ready');
