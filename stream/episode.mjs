#!/usr/bin/env node
/* ============================================================
   episode.mjs — пульт эпизода: эскроу → выплата → карточка.

   Найм агента на смену стрима = обычный эскроу сети Agentcoin.
   Платим не за «активность», а за принятую работу, и оставляем
   след, который можно проверить без доверия к нам:

     node stream/episode.mjs roster
     node stream/episode.mjs hire --agent Летописец --task "..." [--amount 0.2] [--dry-run]
     node stream/episode.mjs pay  --escrow <escId> [--dry-run]
     node stream/episode.mjs status --escrow <escId>
     node stream/episode.mjs card --escrow <escId> [--title "..."] [--api https://node1…]

   Запись (hire/pay) идёт только на локальную ноду: /escrow/create,
   /claim и /payout подписывают ключами из data-каталога ноды —
   скрипт их не читает, не печатает и никуда не отправляет.
   Карточка (card) — только чтение, работает против любой ноды.
   ============================================================ */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { computeBlockHash, hashMeetsDifficulty } from '../core.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EPISODES_DIR = path.join(__dirname, 'episodes');
const CREW_FILE = path.join(__dirname, 'crew.json');

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, def = null) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const has = (name) => argv.includes('--' + name);

const API = String(arg('api', process.env.AGT_API || 'http://127.0.0.1:9335')).replace(/\/+$/, '');
const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(API);
const PUBLIC_NODE = 'https://node1.agentcoin.work';

const die = (msg) => { const e = new Error(msg); e.userFacing = true; throw e; };
const short = (s, n = 16) => (s ? String(s).slice(0, n) + '…' : '—');
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
// ровно как core.mjs sha256d: второй хеш считается по СЫРОМУ дайджесту, не по hex
const sha256d = (text) => {
  const h1 = crypto.createHash('sha256').update(text, 'utf8').digest();
  return crypto.createHash('sha256').update(h1).digest('hex');
};

