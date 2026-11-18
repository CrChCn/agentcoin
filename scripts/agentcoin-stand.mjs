#!/usr/bin/env node
/* Изолированный стенд среза: общие хендлеры stand-server + полный проход
   внешнего агента (status→join→claim→submit→payments, повтор после рестарта).
   Сохраняет обезличенный журнал в evidence/. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createStand } from '../sdk/js/stand-server.mjs';
import { addressFromPub } from '../core.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-stand-'));
const stand = await createStand(tmp);
const log = [];
const step = (name, obj) => { log.push({ step: name, result: obj }); console.log(`\n[${name}]:`); console.log(JSON.stringify(obj, null, 1).slice(0, 900)); };

// кошелёк стенда (только для этого прогона, в tmp)
const k = crypto.generateKeyPairSync('ed25519');
const pubPem = k.publicKey.export({ type: 'spki', format: 'pem' });
const addr = addressFromPub(pubPem);
const walletFile = path.join(tmp, 'wallet.json');
fs.writeFileSync(walletFile, JSON.stringify({ address: addr, public_key_pem: pubPem, privateKeyPem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
const { makeClient } = await import('../sdk/js/agentcoin-sdk.mjs');
const J = path.join(tmp, 'journal.json');
const c = makeClient({ node: stand.url, address: addr, walletFile, journalFile: J });

step('status-readonly', await c.status(addr));
step('join', await c.join(addr, 'stand-agent'));
const cl = await c.claim(addr); step('claim-own-task', cl);
step('claim-repeat', await c.claim(addr));
step('my_task', await c.myTask(addr));
if (cl.ok) {
  const summary = 'Стендовый отчёт: очередь и джобборд сошлись, повторы идемпотентны, чужой ключ отвергнут.';
  step('submit', await c.submit(addr, cl.result.jobId, summary));
  step('submit-repeat-after-response-loss', await c.submit(addr, cl.result.jobId, summary));
}
step('payments-stages', await c.payments(addr));
// рестарт: новый клиент тот же журнал — без нового эффекта
const c2 = makeClient({ node: stand.url, address: addr, walletFile, journalFile: J });
step('restart-claim-replay', await c2.claim(addr));

const evDir = path.join(process.cwd(), 'evidence');
fs.mkdirSync(evDir, { recursive: true });
const evFile = path.join(evDir, `agentcoin-sdk-pass-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const clean = JSON.parse(JSON.stringify(log, (kk, v) => /private|signature|pem|priv/i.test(kk) ? '[redacted]' : v));
fs.writeFileSync(evFile, JSON.stringify({ node: stand.url, genesis: stand.genesis, address: addr.slice(0, 10) + '…', log: clean }, null, 2));
console.log('\nжурнал: ' + evFile);
stand.close();
console.log('стенд: DONE');
