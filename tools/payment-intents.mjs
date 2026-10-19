#!/usr/bin/env node
/** Offline by default. No wallet discovery, key loading or automatic signing. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PaymentIntentJournal, inspectPaymentPlan } from '../payment-intent.mjs';
function fail(s) { throw new Error('payment_cli_' + s); }
function parse(args) {
  const [command, ...rest] = args, options = {};
  if (!['plan', 'prepare', 'inspect', 'reconcile', 'submit'].includes(command)) fail('usage_plan_prepare_inspect_reconcile_submit');
  const allowed = new Set(['intent', 'tx', 'journal', 'genesis', 'task', 'observation', 'origin', 'broadcast']);
  for (let i = 0; i < rest.length; i++) {
    const name = rest[i].slice(2);
    if (!rest[i].startsWith('--') || !allowed.has(name) || name in options) fail('arguments');
    if (name === 'broadcast') options[name] = true;
    else { if (!rest[i + 1] || rest[i + 1].startsWith('--')) fail('argument_value'); options[name] = rest[++i]; }
  }
  if (options.broadcast && command !== 'submit') fail('broadcast_submit_only');
  return { command, options };
}
export function paymentOrigin(value) {
  let u; try { u = new URL(value); } catch { fail('origin'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (!['https:', 'http:'].includes(u.protocol) || (u.protocol === 'http:' && !loopback) || u.username || u.password || u.pathname !== '/' || u.search || u.hash || u.origin !== value.replace(/\/$/, '')) fail('origin');
  return u.origin;
}
function rejectSecrets(value) {
  if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(JSON.stringify(value))) fail('private_material_forbidden');
  if (value && typeof value === 'object') for (const [key, v] of Object.entries(value)) {
    if (/^(privKey|privateKey|password|mnemonic|seed|adminToken|token)$/i.test(key)) fail('private_material_forbidden');
    rejectSecrets(v);
  }
}
async function jsonFile(name) { if (!name) fail('file_required'); const obj = JSON.parse(await fs.readFile(name, 'utf8')); rejectSecrets(obj); return obj; }
export async function runPaymentCLI(args, { fetchFn = globalThis.fetch, now = Date.now } = {}) {
  const { command, options: o } = parse(args);
  if (command === 'plan') return inspectPaymentPlan(await jsonFile(o.intent), await jsonFile(o.tx));
  if (!o.journal || !path.isAbsolute(o.journal) || !o.genesis) fail('journal_absolute_and_genesis_required');
  const j = new PaymentIntentJournal({ file: o.journal, genesisHash: o.genesis, now });
  if (command === 'prepare') return j.prepare(await jsonFile(o.intent), await jsonFile(o.tx));
  if (!o.task) fail('task_required');
  if (command === 'inspect') return j.inspect(o.task);
  if (command === 'reconcile') return j.reconcile(o.task, await jsonFile(o.observation));
  // Validate origin before any journal modification. No fetch is called in dry-run.
  const origin = o.origin ? paymentOrigin(o.origin) : null;
  if (!o.broadcast) return j.submit(o.task, null);
  if (!origin) fail('origin_required_for_broadcast');
  return j.submit(o.task, async transaction => {
    const response = await fetchFn(origin + '/tx', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(transaction),
      redirect: 'error', signal: AbortSignal.timeout(8000), credentials: 'omit',
    });
    // Receipt only. Confirmation must be established by subsequent full reconciliation.
    try { if (response.body) await response.body.cancel(); } catch { /* receipt body is irrelevant */ }
    if (![200, 201].includes(response.status)) fail('submission_http_' + response.status);
    return { httpStatus: response.status, confirmation: false };
  }, { dryRun: false });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runPaymentCLI(process.argv.slice(2)).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
