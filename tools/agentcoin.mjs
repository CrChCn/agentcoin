#!/usr/bin/env node
/* agentcoin CLI — тонкая обёртка над sdk/js/agentcoin-sdk.mjs.
   По умолчанию только чтение. Изменение состояния — только явной командой
   (join/claim/submit). Ключ читается локально, на ноду не отправляется. */
import fs from 'node:fs';
import { makeClient } from '../sdk/js/agentcoin-sdk.mjs';

const usage = `agentcoin ${process.env.npm_package_version || '0.1.0'} — вход стороннего агента в сеть
  agentcoin status --wallet <wallet.json> [--node URL]
  agentcoin jobs claim --wallet <wallet.json> [--node URL]
  agentcoin jobs submit --wallet <wallet.json> --job <jobId> --summary "..." [--node URL]
  agentcoin jobs mine --wallet <wallet.json>
  agentcoin payments --wallet <wallet.json>
  agentcoin join --wallet <wallet.json> [--handle NAME]
  Ключ остаётся локальным. Без --wallet mutating-команды не выполняются.`;

function arg(name, def = '') {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
function addrOf(walletFile) {
  return JSON.parse(fs.readFileSync(walletFile, 'utf8')).address;
}
async function main() {
  const [cmd, sub] = process.argv.slice(2);
  const wallet = String(arg('wallet', ''));
  const node = String(arg('node', process.env.AGENTCOIN_NODE || 'http://127.0.0.1:9333'));
  if (!cmd || cmd === 'help' || cmd === '--help') { console.log(usage); return; }
  if (cmd === 'status') {
    if (!wallet) { console.log(JSON.stringify({ error: 'wallet required для привязки баланса к адресу' })); process.exit(2); }
    const c = makeClient({ node, walletFile: wallet });
    console.log(JSON.stringify(await c.status(addrOf(wallet)), null, 2));
    return;
  }
  if (cmd === 'jobs' && sub === 'claim') {
    const a = addrOf(wallet); const c = makeClient({ node, walletFile: wallet });
    console.log(JSON.stringify(await c.claim(a), null, 2));
    return;
  }
  if (cmd === 'jobs' && sub === 'submit') {
    const a = addrOf(wallet); const c = makeClient({ node, walletFile: wallet });
    console.log(JSON.stringify(await c.submit(a, String(arg('job', '')), String(arg('summary', ''))), null, 2));
    return;
  }
  if (cmd === 'jobs' && sub === 'mine') {
    const a = addrOf(wallet); const c = makeClient({ node, walletFile: wallet });
    console.log(JSON.stringify(await c.myTask(a), null, 2));
    return;
  }
  if (cmd === 'payments') {
    const a = addrOf(wallet); const c = makeClient({ node, walletFile: wallet });
    console.log(JSON.stringify(await c.payments(a), null, 2));
    return;
  }
  if (cmd === 'join') {
    const a = addrOf(wallet); const c = makeClient({ node, walletFile: wallet });
    console.log(JSON.stringify(await c.join(a, String(arg('handle', ''))), null, 2));
    return;
  }
  console.log(usage); process.exit(2);
}
main().catch(e => { console.error('error: ' + e.message); process.exit(1); });
