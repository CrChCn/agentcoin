#!/usr/bin/env node
/* Операторские действия: STOP и resume. Запускается владельцем (root), а не
   сервисом, потому что только у него есть приватный ключ Ed25519.

     node service/operator.mjs init-key [--root DIR] [--key FILE] [--pub FILE]
     node service/operator.mjs stop   --root DIR [--reason TEXT]
     node service/operator.mjs resume --root DIR
     node service/operator.mjs verify --root DIR     # проверить журнал STOP/resume

   Сервис умеет только читать STOP и проверять подписи: state/operator.pub —
   публичный ключ, приватного ключа в дереве сервиса нет. */

import fs from 'node:fs';
import path from 'node:path';

import { defaultPrivateKeyPath, defaultPublicKeyPath, initOperatorKey, loadOperatorPrivateKey, signEntry } from '../lib/opsauth.mjs';
import { OpsStore } from './store.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { out._.push(token); continue; }
    const [key, inline] = token.slice(2).split('=');
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

const print = (value) => console.log(JSON.stringify(value, null, 2));
const rootOf = (opts) => path.resolve(opts.root || process.env.OPS_ROOT || '/var/lib/agentcoin-orchestrator');
const keyFileOf = (opts) => path.resolve(opts.key || defaultPrivateKeyPath());

/* На ops-host команда обязана идти от root. Флаг ниже — только для локальной
   репетиции в непривилегированном окружении (тесты/харнесс): он не даёт
   сервису приватного ключа, а просто позволяет прогонять сценарий без sudo. */
function requireOwner() {
  if (process.env.OPS_OPERATOR_ALLOW_UNPRIVILEGED === '1') return;
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    throw Object.assign(new Error('operator commands must run as root (the private key is root-only)'), { code: 'OPERATOR_REQUIRES_ROOT' });
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);
  const root = rootOf(opts);
  const store = new OpsStore(root);

  if (command === 'init-key') {
    requireOwner();
    const result = initOperatorKey({
      privateKeyPath: keyFileOf(opts),
      publicKeyPath: path.resolve(opts.pub || defaultPublicKeyPath(root)),
    });
    print(result);
    return 0;
  }

  if (command === 'stop') {
    requireOwner();
    const reason = String(opts.reason || 'operator stop');
    /* Ключ и подпись готовятся до записи STOP: иначе STOP без подписанного
       события (например, при отсутствующем ключе) останавливал бы сервис,
       хотя команда завершилась ошибкой. */
    const operator = loadOperatorPrivateKey(keyFileOf(opts));
    const signed = signEntry(store.nextEntry('service.stop_signed', null, { reason, by: 'operator' }), operator);
    fs.mkdirSync(path.dirname(store.paths.stopFile), { recursive: true });
    fs.writeFileSync(store.paths.stopFile, `${new Date().toISOString()} ${reason}\n`, { mode: 0o644 });
    const entry = store.commitEntry(signed);
    store.heartbeat({ state: 'stopping', reason: 'operator stop' });
    print({ stopFile: store.paths.stopFile, event: { seq: entry.seq, keyId: entry.keyId, alg: entry.alg } });
    return 0;
  }

  if (command === 'resume') {
    requireOwner();
    const operator = loadOperatorPrivateKey(keyFileOf(opts));
    if (!store.stopRequested()) {
      print({ stopRequested: false, note: 'nothing to resume; STOP is absent' });
      return 0;
    }
    fs.rmSync(store.paths.stopFile, { force: true });
    const entry = store.commitEntry(signEntry(store.nextEntry('service.resume_signed', null, { by: 'operator' }), operator));
    store.heartbeat({ state: 'running', reason: 'operator resume' });
    print({ stopRequested: store.stopRequested(), event: { seq: entry.seq, keyId: entry.keyId, alg: entry.alg } });
    return 0;
  }

  if (command === 'verify') {
    const journal = fs.existsSync(store.paths.queueJournal)
      ? fs.readFileSync(store.paths.queueJournal, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      : [];
    const signed = journal.filter((entry) => entry.event === 'service.stop_signed' || entry.event === 'service.resume_signed');
    const report = signed.map((entry) => ({ seq: entry.seq, event: entry.event, keyId: entry.keyId, alg: entry.alg, valid: store.verifySignature(entry) }));
    print({ signed: report.length, events: report, allValid: report.every((item) => item.valid) });
    return report.every((item) => item.valid) ? 0 : 2;
  }

  console.error('usage: operator.mjs <init-key|stop|resume|verify> [--root DIR] [--key FILE] [--reason TEXT]');
  return 64;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(`${err.code || 'ERROR'}: ${err.message}`);
  process.exitCode = err.code === 'OPERATOR_KEY_UNSAFE' || err.code === 'OPERATOR_KEY_MISSING' ? 78 : 1;
}
