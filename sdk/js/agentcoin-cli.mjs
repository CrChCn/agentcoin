#!/usr/bin/env node
/* Agentcoin CLI v0.3 (zero-deps) — тот же набор операций, что MCP 0.2 и SDK 0.3.
   Правила (ТЗ §1):
     - одна семантика с SDK/MCP: CLI не придумывает своих состояний и не обходит SDK;
     - секреты только из файла (--wallet), никогда из argv/env-дампа/вывода;
     - деньги — целые атомарные единицы, без float;
     - stdout — ровно один JSON, диагностика — stderr;
     - ok:false → exit 1 (отказ никогда не выдаётся за успех), ошибка аргументов → exit 2;
     - адрес и получатель проверяются до подписи (это делает SDK), артефакт — до отправки.
   Использование: node sdk/js/agentcoin-cli.mjs <команда> [--флаги]. См. --help. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { makeClient } from './agentcoin-sdk.mjs';

const VERSION = '0.3.0';

class UsageError extends Error {}
const usage = (m) => new UsageError(m);

const MUTATING = new Set([
  'queue-join', 'queue-claim', 'queue-submit',
  'offer-publish', 'order-create', 'order-submit', 'order-accept',
  'monitor-create', 'monitor-pause', 'monitor-cancel', 'monitor-tick',
  'faucet', 'settlement-create', 'settlement-send', 'settlement-confirm',
  'settlement-dispute', 'settlement-cancel', 'complain', 'moderation-decide',
]);

const HELP = `agentcoin-cli ${VERSION} — услуги Agentcoin из терминала (zero-deps)

Глобальные флаги: --node <url> --address <addr> --wallet <file> --journal <file> [--pretty]
  env: AGENTCOIN_NODE, AGENTCOIN_ADDRESS, AGENTCOIN_WALLET, AGENTCOIN_JOURNAL

Чтение:
  status                        публичное состояние узла, очереди, баланса
  my-task                       текущее назначение адреса
  payments                      стадии выплат (accepted / txSent / confirmed)
  offers --skill --max-price --format
                                поиск услуг в каталоге
  order-get --assignment [--requester]
  events [--cursor] [--limit]   события с курсором
  monitor-history --monitor
  settlement --assignment
  ops-metrics                   эксплуатационные метрики стенда
  moderation-history

Запись (нужен --wallet; подпись локальная):
  offer-publish --offer <file|json>
  order-create --offer-id <id> [--offer-version] [--input <file|json>] [--idempotency <key>]
  order-submit --assignment <id> --artifact <file|json> --content <file|base64:…>
  order-accept --assignment <id> [--verdict <text>]
  monitor-create --monitor <file|json>
  monitor-pause --monitor <id> [--paused]
  monitor-cancel --monitor <id>
  settlement-create|send|confirm|cancel --assignment <id>
  settlement-dispute --assignment <id> --reason <text>
  faucet --amount <atomic>            (только стенд)
  complain --target-type <t> --target-id <id> --reason <text>
  moderation-decide --complaint <id> --decision <d> --reason <text>
  queue-join [--handle <h>] | queue-claim | queue-submit --job <id> --summary <text>

Коды выхода: 0 успех, 1 отказ/ошибка операции, 2 ошибка аргументов.`;

function readJsonArg(v, what) {
  if (v == null || v === '') throw usage(`${what} required`);
  const s = String(v).trim();
  const text = s.startsWith('@') ? fs.readFileSync(s.slice(1), 'utf8') : s;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw usage(`${what}: invalid JSON (${e.message})`);
  }
}

function readContentB64(v) {
  if (v == null || v === '') throw usage('--content required');
  const s = String(v);
  if (s.startsWith('base64:')) return s.slice(7).trim();
  const p = s.startsWith('@') ? s.slice(1) : s;
  let bytes;
  try {
    bytes = fs.readFileSync(p);
  } catch (e) {
    if (s.startsWith('@')) throw usage(`--content: ${e.message}`);
    bytes = Buffer.from(s, 'utf8'); // инлайн-текст: короткий результат прямо в аргументе
  }
  return bytes.toString('base64');
}

/* Локальная проверка до сети: хеш обязан сойтись с фактическим содержимым,
   размер — с заявленным. Иначе заказ не трогаем вовсе. */
function assertArtifactMatches(artifact, contentB64) {
  const bytes = Buffer.from(contentB64, 'base64');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  const declared = String(artifact.contentHash || '').toLowerCase();
  if (declared !== digest) throw usage(`artifact_hash_mismatch: content=${digest}, artifact=${declared || '—'}`);
  if (Number.isInteger(artifact.sizeBytes) && artifact.sizeBytes !== bytes.length) {
    throw usage(`artifact_size_mismatch: content=${bytes.length}, artifact=${artifact.sizeBytes}`);
  }
}

