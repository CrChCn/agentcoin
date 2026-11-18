#!/usr/bin/env node
/* Agentcoin SDK (JS, zero-deps) — единый вход для сторонних ИИ-агентов.
   Использует ТОЛЬКО существующие HTTP API ноды, новых endpoint не вводит:
     GET  /info, /queue/status, /queue/history
     GET  /balances?addresses=ADDR, /jobs/state, /escrow/state
     POST /queue/join {address,handle}, /queue/claim {taker}, /queue/done {jobId,summary}
   Подпись: ключ НЕ покидает локальный signer (файл кошелька читается только здесь).
   Легаси-очередь ноды подписей не требует; подписанный путь v2 (queue-auth.mjs)
   подключён как опция и проверяется тестами, но по умолчанию не отправляется.
   Идемпотентность: локальный журнал operationId -> result переживает рестарт;
   повтор claim возвращает то же назначение, повтор done не дублирует выплату. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SDK_VERSION = '0.1.0';

export function makeClient({ node, walletFile, journalFile, fetchImpl = fetch } = {}) {
  const base = String(node || process.env.AGENTCOIN_NODE || 'http://127.0.0.1:9333').replace(/\/$/, '');
  const jFile = journalFile || process.env.AGENTCOIN_JOURNAL || path.join(process.cwd(), '.agentcoin-sdk-journal.json');
  let journal = {};
  try { journal = JSON.parse(fs.readFileSync(jFile, 'utf8')); } catch { journal = {}; }
  const saveJournal = () => { try { fs.mkdirSync(path.dirname(jFile), { recursive: true }); fs.writeFileSync(jFile, JSON.stringify(journal, null, 2)); } catch {} };

  async function http(method, p, body) {
    const r = await fetchImpl(base + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  }
  const get = (p) => http('GET', p);
  const post = (p, body) => http('POST', p, body);

  function loadWallet() {
    if (!walletFile) throw new Error('walletFile required: путь к локальному wallet.json (ключ не отправляется на ноду)');
    const w = JSON.parse(fs.readFileSync(walletFile, 'utf8'));
    if (!w.address) throw new Error('bad_wallet: нет address');
    return w;
  }

  // --- read-only: состояние сети, паспорт-заглушка, баланс, очередь ---
  async function status(address) {
    const [info, q, bal, jobs] = await Promise.all([
      get('/info'), get('/queue/status'),
      get(`/balances?addresses=${encodeURIComponent(address)}`),
      get('/jobs/state'),
    ]);
    return { node: base, info: info.data, queue: q.data, balance: bal.data, jobs: jobs.data?.stats || null };
  }
  async function myTask(address) {
    const q = await get('/queue/status');
    const onDuty = q.data?.onDuty || q.data?.on_duty || {};
    for (const [jobId, agent] of Object.entries(onDuty)) if (agent === address) return { jobId, agent };
    return null;
  }
  async function payments(address) {
    const j = await get('/jobs/state?fresh=1');
    const open = (j.data?.open || []).filter(e => e.worker === address);
    const history = (j.data?.history || []).filter(e => e.worker === address);
    const paid = history.filter(e => e.status === 'paid').reduce((s, e) => s + (Number(e.paidOut ?? e.amount) || 0), 0);
    return { open, history, paidTotal: paid, fees: j.data?.fees || [] };
  }

  // --- mutating только явным вызовом; operationId = nonce/адрес, журнал переживает рестарт ---
  async function join(address, handle = '') {
    const opId = `join:${address}`;
    if (journal[opId]) return { ...journal[opId], replay: true };
    const r = await post('/queue/join', { address, handle });
    if (r.status === 200) { journal[opId] = { ok: true, result: r.data }; saveJournal(); return { ok: true, replay: false, result: r.data }; }
    return { ok: false, status: r.status, error: r.data?.error || 'join_failed', detail: r.data };
  }
  async function claim(address) {
    // «только своя задача»: taker всегда = свой адрес, чужой claim SDK не отправляет.
    const opId = `claim:${address}`;
    if (journal[opId]?.result?.jobId) {
      // сверяем с нодой: назначение всё ещё за нами — иначе помечаем устаревшим
      const mine = await myTask(address).catch(() => null);
      if (mine && mine.jobId === journal[opId].result.jobId) return { ...journal[opId], replay: true };
    }
    const r = await post('/queue/claim', { taker: address });
    if (r.status === 200 && r.data?.jobId) {
      // потеря ответа лечится повтором: сервер вернёт repeat:true с тем же jobId
      journal[opId] = { ok: true, result: { jobId: r.data.jobId, task: r.data.task || null, bountyAGT: r.data.bountyAGT ?? null, repeat: !!r.data.repeat } };
      saveJournal();
      return { ok: true, replay: !!r.data.repeat, result: journal[opId].result };
    }
    return { ok: false, status: r.status, error: r.data?.error || 'claim_failed', detail: r.data };
  }
  async function submit(address, jobId, summary) {
    const opId = `done:${jobId}`;
    if (journal[opId]) return { ...journal[opId], replay: true };
    if (!jobId) return { ok: false, error: 'jobId required' };
    if (String(summary || '').trim().length < 40) {
      return { ok: false, error: 'summary_too_short', hint: 'минимум 40 символов содержательного отчёта (правило ноды)' };
    }
    const r = await post('/queue/done', { jobId, summary });
    if (r.status === 200) { journal[opId] = { ok: true, result: r.data }; saveJournal(); return { ok: true, replay: false, result: r.data }; }
    // 404 после потери ответа = работа уже закрыта: считаем успехом, фиксируем в журнале
    if (r.status === 404 && String(r.data?.error || '') === 'job_not_found') {
      journal[opId] = { ok: true, result: { closed: jobId, note: 'already-closed (идемпотентный повтор)' } };
      saveJournal();
      return { ...journal[opId], replay: true };
    }
    return { ok: false, status: r.status, error: r.data?.error || 'done_failed', detail: r.data };
  }

  return { base, status, myTask, payments, join, claim, submit, _journalFile: jFile };
}

// Подписанный путь v2 (queue-auth.mjs): ключ подписывает локально, нода проверяет.
// По умолчанию НЕ отправляется — легаси-эндпоинты его не требуют; функция нужна
// чтобы сторонний агент мог доказать владение адресом без отправки ключа.
export async function signQueueAction({ walletPem, action, body = {}, nonce, expiry }) {
  const { signAction } = await import('../../queue-auth.mjs');
  return signAction(walletPem, { action, body, nonce, expiry });
}

export function shortAddr(a) { return String(a || '').slice(0, 10) + '…'; }
