#!/usr/bin/env node
// Agentcoin network monitor — oneshot-опрос для systemd-таймера.
// Проверяет: доступность нод, свежесть tip, расхождение высот, chainValid,
// число пиров и подсети (anti-eclipse), рост счётчика атак, свой диск,
// сроки TLS-сертификатов. Шлёт алерты в Telegram, без токена — log-only.
// Флаги: --once (один опрос, JSON в stdout), --self-test (тестовое сообщение в TG).
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import tls from 'node:tls';

const argv = new Set(process.argv.slice(2));
const ONCE = argv.has('--once');
const SELF_TEST = argv.has('--self-test');

const SELF = process.env.SELF_NAME || hostname();
const NODES = (process.env.NODES ||
  'https://node1.agentcoin.work,https://node2.agentcoin.work,https://node3.agentcoin.work')
  .split(',').map((s) => s.trim()).filter(Boolean);
const STATE_DIR = process.env.STATE_DIR || '/var/lib/agentcoin-net-monitor';
const STATE_FILE = `${STATE_DIR}/state.json`;
const ENV_FILE = process.env.TG_ENV_FILE || '/etc/agentcoin/notify.env';
const STALE_SEC = +(process.env.STALE_SEC || 300);
const LAG_BLOCKS = +(process.env.LAG_BLOCKS || 6);
const MIN_PEERS = +(process.env.MIN_PEERS || 2);
const DISK_PCT = +(process.env.DISK_PCT || 85);
const CERT_DAYS = +(process.env.CERT_DAYS || 21);
const FETCH_TIMEOUT = +(process.env.FETCH_TIMEOUT_MS || 15000);
const REMIND_HOURS = +(process.env.REMIND_HOURS || 6);
const DIGEST_HOUR_UTC = +(process.env.DIGEST_HOUR_UTC || 9);

const log = (...a) => console.log('[net-monitor]', ...a);

// --- конфиг Telegram: файлы KEY=VALUE (токен нигде не печатаем).
// Сначала свой /etc/agentcoin/notify.env, затем те же файлы, что читает TG-бот
// оператора (/root/.watchdog.env, /root/.bot.env): новый токен не нужен.
const ENV_CANDIDATES = (process.env.TG_ENV_FILE ||
  '/etc/agentcoin/notify.env:/root/.watchdog.env:/root/.bot.env').split(':');
function loadNotifyEnv() {
  const out = {};
  let src = '';
  for (const f of ENV_CANDIDATES) {
    try {
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#') || !t.includes('=')) continue;
        const i = t.indexOf('=');
        const k = t.slice(0, i).trim();
        if (!(k in out)) out[k] = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      }
      if (!src && out.TG_TOKEN) src = f;
    } catch { /* нет файла — пропускаем */ }
  }
  return { env: out, src };
}
const { env: notifyEnv, src: tgSrc } = loadNotifyEnv();
const TG_TOKEN = process.env.TG_TOKEN || notifyEnv.TG_TOKEN || '';
const TG_CHATS = (process.env.TG_CHAT_ID || notifyEnv.TG_CHAT_ID || notifyEnv.ADMIN_CHATS || '')
  .split(/\s+/).filter(Boolean);
const tgOn = Boolean(TG_TOKEN && TG_CHATS.length);

async function tgSend(text) {
  let allOk = true;
  for (const chat of TG_CHATS) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
      const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        log('TG send failed, http', r.status);
        allOk = false;
      }
    } catch (e) {
      log('TG send failed:', e.message);
      allOk = false;
    } finally {
      clearTimeout(to);
    }
  }
  return allOk;
}

// --- состояние (защита от флэппинга: алерт один раз + recovery + редкие напоминaния) ---
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { incidents: {}, prevAttacks: {}, lastDigestDate: '' };
  }
}
function saveState(s) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}

// --- проверки ---
async function fetchJson(url, path) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url + path, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, error: `http ${r.status}` };
    return { ok: true, data: await r.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(to);
  }
}

function certDaysLeft(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: FETCH_TIMEOUT }, () => {
      try {
        const c = s.getPeerCertificate();
        s.end();
        if (!c || !c.valid_to) return resolve(null);
        resolve((Date.parse(c.valid_to) - Date.now()) / 86400000);
      } catch {
        resolve(null);
      }
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => {
      s.destroy();
      resolve(null);
    });
  });
}

