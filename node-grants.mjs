#!/usr/bin/env node
/** Legacy grants are disabled; ledger inspection remains read-only and fail-closed. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function checkGrantLedger(file) {
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, status: 'missing_unverified', grants: [] };
    throw e;
  }
  const l = JSON.parse(raw);
  if (!l || !l.grants || typeof l.grants !== 'object' || Array.isArray(l.grants)) throw Error('grant_ledger_corrupt');
  const grants = Object.entries(l.grants).map(([address, g]) => {
    if (!/^AGT[0-9a-f]{40}$/.test(address) || !g || typeof g !== 'object' || typeof g.peerRef !== 'string' || !Number.isSafeInteger(g.lastPaidAt) || g.lastPaidAt < 0 || !Number.isFinite(g.totalPaid) || g.totalPaid < 0 || typeof g.lastTxid !== 'string' || !/^[a-f0-9]{16,64}$/.test(g.lastTxid)) throw Error('grant_ledger_corrupt');
    return { address, ...g, confirmation: 'unverified_legacy_record' };
  });
  return { exists: true, status: 'legacy_records_not_chain_confirmation', grants };
}
export async function runGrantCLI(args) {
  if (args[0] !== 'check-ledger' || (args.length !== 1 && !(args.length === 3 && args[1] === '--ledger'))) throw Error('node-grants: implicit grant payouts disabled. Use tools/payment-intents.mjs; see docs/PAYMENT-INTENTS.md. Read-only: check-ledger [--ledger PATH]');
  const file = args[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data-agents', 'node-grants.json');
  return checkGrantLedger(file);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runGrantCLI(process.argv.slice(2)).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