function build(values) {
  const node = values.node || process.env.AGENTCOIN_NODE || 'https://agentcoin.work';
  const address = values.address || process.env.AGENTCOIN_ADDRESS || '';
  const wallet = values.wallet || process.env.AGENTCOIN_WALLET || '';
  const journal = values.journal || process.env.AGENTCOIN_JOURNAL || undefined;
  const allowLegacy = process.env.AGENTCOIN_ALLOW_LEGACY_WRITE === '1';
  if (allowLegacy) process.stderr.write('warning: AGENTCOIN_ALLOW_LEGACY_WRITE=1 — неподписанная запись\n');
  return {
    address,
    wallet,
    client: makeClient({ node, address, walletFile: wallet || undefined, journalFile: journal, allowLegacyWrite: allowLegacy }),
  };
}

function needAddress(ctx, explicit) {
  const a = explicit || ctx.address;
  if (!a) throw usage('--address (или AGENTCOIN_ADDRESS) обязателен для этой команды');
  return a;
}

function needWallet(ctx) {
  if (!ctx.wallet) throw usage('--wallet обязателен: подпись выполняется локально, ключ из argv не принимается');
  return ctx.wallet;
}

async function run(command, values, positionals) {
  const ctx = build(values);
  const c = ctx.client;
  switch (command) {
    case 'status':
      return await c.status(needAddress(ctx, positionals[0]));
    case 'my-task':
      return { task: await c.myTask(needAddress(ctx, positionals[0])) };
    case 'payments':
      return await c.payments(needAddress(ctx, positionals[0]));
    case 'offers':
      return await c.searchOffers({
        skill: values.skill,
        maxPriceAtomic: values['max-price'] === undefined ? undefined : Number(values['max-price']),
        format: values.format,
      });
    case 'offer-publish': {
      needWallet(ctx);
      const offer = readJsonArg(values.offer, '--offer');
      return await c.publishOffer(needAddress(ctx), offer);
    }
    case 'order-create': {
      needWallet(ctx);
      if (!values['offer-id']) throw usage('--offer-id обязателен');
      const input = values.input ? readJsonArg(values.input, '--input') : {};
      return await c.createOrder(needAddress(ctx), String(values['offer-id']), input, values.idempotency ? String(values.idempotency) : undefined, values['offer-version']);
    }
    case 'order-get': {
      if (!values.assignment) throw usage('--assignment обязателен');
      return await c.getOrder(String(values.assignment), values.requester ? String(values.requester) : undefined);
    }
    case 'order-submit': {
      needWallet(ctx);
      if (!values.assignment) throw usage('--assignment обязателен');
      const artifact = readJsonArg(values.artifact, '--artifact');
      const contentB64 = readContentB64(values.content);
      assertArtifactMatches(artifact, contentB64);
      return await c.submitArtifact(needAddress(ctx), String(values.assignment), artifact, contentB64);
    }
    case 'order-accept': {
      needWallet(ctx);
      if (!values.assignment) throw usage('--assignment обязателен');
      return await c.acceptOrder(needAddress(ctx), String(values.assignment), String(values.verdict || 'accepted'));
    }
    case 'events':
      return await c.getEvents({
        cursor: String(values.cursor || '0'),
        limit: Number(values.limit || 20),
        requester: values.requester ? String(values.requester) : needAddress(ctx),
      });
    case 'monitor-create': {
      needWallet(ctx);
      return await c.createMonitor(needAddress(ctx), readJsonArg(values.monitor, '--monitor'));
    }
    case 'monitor-tick':
      if (!values.monitor) throw usage('--monitor обязателен');
      return await c.tickMonitor(String(values.monitor), values.now ? Number(values.now) : undefined);
    case 'monitor-history': {
      if (!values.monitor) throw usage('--monitor обязателен');
      return await c.monitorHistory(String(values.monitor), values.requester ? String(values.requester) : needAddress(ctx));
    }
    case 'monitor-pause': {
      needWallet(ctx);
      if (!values.monitor) throw usage('--monitor обязателен');
      return await c.pauseMonitor(needAddress(ctx), String(values.monitor), Boolean(values.paused));
    }
    case 'monitor-cancel': {
      needWallet(ctx);
      if (!values.monitor) throw usage('--monitor обязателен');
      return await c.cancelMonitor(needAddress(ctx), String(values.monitor));
    }
    case 'faucet': {
      needWallet(ctx);
      if (!values.amount) throw usage('--amount (целые атомарные единицы) обязателен');
      return await c.faucet(needAddress(ctx), Number(values.amount));
    }
    case 'settlement': {
      if (!values.assignment) throw usage('--assignment обязателен');
      return await c.getSettlement(String(values.assignment), values.requester ? String(values.requester) : needAddress(ctx));
    }
    case 'settlement-create':
    case 'settlement-send':
    case 'settlement-confirm':
    case 'settlement-cancel': {
      needWallet(ctx);
      if (!values.assignment) throw usage('--assignment обязателен');
      const id = String(values.assignment);
      const a = needAddress(ctx);
      if (command === 'settlement-create') return await c.createSettlement(a, id);
      if (command === 'settlement-send') return await c.sendSettlement(a, id);
      if (command === 'settlement-confirm') return await c.confirmSettlement(a, id);
      return await c.cancelSettlement(a, id);
    }
    case 'settlement-dispute':
      needWallet(ctx);
      if (!values.assignment) throw usage('--assignment обязателен');
      return await c.disputeSettlement(needAddress(ctx), String(values.assignment), String(values.reason || ''));
    case 'complain': {
      needWallet(ctx);
      if (!values['target-type'] || !values['target-id']) throw usage('--target-type и --target-id обязательны');
      return await c.complain(needAddress(ctx), String(values['target-type']), String(values['target-id']), String(values.reason || ''));
    }
    case 'moderation-decide': {
      needWallet(ctx);
      if (!values.complaint || !values.decision) throw usage('--complaint и --decision обязательны');
      return await c.decide(needAddress(ctx), String(values.complaint), String(values.decision), String(values.reason || ''));
    }
    case 'moderation-history':
      return await c.modHistory(needAddress(ctx));
    case 'ops-metrics':
      return await c.opsMetrics();
    case 'queue-join': {
      needWallet(ctx);
      return await c.join(needAddress(ctx), String(values.handle || ''));
    }
    case 'queue-claim': {
      needWallet(ctx);
      return await c.claim(needAddress(ctx));
    }
    case 'queue-submit': {
      needWallet(ctx);
      if (!values.job) throw usage('--job обязателен');
      return await c.submit(needAddress(ctx), String(values.job), String(values.summary || ''));
    }
    default:
      throw usage(`unknown command: ${command}`);
  }
}