async function api(method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

function readCrew() {
  try { return JSON.parse(fs.readFileSync(CREW_FILE, 'utf8')); } catch { return { agents: [] }; }
}

function episodePath(escId) { return path.join(EPISODES_DIR, escId + '.json'); }
function loadEpisode(escId) {
  try { return JSON.parse(fs.readFileSync(episodePath(escId), 'utf8')); } catch { return null; }
}
function saveEpisode(escId, data) {
  fs.mkdirSync(EPISODES_DIR, { recursive: true });
  const file = episodePath(escId);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

async function escrowById(escId) {
  const { status, data } = await api('GET', '/escrow/state');
  if (status !== 200) die(`нода не отдала /escrow/state: ${status} ${JSON.stringify(data).slice(0, 200)}`);
  const list = Array.isArray(data.escrows) ? data.escrows : [];
  const found = list.find(e => e.escId === escId);
  if (!found) die(`эскроу ${escId} не найден в цепи`);
  return found;
}

// ── пруф Меркла: пересчитываем ветку и хеш блока у себя ────────────
async function proofFor(txid) {
  const { status, data } = await api('GET', `/txproof/${txid}`);
  if (status !== 200) return { txid, error: data.error || 'txproof_' + status };
  let cur = data.txid;
  for (const b of data.merkleBranch || []) {
    cur = b.side === 'right' ? sha256d(cur + b.hash) : sha256d(b.hash + cur);
  }
  const blockHash = computeBlockHash(data.header);
  return {
    txid: data.txid,
    height: data.height,
    blockHash: data.blockHash,
    txIndex: data.txIndex,
    branch: (data.merkleBranch || []).length,
    merkleRoot: data.header.merkleRoot,
    merkleOk: cur === data.header.merkleRoot,
    blockHashOk: blockHash === data.blockHash,
    powOk: hashMeetsDifficulty(blockHash, data.header.difficultyBits),
    checkedAt: new Date().toISOString(),
  };
}

function assertLocalWrite() {
  if (!IS_LOCAL && !has('allow-remote')) {
    die(`запись разрешена только на локальной ноде (сейчас ${API}).\n  Открой SSH-туннель к ноде или передай --allow-remote, если это действительно она.`);
  }
}

// ── команды ───────────────────────────────────────────────────────
function cmdRoster() {
  const crew = readCrew();
  console.log(`Агенты (${crew.agents.length}) — смена = эскроу, оплата за принятую работу:`);
  for (const a of crew.agents) {
    const addr = a.address ? short(a.address, 18) : 'адрес не задан';
    console.log(`  ${a.name.padEnd(11)} ${String(a.role).padEnd(32)} ${String(a.rate).padStart(4)} AGT/смена  ${addr}`);
  }
  console.log(`\nНайм: node stream/episode.mjs hire --agent "${crew.agents[0]?.name || 'Имя'}" --task "..."`);
}

async function cmdHire() {
  assertLocalWrite();
  const crew = readCrew();
  const who = arg('agent');
  if (!who) die('укажи --agent <имя из crew.json> или AGT-адрес');
  const agent = crew.agents.find(a => a.name.toLowerCase() === String(who).toLowerCase());
  const worker = agent ? agent.address : (/^AGT[0-9a-f]{40}$/i.test(who) ? who : '');
  if (!worker) die(`у агента «${who}» нет адреса в crew.json — впиши его кошелёк, иначе платить некуда`);
  const task = arg('task');
  if (!task) die('укажи --task "что именно делает агент на смене"');
  const amount = Number(arg('amount', agent?.rate ?? 0.2));
  if (!(amount > 0)) die('сумма должна быть больше нуля');
  const employer = arg('employer', crew.employer);
  if (!employer) die('нет работодателя: --employer AGT… или "employer" в crew.json');
  const deadlineSec = Number(arg('deadline', 3600));
  const taskHash = sha256(task);
  const body = { employer, worker, amount, taskHash, deadlineSec };

  if (has('dry-run')) {
    console.log('POST ' + API + '/escrow/create');
    console.log(JSON.stringify(body, null, 2));
    console.log('taskHash = sha256(text задачи), мемо escrow:<id>:<taskHash>:<deadline>:<worker>');
    return;
  }
  if (String(employer).toLowerCase() === String(crew.employer).toLowerCase()) {
    console.log('⚠ работодатель — казна 2-of-3: /escrow/create подпишет одной подписью, транзакции нужна вторая (sig2).');
    console.log('  Для эфира проще отдельный кошелёк-работодатель одной подписью (--employer AGT…).');
  }
  const { status, data } = await api('POST', '/escrow/create', body);
  if (status !== 201) die(`escrow/create: ${status} ${JSON.stringify(data).slice(0, 300)}`);
  const now = new Date().toISOString();
  const file = saveEpisode(data.escId, {
    escId: data.escId,
    title: arg('title', 'Смена: ' + (agent?.name || short(worker, 12))),
    agent: agent ? { name: agent.name, role: agent.role } : { name: short(worker, 12), role: 'агент' },
    employer, worker, amount,
    task, taskHash,
    escrowAddress: data.escAddress,
    openedTxid: null, openedTxidShort: data.txid,
    paidTxid: null,
    status: 'open',
    createdAt: now,
    api: API,
  });
  console.log(`✔ эскроу открыт: ${data.escId}`);
  console.log(`  tx открытия ${short(data.txid)} в мемпуле — попадёт в блок в течение ~30 c`);
  console.log(`  черновик карточки: ${path.relative(process.cwd(), file)}`);
  console.log(`  дальше: node stream/episode.mjs status --escrow ${data.escId}`);
}

async function cmdPay() {
  assertLocalWrite();
  const escId = arg('escrow');
  if (!escId) die('укажи --escrow <escId>');
  const e = await escrowById(escId);
  if (e.status === 'paid') die(`эскроу ${escId} уже выплачен (${short(e.paidTxid)})`);
  if (!e.openedTxid) die('транзакция открытия ещё не в блоке — подожди майнинга');

  const claimBody = { escId, taskHash: e.taskHash, workerAddress: e.worker };
  if (has('dry-run')) {
    console.log('POST /escrow/claim  ' + JSON.stringify(claimBody));
    console.log('POST /escrow/payout  ' + JSON.stringify({ escId, employerAddress: e.employer, workerReceiptSig: '<из claim>', workerPub: '<из claim>' }));
    return;
  }
  const claim = await api('POST', '/escrow/claim', claimBody);
  if (claim.status !== 200) die(`claim: ${claim.status} ${JSON.stringify(claim.data).slice(0, 300)}`);
  const payout = await api('POST', '/escrow/payout', {
    escId,
    employerAddress: e.employer,
    workerReceiptSig: claim.data.receiptSig,
    workerPub: claim.data.workerPub,
  });
  if (payout.status !== 201) die(`payout: ${payout.status} ${JSON.stringify(payout.data).slice(0, 300)}`);

  const ep = loadEpisode(escId) || { escId };
  ep.status = 'payout_submitted';
  ep.paidTxidShort = payout.data.txid;
  ep.payoutAt = new Date().toISOString();
  ep.fee = payout.data.fee || null;
  saveEpisode(escId, ep);

  console.log(`✔ выплата поставлена в мемпул: ${short(payout.data.txid)}`);
  if (payout.data.fee) console.log(`  комиссия: ${JSON.stringify(payout.data.fee).slice(0, 160)}`);
  console.log(`  после блока: node stream/episode.mjs card --escrow ${escId}`);
}

async function cmdStatus() {
  const escId = arg('escrow');
  if (!escId) die('укажи --escrow <escId>');
  const e = await escrowById(escId);
  const ep = loadEpisode(escId);
  console.log(`эскроу ${escId} · ${e.openedAmount} AGT · статус ${e.status}`);
  console.log(`  работодатель ${e.employer}`);
  console.log(`  агент        ${e.worker}`);
  console.log(`  открытие     ${e.openedTxid || '(в мемпуле)'}`);
  console.log(`  выплата      ${e.paidTxid || '—'}`);
  console.log(`  черновик     ${ep ? 'есть' : 'нет'}`);
}

async function cmdCard() {
  const escId = arg('escrow');
  if (!escId) die('укажи --escrow <escId>');
  const e = await escrowById(escId);
  const ep = loadEpisode(escId) || { escId };
  const title = arg('title', ep.title || 'Эпизод ' + escId.slice(0, 8));

  const opened = e.openedTxid ? await proofFor(e.openedTxid) : null;
  const paid = e.paidTxid ? await proofFor(e.paidTxid) : null;
  const allOk = [opened, paid].filter(Boolean).every(p => p.merkleOk && p.blockHashOk && p.powOk);

  const card = {
    escId,
    title,
    agent: ep.agent || { name: short(e.worker, 12), role: 'агент' },
    amount: e.openedAmount,
    paidOut: e.paidOut,
    status: e.status,
    task: ep.task || null,
    taskHash: e.taskHash,
    employer: e.employer,
    worker: e.worker,
    escrowAddress: ep.escrowAddress || null,
    opened,
    paid,
    verified: allOk,
    network: API,
    createdAt: ep.createdAt || null,
    cardedAt: new Date().toISOString(),
  };

  fs.mkdirSync(EPISODES_DIR, { recursive: true });
  const jsonFile = path.join(EPISODES_DIR, escId + '.json');
  fs.writeFileSync(jsonFile, JSON.stringify(card, null, 2));

  const line = (label, p) => p && !p.error
    ? `| ${label} | \`${p.txid}\` | ${p.height} | ${p.merkleOk ? '✅' : '❌'} | ${p.blockHashOk ? '✅' : '❌'} | ${p.powOk ? '✅' : '❌'} |`
    : `| ${label} | — | — | — | — | — |`;
  const md = `# ${title}

Эскроу \`${escId}\` · **${e.openedAmount} AGT** · статус **${e.status}**
Агент: ${card.agent.name}${card.agent.role ? ' (' + card.agent.role + ')' : ''} · \`${e.worker}\`
${card.task ? 'Задача: ' + card.task + '\n' : ''}
| шаг | txid | блок | merkle | block hash | PoW |
|---|---|---|---|---|---|
${line('открытие', opened)}
${line('выплата', paid)}

Проверено локально: ${allOk ? '**все пруфы сходятся**' : '**есть непроверенные шаги**'}.

Проверить самому: \`${PUBLIC_NODE}/txproof/<txid>\` — вернуть \`merkleRoot\` из ветки и сверить с \`header.merkleRoot\`.

Сеть: ${API} · карточка создана ${card.cardedAt}
`;
  const mdFile = path.join(EPISODES_DIR, escId + '.md');
  fs.writeFileSync(mdFile, md);

  console.log(`${allOk ? '✅' : '⚠️'} карточка: ${path.relative(process.cwd(), mdFile)}`);
  if (opened) console.log(`  открытие  ${short(opened.txid)} блок ${opened.height} merkle ${opened.merkleOk ? '✅' : '❌'} pow ${opened.powOk ? '✅' : '❌'}`);
  if (paid) console.log(`  выплата   ${short(paid.txid)} блок ${paid.height} merkle ${paid.merkleOk ? '✅' : '❌'} pow ${paid.powOk ? '✅' : '❌'}`);
  if (!paid) console.log('  выплаты ещё нет в цепи — карточка помечена как незавершённая');
}

function usage() {
  console.log(`episode.mjs — эскроу, выплата и карточка эпизода

  roster                                   кто в труппе и по какой ставке
  hire --agent <имя|AGT…> --task "…"       открыть эскроу на смену агента
       [--amount 0.3] [--deadline 3600] [--employer AGT…] [--dry-run]
  pay --escrow <escId> [--dry-run]          квитанция агента + выплата
  status --escrow <escId>                   состояние эскроу
  card --escrow <escId> [--title "…"]       карточка с txid и merkle-пруфом

  Нода: --api http://127.0.0.1:9335 (по умолчанию) или AGT_API.
  Запись — только на локальной ноде; card работает против любой.`);
}

const commands = { roster: cmdRoster, hire: cmdHire, pay: cmdPay, status: cmdStatus, card: cmdCard };
if (!cmd || cmd === 'help' || cmd === '--help' || has('help')) { usage(); process.exit(0); }
const fn = commands[cmd];
try {
  if (!fn) die(`неизвестная команда «${cmd}». help — список`);
  await fn();
} catch (e) {
  console.error('✖ ' + (e.userFacing ? e.message : (e?.stack || e?.message || e)));
  process.exitCode = 1; // без process.exit: не рвём соединение посреди fetch
}
