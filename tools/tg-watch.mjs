#!/usr/bin/env node
/* TG-WATCH — контроль общения ботов/агентов в Telegram.
 * Read-only к цепи (только публичные GET), пишет только лог data/tg-watch.jsonl
 * и алерты в заданный чат. Ключей не хранит, денег не трогает.
 *
 * Env: TG_BOT_TOKEN (только из файла/секретов, НЕ из чата и НЕ из репо),
 *      TG_WATCH_CHAT (id группы, можно с -), TG_ALERT_CHAT (куда слать алерты),
 *      AGT_PUBLIC (default https://agentcoin.work), TG_POLL_MS (default 5000).
 *
 * Команды в группе: !help !link AGT... !trust AGT... !auctions !queue
 * Правила: смена адреса без !link → предупреждение; заявления о выплатах
 * без ончейн-подтверждения → пометка unverified; флуд >5/30с → notice.
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.TG_BOT_TOKEN || '';
const WATCH = process.env.TG_WATCH_CHAT || '';
const ALERT = process.env.TG_ALERT_CHAT || WATCH;
const BASE = process.env.AGT_PUBLIC || 'https://agentcoin.work';
const POLL = Number(process.env.TG_POLL_MS || 5000);
const LOG = path.join(__dirname, '..', 'data', 'tg-watch.jsonl');
const LINKS = path.join(__dirname, '..', 'data', 'tg-links.json');

if (!TOKEN) { console.error('TG_BOT_TOKEN missing — token only via env/secret file, never chat/repo'); process.exit(2); }
if (!WATCH) { console.error('TG_WATCH_CHAT missing'); process.exit(2); }

const api = (m, body) => fetch('https://api.telegram.org/bot' + TOKEN + '/' + m,
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(r => r.json());
const jget = (p) => fetch(BASE + p).then(r => { if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); });
const log = (o) => { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, JSON.stringify({ ts: Date.now(), ...o }) + '\n'); } catch {} };
const links = (() => { try { return JSON.parse(fs.readFileSync(LINKS, 'utf8')); } catch { return {}; } })();
const saveLinks = () => { try { fs.writeFileSync(LINKS, JSON.stringify(links, null, 1)); } catch {} };
const flood = new Map(); // userId -> [timestamps]

async function send(chat, text) {
  try { await api('sendMessage', { chat_id: chat, text: String(text).slice(0, 3800) }); }
  catch (e) { log({ ev: 'send_fail', err: String(e && e.message || e).slice(0, 120) }); }
}
const say = (t) => send(WATCH, t);
const alert = (t) => send(ALERT, t);

function extractAddrs(text) { return (String(text || '').match(/AGT[0-9a-fA-F]{40}/g) || []); }

async function checkPayoutClaim(addr, text) {
  // заявляет выплату? ищем подтверждение в истории очереди/эскроу
  if (!/выплат|paid|payout|получил/i.test(text || '')) return null;
  try {
    const qh = await jget('/queue/history');
    const hit = (qh.history || []).find(h => h.agent === addr);
    if (hit) return 'подтверждена ончейн: job ' + hit.jobId;
    const js = await jget('/api/v1/jobs/state');
    return 'НЕ подтверждена в публичной истории (paid=' + (js.stats?.paid ?? '?') + ') — unverified';
  } catch { return 'не проверено (API недоступно)'; }
}

async function onMsg(m) {
  const from = m.from || {};
  const uid = String(from.id || '?');
  const name = from.username ? '@' + from.username : (from.first_name || uid);
  const text = m.text || m.caption || '';
  const chatId = String(m.chat && m.chat.id);
  log({ ev: 'msg', chat: chatId, user: uid, name, text: String(text).slice(0, 500) });
  if (chatId !== String(WATCH)) return; // слушаем только целевую группу

  // флуд-контроль
  const now = Date.now();
  const arr = (flood.get(uid) || []).filter(t => now - t < 30000);
  arr.push(now); flood.set(uid, arr);
  if (arr.length === 6) { say('⏱ ' + name + ': флуд-контроль — пауза 30 сек, дальше читаю молча.'); return; }
  if (arr.length > 6) return;

  // команды
  if (text.startsWith('!help')) {
    say('🤖 TG-WATCH: !link AGT… (привязать кошелёк) · !trust AGT… (репутация ончейн) · !auctions (открытые торги) · !queue (очередь) · Я только наблюдаю и проверяю по цепи, денег не трогаю.');
    return;
  }
  if (text.startsWith('!link')) {
    const a = extractAddrs(text)[0];
    if (!a) { say(name + ': пришли адрес вида AGT… (40 hex).'); return; }
    links[uid] = { addr: a, name, at: now };
    saveLinks(); log({ ev: 'link', user: uid, addr: a });
    say('🔗 ' + name + ' ↔ <code>' + a.slice(0, 14) + '…</code> привязан. Смена адреса без !link = предупреждение.');
    return;
  }
  if (text.startsWith('!trust')) {
    const a = extractAddrs(text)[0] || (links[uid] && links[uid].addr);
    if (!a) { say(name + ': чей адрес проверить? !trust AGT…'); return; }
    try {
      const t = await jget('/api/v1/trust?address=' + a);
      say('🛡 ' + a.slice(0, 14) + '…: ' + JSON.stringify(t).slice(0, 300));
    } catch { say('🛡 проверка недоступна прямо сейчас.'); }
    return;
  }
  if (text.startsWith('!auctions')) {
    try {
      const d = await jget('/api/v1/jobs/auction/list');
      const open = (d.auctions || []).filter(x => x.status === 'commit');
      say('⚔ Открыто аукционов: ' + open.length + '. Брифы: https://agentcoin.work/auctions.html');
    } catch { say('⚔ доска временно недоступна.'); }
    return;
  }
  if (text.startsWith('!queue')) {
    try {
      const d = await jget('/api/v1/queue/status');
      say('🧾 Очередь: ждут ' + d.waiting + ', на задаче ' + d.onDuty + '. Вход: https://agentcoin.work/tasks.html');
    } catch { say('🧾 очередь временно недоступна.'); }
    return;
  }

  // правило: чужой адрес без привязки
  const addrs = extractAddrs(text);
  const mine = links[uid] && links[uid].addr;
  for (const a of addrs) {
    if (mine && a !== mine) {
      alert('⚠️ ' + name + ' постит чужой адрес ' + a.slice(0, 14) + '… (привязан ' + mine.slice(0, 14) + '…). Возможна подмена получателя — проверяйте перед отправкой.');
      log({ ev: 'addr_swap', user: uid, posted: a, linked: mine });
    }
  }
  // правило: заявления о выплатах
  if (/выплат|paid|payout|получил/i.test(text)) {
    const a = addrs[0] || mine;
    if (a) {
      const verdict = await checkPayoutClaim(a, text);
      log({ ev: 'payout_claim', user: uid, addr: a, verdict });
      if (verdict && verdict.startsWith('НЕ подтверждена')) {
        say('🔎 ' + name + ': заявление о выплате ' + verdict + '. Пруфы: https://agentcoin.work/hires-proof.html');
      }
    }
  }
}

let offset = 0;
console.log('tg-watch live: chat ' + WATCH + ', poll ' + POLL + 'ms');
for (;;) {
  try {
    const u = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
    for (const x of (u.result || [])) {
      offset = x.update_id + 1;
      if (x.message) await onMsg(x.message).catch(e => log({ ev: 'msg_err', err: String(e).slice(0, 120) }));
    }
  } catch (e) {
    log({ ev: 'poll_err', err: String(e && e.message || e).slice(0, 120) });
    await new Promise(r => setTimeout(r, 5000));
  }
}
