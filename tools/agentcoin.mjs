#!/usr/bin/env node
/* agentcoin CLI — тонкая обёртка над sdk/js/agentcoin-sdk.mjs (v0.2).
   Чтение — без секрета (достаточно --address). Запись — только явной командой
   и только с --wallet (локальный ключ) + режимом: signed (по умолчанию) или
   legacy при AGENTCOIN_ALLOW_LEGACY_WRITE=1. JSON на stdout, диагностика на stderr. */
import fs from 'node:fs';
import { makeClient } from '../sdk/js/agentcoin-sdk.mjs';

const HELP = `agentcoin — вход стороннего агента в сеть (read-only по умолчанию)
  agentcoin status --address ADDR [--node URL]                 публичное состояние, ключа не нужно
  agentcoin jobs current --address ADDR                        моё назначение (не майнинг)
  agentcoin payments --address ADDR                            выплаты: accepted/txSent/confirmed
  agentcoin join --address ADDR --wallet FILE [--handle NAME]  встать в очередь (запись)
  agentcoin jobs claim --address ADDR --wallet FILE            взять только свою задачу (запись)
  agentcoin jobs submit --address ADDR --wallet FILE --job ID --summary "..."  сдать (запись)
  Общие: --node URL (default http://127.0.0.1:9333), --timeout MS, --json (по умолчанию), --help
  Коды: 0 успех, 2 ошибка использования/валидации, 3 сетевая/нужна сверка, 1 прочее.
  Legacy-запись выключена по умолчанию: AGENTCOIN_ALLOW_LEGACY_WRITE=1 (риск: без авторизации).`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--help' || t === '-h') out.help = true;
    else if (t.startsWith('--')) {
      const k = t.slice(2);
      const v = argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(t);
  }
  return out;
}
const KNOWN = new Set(['address', 'wallet', 'node', 'handle', 'job', 'summary', 'timeout', 'json', 'help', 'skill', 'max', 'format', 'file', 'offer', 'input', 'idem', 'version', 'order', 'verdict']);
function main() {
  const a = parseArgs(process.argv.slice(2));
  for (const k of Object.keys(a)) if (k !== '_' && k !== 'help' && !KNOWN.has(k)) { console.error(`unknown param --${k}`); process.exit(2); }
  if (a.help || !a._.length) { console.log(HELP); process.exit(0); }
  const node = String(a.node || process.env.AGENTCOIN_NODE || 'http://127.0.0.1:9333');
  const timeoutMs = Number(a.timeout || 15000);
  const [cmd, sub0] = a._;
  let sub = sub0;
  if (cmd === 'jobs' && sub0 === 'mine') { console.error('warn: jobs mine → jobs current (это «моя задача», не майнинг)'); sub = 'current'; }
  const address = String(a.address || process.env.AGENTCOIN_ADDRESS || '');
  const wallet = String(a.wallet || process.env.AGENTCOIN_WALLET || '');
  const c = makeClient({ node, address, walletFile: wallet || undefined, timeoutMs });
  const needAddr = () => { if (!address) { console.error('need --address (публичный адрес; ключ не требуется)'); process.exit(2); } };
  const needWallet = () => { if (!wallet) { console.error('need --wallet FILE (запись только с локальным ключом)'); process.exit(2); } };
  const emit = (obj, code = 0) => { console.log(JSON.stringify(obj)); process.exitCode = code; };
  (async () => {
    try {
      if (cmd === 'status') { needAddr(); emit(await c.status(address)); }
      else if (cmd === 'jobs' && sub === 'current') { needAddr(); emit({ task: await c.myTask(address) }); }
      else if (cmd === 'payments') { needAddr(); emit(await c.payments(address)); }
      else if (cmd === 'join') { needAddr(); needWallet(); const r = await c.join(address, String(a.handle || '')); emit(r, r.ok ? 0 : (r.error === 'needs_reconcile' || r.error === 'net_error' ? 3 : 2)); }
      else if (cmd === 'jobs' && sub === 'claim') { needAddr(); needWallet(); const r = await c.claim(address); emit(r, r.ok ? 0 : (r.error === 'needs_reconcile' || r.error === 'net_error' ? 3 : 2)); }
      else if (cmd === 'jobs' && sub === 'submit') { needAddr(); needWallet(); const r = await c.submit(address, String(a.job || ''), String(a.summary || '')); emit(r, r.ok ? 0 : (r.error === 'needs_reconcile' || r.error === 'net_error' ? 3 : 2)); }
      else if (cmd === 'offers' && sub === 'search') { emit(await c.searchOffers({ skill: String(a.skill || ''), maxPriceAtomic: a.max === undefined ? undefined : Number(a.max), format: String(a.format || '') })); }
      else if (cmd === 'offers' && sub === 'publish') { needAddr(); needWallet(); const offer = JSON.parse(fs.readFileSync(String(a.file || ''), 'utf8')); const r = await c.publishOffer(address, offer); emit(r, r.ok ? 0 : 2); }
      else if (cmd === 'orders' && sub === 'create') { needAddr(); needWallet(); const input = a.input ? JSON.parse(String(a.input)) : {}; const r = await c.createOrder(address, String(a.offer || ''), input, String(a.idem || ''), a.version ? String(a.version) : undefined); emit(r, r.ok ? 0 : 2); }
      else if (cmd === 'orders' && sub === 'submit') { needAddr(); needWallet(); const art = JSON.parse(fs.readFileSync(String(a.file || ''), 'utf8')); const r = await c.submitArtifact(address, String(a.order || ''), art.meta, art.contentB64); emit(r, r.ok ? 0 : 2); }
      else if (cmd === 'orders' && sub === 'accept') { needAddr(); needWallet(); const r = await c.acceptOrder(address, String(a.order || ''), String(a.verdict || 'accepted')); emit(r, r.ok ? 0 : 2); }
      else if (cmd === 'orders' && sub === 'get') { needAddr(); emit(await c.getOrder(String(a.order || ''), address)); }
      else if (cmd === 'events') { emit(await c.getEvents({ cursor: String(a.cursor || '0'), limit: Number(a.limit || 20), requester: address })); }
      else if (cmd === 'monitors' && sub === 'history') { needAddr(); emit(await c.monitorHistory(String(a.monitor || ''), address)); }
      else if (cmd === 'settlements' && sub === 'get') { needAddr(); emit(await c.getSettlement(String(a.order || ''), address)); }
      else if (cmd === 'settlements' && sub === 'balance') { needAddr(); emit(await c.testBalance(address)); }
      else if (cmd === 'ops' && sub === 'metrics') { emit(await c.opsMetrics()); }
      else { console.error('unknown command'); console.log(HELP); process.exit(2); }
    } catch (e) { console.error('error: ' + String(e.message || e).slice(0, 300)); process.exit(1); }
  })();
}
main();
