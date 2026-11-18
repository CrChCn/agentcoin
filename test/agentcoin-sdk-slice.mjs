#!/usr/bin/env node
/* Приёмочный тест вертикального среза SDK→CLI→MCP (без mainnet, без консенсуса).
   Проверяет: потерю ответа (повтор claim/done), рестарт (журнал), чужую подпись. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert';
import { makeClient } from '../sdk/js/agentcoin-sdk.mjs';
import { signAction, verifyActionSig } from '../queue-auth.mjs';

let pass = 0, fail = 0;
const ok = (c, name) => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + name); };

// --- мок ноды: легаси /queue/* с repeat:true и 404 после done ---
function mockNode() {
  const st = { waiting: ['A'], onDuty: {}, done: new Set(), calls: 0, dropNext: false };
  const json = (status, data) => ({ status, json: async () => data });
  return { st, fetch: async (url, opt = {}) => {
    st.calls++;
    const p = new URL(url).pathname + (new URL(url).search || '');
    const body = opt.body ? JSON.parse(opt.body) : {};
    if (st.dropNext) { st.dropNext = false; throw new Error('response lost (симуляция обрыва)'); }
    if (opt.method === 'GET' && p.startsWith('/queue/status')) return json(200, { waiting: st.waiting, onDuty: st.onDuty });
    if (opt.method === 'POST' && p === '/queue/claim') {
      const held = Object.entries(st.onDuty).find(([, a]) => a === body.taker);
      if (held) return json(200, { ok: true, jobId: held[0], repeat: true });
      const t = st.waiting.shift(); const jobId = 'job-' + t;
      st.onDuty[jobId] = t; return json(200, { ok: true, jobId, task: 'demo-task', bountyAGT: 2 });
    }
    if (opt.method === 'POST' && p === '/queue/done') {
      if (st.done.has(body.jobId) || !st.onDuty[body.jobId]) return json(404, { error: 'job_not_found' });
      delete st.onDuty[body.jobId]; st.done.add(body.jobId);
      return json(200, { ok: true, closed: body.jobId });
    }
    return json(200, {});
  }};
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agtsdk-'));
const walletFile = path.join(tmp, 'wallet.json');
fs.writeFileSync(walletFile, JSON.stringify({ address: 'A' }));
const journalFile = path.join(tmp, 'journal.json');

// 1. claim + потеря ответа: повтор возвращает то же назначение
{
  const m = mockNode();
  const c = makeClient({ node: 'http://x', walletFile, journalFile, fetchImpl: m.fetch });
  const r1 = await c.claim('A');
  ok(r1.ok && r1.result.jobId === 'job-A', 'claim выдаёт задачу');
  m.st.dropNext = true; // следующий GET myTask внутри claim оборвётся? claim идёт POST — эмулируем повтор после потери
  const r2 = await c.claim('A'); // журнал + серверный repeat
  ok(r2.ok && r2.result.jobId === 'job-A' && r2.replay === true, 'повтор claim после потери — то же назначение (replay)');
}
// 2. рестарт: новый клиент читает журнал, эффект не дублируется
{
  const m = mockNode();
  const j2 = path.join(tmp, 'j2.json');
  const c1 = makeClient({ node: 'http://x', walletFile, journalFile: j2, fetchImpl: m.fetch });
  const d1 = await c1.submit('A', 'job-A', 'x'.repeat(40));
  // мок: job-A нет в onDuty (мы не claimили в этом моке) → 404 → идемпотентный успех
  ok(d1.ok === true, 'submit несуществующего после потери — идемпотентный успех, не ошибка');
  const calls = m.st.calls;
  const c2 = makeClient({ node: 'http://x', walletFile, journalFile: j2, fetchImpl: m.fetch });
  const d2 = await c2.submit('A', 'job-A', 'x'.repeat(40));
  ok(d2.replay === true && m.st.calls === calls, 'рестарт: повтор submit не идёт в сеть (журнал)');
}
// 3. чужая подпись отвергается verifyActionSig
{
  const victim = crypto.generateKeyPairSync('ed25519');
  const attacker = crypto.generateKeyPairSync('ed25519');
  const victimPem = victim.publicKey.export({ type: 'spki', format: 'pem' });
  const victimAddr = 'AGTvictim123';
  // подменяем addressFromPub через реальную проверку: подпись атакующего под адресом жертвы
  const { addressFromPub } = await import('../core.mjs');
  let victimReal = victimAddr;
  try { victimReal = addressFromPub(victimPem); } catch {}
  const s = signAction(attacker.privateKey.export({ type: 'pkcs8', format: 'pem' }), { action: 'claim', body: { taker: victimReal }, nonce: 'n1', expiry: Date.now() + 60000 });
  const v = verifyActionSig({ address: victimReal, fromPub: attacker.publicKey.export({ type: 'spki', format: 'pem' }), signature: s.signature, action: 'claim', body: { taker: victimReal }, nonce: 'n1', expiry: Date.now() + 60000 });
  ok(v.ok === false, 'чужая подпись отвергается (' + v.error + ')');
}
// 4. summary<40 SDK не отправляет (правило ноды)
{
  const m = mockNode(); const calls0 = m.st.calls;
  const c = makeClient({ node: 'http://x', walletFile, journalFile: path.join(tmp, 'j3.json'), fetchImpl: m.fetch });
  const r = await c.submit('A', 'job-1', 'коротко');
  ok(r.ok === false && r.error === 'summary_too_short' && m.st.calls === calls0, 'короткий summary блокируется локально, сети нет');
}
console.log(`\nитог: ${pass} PASS, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