function diskUsePct() {
  try {
    const out = execSync('df -P / | tail -n 1', { encoding: 'utf8' });
    const m = out.match(/(\d+)%/);
    return m ? +m[1] : null;
  } catch {
    return null;
  }
}

const shortHash = (h) => (h ? String(h).slice(0, 8) : '?');

async function poll() {
  const state = loadState();
  const now = new Date();
  const results = [];
  for (const base of NODES) {
    const r = await fetchJson(base, '/life');
    results.push({ base, ...r });
  }
  const okLives = results.filter((r) => r.ok).map((r) => r.data);
  const maxH = okLives.length ? Math.max(...okLives.map((l) => l.blocks)) : 0;

  const active = new Map(); // key -> {level, text}
  const infos = [];

  for (const r of results) {
    const name = r.base.replace('https://', '');
    if (!r.ok) {
      active.set(`down:${r.base}`, { level: 'crit', text: `DOWN — ${r.base} недоступна: ${r.error}` });
      continue;
    }
    const l = r.data;
    if (l.chainValid === false || l.chainIssue) {
      active.set(`invalid:${r.base}`, {
        level: 'crit',
        text: `CHAIN INVALID — ${name}: chainValid=${l.chainValid} issue=${l.chainIssue}`,
      });
    }
    if (l.fresh === false || (typeof l.tipAgeSec === 'number' && l.tipAgeSec > STALE_SEC)) {
      active.set(`stale:${r.base}`, {
        level: 'crit',
        text: `STALE — ${name}: tip ${l.tipAgeSec}с назад, высота ${l.blocks} (tip ${shortHash(l.tipHash)}…)`,
      });
    }
    if (typeof l.blocks === 'number' && maxH - l.blocks > LAG_BLOCKS) {
      active.set(`lag:${r.base}`, {
        level: 'warn',
        text: `LAG — ${name}: высота ${l.blocks}, отстаёт от лидера на ${maxH - l.blocks} блоков`,
      });
    }
    const p = l.peers || {};
    if (typeof p.peer_count === 'number' && p.peer_count < MIN_PEERS) {
      active.set(`lonely:${r.base}`, {
        level: 'warn',
        text: `LONELY — ${name}: всего ${p.peer_count} пиров (in=${p.inbound ?? '?'} out=${p.outbound ?? '?'})`,
      });
    }
    if (p.subnetsOk === false) {
      active.set(`eclipse:${r.base}`, {
        level: 'warn',
        text: `ECLIPSE-RISK — ${name}: все пиры в одной подсети (${(p.subnets || []).join(',')})`,
      });
    }
    if (typeof p.peer_count === 'number' && typeof p.withIp === 'number' && p.withIp < p.peer_count) {
      active.set(`ipblind:${r.base}`, {
        level: 'warn',
        text: `IP-BLIND — ${name}: ${p.peer_count - p.withIp} пиров без реального IP (за NAT/Caddy?)`,
      });
    }
    const atk = l?.security?.attacks;
    if (typeof atk === 'number') {
      const prev = state.prevAttacks[r.base];
      if (typeof prev === 'number' && atk > prev) {
        infos.push(`ATTACKS+ — ${name}: счётчик атак ${prev} → ${atk}`);
      }
      state.prevAttacks[r.base] = atk;
    }
  }

  // свой диск
  const disk = diskUsePct();
  if (disk !== null && disk > DISK_PCT) {
    active.set(`disk:${SELF}`, { level: 'warn', text: `DISK — ${SELF}: раздел / занят на ${disk}%` });
  }

  // сроки сертификатов всех входов (проверяется удалённо через TLS)
  const certInfo = [];
  for (const base of NODES) {
    const host = base.replace('https://', '').split('/')[0];
    const days = await certDaysLeft(host);
    certInfo.push({ host, days });
    if (days !== null && days < CERT_DAYS) {
      active.set(`cert:${host}`, {
        level: 'warn',
        text: `CERT — ${host}: до истечения ${days.toFixed(1)} дн.`,
      });
    }
  }

  // кто рассылает: первый живой по порядку NODES; я — только если все старше меня мертвы
  const selfRank = NODES.findIndex((u) => {
    const m = u.match(/node(\d)/);
    return m && SELF.includes(`node${m[1]}`);
  });
  const myRank = selfRank === -1 ? 99 : selfRank;
  const higherDown = NODES.slice(0, myRank).every((u) => {
    const r = results.find((x) => x.base === u);
    return !r || !r.ok;
  });
  const alerter = higherDown;
  log(`self=${SELF} rank=${myRank} alerter=${alerter} tg=${tgOn ? `on (${tgSrc || 'env'})` : 'log-only'}`);

  const nowIso = now.toISOString();
  // force=true: recovery того инцидента, о котором кричал я сам — уходит даже если
  // рассыльщик уже снова старший (иначе all-clear теряется ровно в момент починки).
  const send = async (text, force = false) => {
    const head = text.split('\n')[0];
    if (tgOn && (alerter || force)) {
      const ok = await tgSend(`Agentcoin net-monitor [${SELF}]: ${text}`);
      log(ok ? 'TG sent ok:' : 'TG FAILED:', head);
    } else {
      log('LOG suppressed (not alerter or log-only):', head);
    }
  };

  // новые инциденты + напоминания
  for (const [key, inc] of active) {
    const prev = state.incidents[key];
    if (!prev) {
      state.incidents[key] = { since: nowIso, lastSent: nowIso, mine: true };
      await send(`${inc.level === 'crit' ? '🚨' : '⚠️'} ${inc.text}`);
    } else if (Date.now() - Date.parse(prev.lastSent) > REMIND_HOURS * 3600e3) {
      state.incidents[key].lastSent = nowIso;
      await send(`⏰ всё ещё активно (${since(prev.since)}): ${inc.text}`);
    }
  }
  // восстановления
  for (const key of Object.keys(state.incidents)) {
    if (!active.has(key)) {
      const wasMine = state.incidents[key].mine !== false;
      delete state.incidents[key];
      await send(`✅ восстановилось: ${key}`, wasMine);
    }
  }
  // разовые info
  for (const t of infos) await send(`ℹ️ ${t}`);

  // суточный дайджест в DIGEST_HOUR_UTC (только рассыльщик)
  const today = nowIso.slice(0, 10);
  const digestDue = now.getUTCHours() === DIGEST_HOUR_UTC && state.lastDigestDate !== today;
  let digest = null;
  if (digestDue) {
    const lines = results.map((r) => {
      if (!r.ok) return `${r.base.replace('https://', '')}: DOWN (${r.error})`;
      const l = r.data;
      const p = l.peers || {};
      return `${r.base.replace('https://', '')}: ${l.blocks} ${shortHash(l.tipHash)}… fresh=${l.fresh} peers=${p.peer_count} (in=${p.inbound ?? '?'})`;
    });
    const certs = certInfo.map((c) => `${c.host}=${c.days === null ? '?' : c.days.toFixed(0) + 'd'}`).join(' ');
    digest = `📊 суточный дайджест\n${lines.join('\n')}\n${SELF} disk /: ${disk === null ? '?' : disk + '%'} | certs: ${certs}\nинциденты: ${Object.keys(state.incidents).length || 'нет'}`;
    state.lastDigestDate = today;
    await send(digest);
  }

  saveState(state);
  return {
    self: SELF,
    alerter,
    tg: tgOn ? 'on' : 'log-only',
    nodes: results.map((r) => ({
      base: r.base,
      ok: r.ok,
      blocks: r.data?.blocks ?? null,
      tip: r.data ? shortHash(r.data.tipHash) : null,
      error: r.error || null,
    })),
    incidents: [...active.keys()],
    disk,
    certs: certInfo.map((c) => ({ host: c.host, days: c.days === null ? null : +c.days.toFixed(1) })),
    digestSent: digestDue,
  };
}

function since(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 60 ? `${m} мин.` : `${(m / 60).toFixed(1)} ч`;
}

if (SELF_TEST) {
  if (!tgOn) {
    console.log('log-only: нет TG_TOKEN/TG_CHAT_ID, отправлять нечего');
    process.exit(0);
  }
  const ok = await tgSend(`Agentcoin net-monitor [${SELF}]: ✅ self-test, доставка работает`);
  console.log(ok ? 'self-test отправлен' : 'self-test НЕ отправлен');
  process.exit(ok ? 0 : 1);
}

const summary = await poll();
if (ONCE) console.log(JSON.stringify(summary, null, 1));
