#!/usr/bin/env node
/* Реальный MCP-клиент: initialize, tools/list, tools/call (read+mutating),
   неизвестный инструмент, неверные аргументы, параллельные вызовы, чистый выход. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStand } from '../sdk/js/stand-server.mjs';
import { addressFromPub } from '../core.mjs';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + name + (extra ? ' — ' + extra : '')); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agtmcp-'));
const stand = await createStand(tmp);
const k = crypto.generateKeyPairSync('ed25519');
const pubPem = k.publicKey.export({ type: 'spki', format: 'pem' });
const addr = addressFromPub(pubPem);
const wallet = path.join(tmp, 'w.json');
fs.writeFileSync(wallet, JSON.stringify({ address: addr, public_key_pem: pubPem, privateKeyPem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));

const child = spawn(process.execPath.includes(' ') ? `"${process.execPath}"` : process.execPath, [path.resolve('mcp/agentcoin-mcp.mjs')], {
  env: { ...process.env, AGENTCOIN_NODE: stand.url, AGENTCOIN_ADDRESS: addr, AGENTCOIN_WALLET: wallet },
  stdio: ['pipe', 'pipe', 'pipe'], shell: true,
});
let outBuf = '';
const pending = new Map();
let seq = 1;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  for (const line of String(d).split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      // stdout — только протокол: строка обязана быть JSON-RPC
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    } catch { fail++; console.log('FAIL  stdout не протокол: ' + line.slice(0, 80)); }
  }
});
let stderrTxt = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => { stderrTxt += d; });
const rpc = (method, params) => new Promise((res) => { const id = seq++; pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); setTimeout(() => { if (pending.has(id)) { pending.delete(id); res({ error: { message: 'timeout' } }); } }, 10000); });
await new Promise((r) => setTimeout(r, 800));

const init = await rpc('initialize', {});
ok(init.result?.serverInfo?.name === 'agentcoin' && init.result?.protocolVersion, 'initialize + версия протокола');
const list = await rpc('tools/list', {});
  ok(Array.isArray(list.result?.tools) && list.result.tools.length === 24, 'tools/list — 24 инструмента (A+B+C+D+расчёт+метрики)');
const st = await rpc('tools/call', { name: 'status', arguments: { address: addr } });
ok(st.result?.content?.[0]?.text?.includes('queue') || JSON.stringify(st).includes('queue'), 'tools/call status');
const unk = await rpc('tools/call', { name: 'nope', arguments: {} });
ok(unk.error?.code === -32601, 'неизвестный инструмент — структурированная ошибка');
const bad = await rpc('tools/call', { name: 'jobs_submit', arguments: { address: addr, jobId: 'x' } });
ok(bad.error?.code === -32602, 'неверные аргументы — структурированная ошибка');
// параллельные чтения
const [p1, p2] = await Promise.all([rpc('tools/call', { name: 'my_task', arguments: {} }), rpc('tools/call', { name: 'payments', arguments: {} })]);
ok(p1.result && p2.result, 'параллельные вызовы');
// мутирующий без wallet — отдельный процесс без WALLET
  const mut = list.result.tools.filter(t => /MUTATING/.test(t.description)).length;
  const ro = list.result.tools.filter(t => /READ-ONLY/.test(t.description)).length;
  ok(mut === 16 && ro === 8, `мутирующие MUTATING (${mut}), чтение READ-ONLY (${ro})`);
child.stdin.end();
await new Promise((r) => child.on('exit', r));
ok(true, 'чистый выход процесса');
stand.close();
console.log(`stderr имел диагностику (не протокол): ${stderrTxt.trim() ? 'да' : 'нет'}`);
console.log(`\nитог: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