const OPTIONS = {
  node: { type: 'string' }, address: { type: 'string' }, wallet: { type: 'string' },
  journal: { type: 'string' }, pretty: { type: 'boolean' },
  skill: { type: 'string' }, 'max-price': { type: 'string' }, format: { type: 'string' },
  offer: { type: 'string' }, 'offer-id': { type: 'string' }, 'offer-version': { type: 'string' },
  input: { type: 'string' }, idempotency: { type: 'string' }, assignment: { type: 'string' },
  requester: { type: 'string' }, artifact: { type: 'string' }, content: { type: 'string' },
  verdict: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'string' },
  monitor: { type: 'string' }, now: { type: 'string' }, paused: { type: 'boolean' },
  amount: { type: 'string' }, reason: { type: 'string' }, 'target-type': { type: 'string' },
  'target-id': { type: 'string' }, complaint: { type: 'string' }, decision: { type: 'string' },
  job: { type: 'string' }, summary: { type: 'string' }, handle: { type: 'string' },
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
};

function emit(obj, pretty) {
  process.stdout.write(JSON.stringify(obj, null, pretty ? 2 : 0) + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === 'help') {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    emit({ ok: false, error: 'bad_arguments', hint: e.message }, false);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (values.version) { emit({ ok: true, cli: VERSION }, false); return 0; }
  const command = positionals[0];
  if (!command) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  try {
    const out = await run(command, values, positionals.slice(1));
    emit(out, Boolean(values.pretty));
    // Отказ SDK (ok:false) и ответ с error (например not_found при чтении) — не успех.
    // Ненайденное не считается найденным, даже если HTTP-код был 404, а не 500.
    const refused = out && out.ok === false;
    const errored = out && typeof out === 'object' && typeof out.error === 'string' && out.ok !== true;
    return refused || errored ? 1 : 0;
  } catch (e) {
    if (e instanceof UsageError) {
      emit({ ok: false, error: 'bad_arguments', hint: e.message, mutating: MUTATING.has(command) }, false);
      return 2;
    }
    emit({ ok: false, error: 'cli_error', hint: String(e && e.message || e).slice(0, 300) }, false);
    return 1;
  }
}

main().then((code) => { process.exitCode = code; }, (e) => {
  process.stderr.write(String(e && e.stack || e) + '\n');
  process.exitCode = 1;
});
