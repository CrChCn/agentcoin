'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '@/lib/i18n';
import { useApi, fmt, timeStr } from '@/lib/api';
import { normAddr } from '@/lib/addr';
import { Card, Stale } from '@/components/ui';

function Copy({ text }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      onClick={async () => { try { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); } catch (e) {} }}
      className="rounded-lg border border-[#2a3646] px-2 py-0.5 font-mono text-[11px] text-[#5aa2ff] hover:border-[#e8b923]"
      title="copy">
      {ok ? '✓' : '⧉'}
    </button>
  );
}

function short(a) {
  const s = String(a || '');
  if (s.length <= 20) return s;
  return s.slice(0, 12) + '…' + s.slice(-6);
}

function Gauge({ value, max }) {
  const frac = Math.max(0, Math.min(1, Number(value) / (max || 3)));
  const R = 54, C = 2 * Math.PI * R;
  const col = value == null ? '#5c6672' : Number(value) < 1 ? '#ef4444' : Number(value) < 1.5 ? '#ffd75e' : '#39d98a';
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 140 140" className="h-28 w-28 -rotate-90">
        <circle cx="70" cy="70" r={R} fill="none" stroke="#1a2230" strokeWidth="14" />
        <circle cx="70" cy="70" r={R} fill="none" stroke={col} strokeWidth="14" strokeLinecap="round"
          strokeDasharray={`${(frac * C).toFixed(1)} ${C.toFixed(1)}`} style={{ filter: `drop-shadow(0 0 8px ${col})` }} />
      </svg>
      <div>
        <div className="num text-3xl font-bold" style={{ color: col }}>
          {value != null && Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '—'}
        </div>
        <div className="text-xs text-[#8b93a1]">max ≈ {max}</div>
      </div>
    </div>
  );
}

function Spark({ points }) {
  const w = 220, h = 44;
  if (!points || points.length < 2) return <div className="font-mono text-[11px] text-[#5c6672]">—</div>;
  const min = Math.min(...points), max = Math.max(...points);
  const span = (max - min) || 1;
  const step = w / (points.length - 1);
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(h - 4 - ((v - min) / span) * (h - 10)).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  const col = last < 1 ? '#ef4444' : last < 1.5 ? '#ffd75e' : '#39d98a';
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-11 w-full">
      <path d={d} fill="none" stroke={col} strokeWidth="2" style={{ filter: `drop-shadow(0 0 4px ${col})` }} />
    </svg>
  );
}

const WDEF = { entropy: true, concentration: true, stall: true, banchange: true, stale: true };

function loadJson(k, fb) {
  try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : fb; } catch (e) { return fb; }
}

export default function Shield() {
  const { lang, t } = useLang();
  const RU = lang === 'ru';
  const sh = useApi('/api/v1/shield', 30000);
  const sec = useApi('/security/status', 30000);
  const atk = useApi('/security/attacks', 30000);
  const ban = useApi('/security/banlist', 60000);
  const info = useApi('/api/v1/info', 30000);
  const nodes3 = useApi('/api/v1/network/nodes', 30000);
  const nodeRows = nodes3.data?.nodes || [];
  const d = sh.data || {};
  const ent = d.miningEntropy;
  const mk = d.markov || {};
  const sv = d.svd || {};
  const an = Array.isArray(sv.anomalies) ? sv.anomalies : [];
  const miners = d.miner || d.miners || {};
  const entries = Object.entries(miners).sort((a, b) => b[1] - a[1]);
  const win = d.window || entries.reduce((s, [, c]) => s + Number(c || 0), 0) || 1;
  const top = d.topMiner || (entries[0] ? { address: entries[0][0], blocks: entries[0][1] } : null);
  const topShare = top ? Number(top.share ?? (Number(top.blocks || 0) / win)) : 0;
  const hhi = entries.reduce((s, [, c]) => { const q = Number(c || 0) / win; return s + q * q; }, 0);
  const lowEnt = ent != null && Number(ent) < 1;
  const s = sec.data || {};
  const banned = Array.isArray(s.banned) ? s.banned : (Array.isArray(ban.data?.banned) ? ban.data.banned : []);
  const regHash = s.registryHash || ban.data?.registryHash || null;
  const rules = (s.rules && typeof s.rules === 'object') ? Object.entries(s.rules) : [];
  const attacks = Array.isArray(atk.data?.attacks) ? atk.data.attacks : [];
  const height = info.data && Number(info.data.blocks ?? info.data.height);
  const liveHeight = Number(d.height ?? height);
  const coreOn = Number.isFinite(height) && height >= 37300;
  const fc = mk.forecast;
  const fcs = fc && typeof fc === 'object'
    ? Object.keys(fc).map((k) => `${k}:${Number(fc[k]).toFixed(2)}`).join(' ')
    : fc;

  // Локальный счёт защиты: честная агрегация живых показаний, не вердикт ноды.
  const score = useMemo(() => {
    if (sh.never && !sh.data) return null;
    let v = 100;
    if (ent != null && Number.isFinite(Number(ent))) {
      if (Number(ent) < 0.5) v -= 45;
      else if (Number(ent) < 1) v -= 35;
      else if (Number(ent) < 1.5) v -= 15;
    } else v -= 10;
    if (topShare >= 0.9) v -= 30;
    else if (topShare >= 0.66) v -= 20;
    else if (topShare >= 0.5) v -= 10;
    v -= Math.min(20, an.length * 5);
    if ((s.attacksSeen ?? attacks.length) > 0) v -= 15;
    if (sh.stale || sec.stale) v -= 15;
    return Math.max(0, Math.min(100, Math.round(v)));
  }, [ent, topShare, an.length, attacks.length, s.attacksSeen, sh.stale, sec.stale, sh.never, sh.data]);

  const threat = score == null ? null : score >= 80 ? 0 : score >= 50 ? 1 : 2;
  const threatTxt = threat == null ? '—' : threat === 0 ? (RU ? 'НИЗКАЯ' : 'LOW') : threat === 1 ? (RU ? 'СРЕДНЯЯ' : 'MEDIUM') : (RU ? 'ВЫСОКАЯ' : 'HIGH');
  const threatCol = threat == null ? '#5c6672' : threat === 0 ? '#39d98a' : threat === 1 ? '#ffd75e' : '#ef4444';

  // История энтропии — только в памяти вкладки.
  const [hist, setHist] = useState([]);
  useEffect(() => {
    if (ent != null && Number.isFinite(Number(ent))) {
      setHist((h) => [...h.slice(-39), Number(ent)]);
    }
  }, [ent]);

  // --- Дозор: чисто клиентский монитор чтения, без ключей и мутаций ---
  const [watch, setWatch] = useState(WDEF);
  const [dorEnabled, setDorEnabled] = useState(true);
  const [log, setLog] = useState([]);
  const [noteOn, setNoteOn] = useState(false);
  const noteRef = useRef(false);
  const prevRef = useRef({ reg: null, h: null, stuck: 0, fired: {} });
  useEffect(() => {
    try {
      const w = loadJson('ag_shield_watch', null);
      if (w && typeof w === 'object') setWatch({ ...WDEF, ...w });
      setLog(loadJson('ag_shield_log', []));
      setDorEnabled(loadJson('ag_shield_dor', true));
      // разрешение могло быть выдано в прошлой сессии — иначе уведомления молчат до клика
      const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
      noteRef.current = granted; setNoteOn(granted);
    } catch (e) {}
  }, []);
  useEffect(() => { try { localStorage.setItem('ag_shield_watch', JSON.stringify(watch)); } catch (e) {} }, [watch]);
  useEffect(() => { try { localStorage.setItem('ag_shield_dor', JSON.stringify(dorEnabled)); } catch (e) {} }, [dorEnabled]);

  function pushIncident(kind, msg) {
    const now = Date.now();
    const last = prevRef.current.fired[kind] || 0;
    if (now - last < 10 * 60 * 1000) return; // троттлинг: один повод — раз в 10 мин
    prevRef.current.fired[kind] = now;
    const ev = { ts: now, kind, msg };
    setLog((l) => {
      const nl = [...l.slice(-49), ev];
      try { localStorage.setItem('ag_shield_log', JSON.stringify(nl)); } catch (e) {}
      return nl;
    });
    if (noteRef.current) {
      try { new Notification('Agentcoin Shield: ' + kind, { body: msg }); } catch (e) {}
    }
  }

  useEffect(() => {
    if (!dorEnabled || sh.never) return;
    if (watch.entropy && ent != null && Number(ent) < 1) {
      pushIncident('entropy', `Энтропия ${Number(ent).toFixed(2)} < 1.0 — сеть фактически в одних руках.`);
    }
    if (watch.concentration && topShare >= 0.5) {
      pushIncident('concentration', `Топ-майнер держит ${(topShare * 100).toFixed(1)}% окна ${win}.`);
    }
    if (watch.stale && (sh.stale || sec.stale)) {
      pushIncident('stale', 'Данные старше 5 мин — показаниям нельзя доверять, ждём свежего опроса.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ent, topShare, sh.stale, sec.stale, dorEnabled]);

  useEffect(() => {
    if (!dorEnabled) return;
    const p = prevRef.current;
    if (regHash) {
      if (p.reg && p.reg !== regHash && watch.banchange) {
        pushIncident('banlist', 'registryHash изменился — сверь бан-лист заново, страница ничего не разбанивает.');
      }
      p.reg = regHash;
    }
    if (Number.isFinite(liveHeight)) {
      if (p.h === liveHeight) {
        p.stuck += 1;
        if (p.stuck >= 3 && watch.stall) {
          pushIncident('tip-stall', `Высота ${liveHeight} не растёт 3 опроса подряд — tip, возможно, встал.`);
          p.stuck = 0;
        }
      } else { p.h = liveHeight; p.stuck = 0; }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regHash, liveHeight, dorEnabled]);

  function exportJson(name, obj) {
    try {
      const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) {}
  }

  const [addr, setAddr] = useState('');
  const [check, setCheck] = useState(null);
  const inp = 'w-full rounded-xl border border-[#232d3b] bg-[#0a0e13] px-3 py-2 font-mono text-sm focus:border-[#e8b923] focus:outline-none';
  function checkBan(e) {
    e.preventDefault();
    const n = normAddr(addr);
    if (!n.ok) { setCheck({ err: t('err.addr') }); return; }
    const hit = banned.some((b) => String(b).toLowerCase() === n.address.toLowerCase());
    setCheck({ address: n.address, hit });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Герой в имперском стандарте: золото на тьме, живой статус, счёт */}
      <section className="overflow-hidden rounded-2xl border border-[#2a2410] bg-gradient-to-br from-[#171204] via-[#10161f] to-[#0a0e13] p-6 shadow-[0_0_50px_rgba(232,185,35,.10)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold uppercase tracking-[.2em] text-[#e8b923]">🛡 Agentcoin · {RU ? 'Щит' : 'Shield'} v0.4</p>
            <h1 className="mt-1 bg-gradient-to-b from-[#f5cf4d] to-[#b8912a] bg-clip-text text-3xl font-extrabold text-transparent md:text-4xl" style={{ filter: 'drop-shadow(0 0 18px rgba(212,175,55,.35))' }}>
              {RU ? 'Щит сети' : 'Network shield'}
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-[#aeb6c2]">
              {RU
                ? 'Имперский стандарт: золото, тьма, только правда. Энтропия, концентрация, SVD, цепь и бан-лист — живое чтение настоящей ноды. Без ключа, без мутаций, без выдуманного «всё хорошо».'
                : 'Imperial standard: gold on darkness, truth only. Entropy, concentration, SVD, chain and ban-list — live read-only data from the real node. No key, no mutations, no invented “all good”.'}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-2 rounded-full border border-[#2a3646] bg-[#0a0e13] px-3 py-1 font-mono">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: sh.never ? '#5c6672' : sh.stale ? '#ffd75e' : '#39d98a' }} />
                {sh.never ? (RU ? 'ожидание первого опроса…' : 'waiting for first poll…') : (RU ? `обновлено ${timeStr(sh.updatedAt)}` : `updated ${timeStr(sh.updatedAt)}`)}
              </span>
              <span className="rounded-full border px-3 py-1 font-bold" style={{ borderColor: threatCol, color: threatCol }}>
                {RU ? 'Угроза: ' : 'Threat: '}{threatTxt}{score != null ? ` · ${score}/100` : ''}
              </span>
            </div>
            {d.alert === 'mining_concentration' && (
              <p className="mt-3 max-w-2xl rounded-xl border border-[#5a1a1a] bg-[#1c0d0d] px-3 py-2 text-sm text-[#ff9d9d]">
                {RU
                  ? '⚠ Нода честно сообщает: mining_concentration — почти все блоки последних 256 делает один майнер. Это не сбой страницы, это факт сети.'
                  : '⚠ The node honestly reports: mining_concentration — nearly all of the last 256 blocks come from one miner. That is a network fact, not a page bug.'}
              </p>
            )}
            <ol className="mt-3 grid gap-2 text-[13px] text-[#aeb6c2] md:grid-cols-2">
              <li><b className="text-[#e8b923]">1.</b> {RU ? 'Смотри энтропию: ниже 1.0 — сеть фактически в одних руках.' : 'Watch entropy: below 1.0 means the network is effectively in one pair of hands.'}</li>
              <li><b className="text-[#e8b923]">2.</b> {RU ? 'Проверь концентрацию: доля топ-майнера и HHI ниже.' : 'Check concentration: top-miner share and HHI below.'}</li>
              <li><b className="text-[#e8b923]">3.</b> {RU ? 'Аномалии SVD кликабельны — каждый блок открывается в /block.' : 'SVD anomalies are clickable — each block opens in /block.'}</li>
              <li><b className="text-[#e8b923]">4.</b> {RU ? 'Дозор ниже — твоя защитная программа: только наблюдение в браузере.' : 'The watchdog below is your guard program: observation in the browser only.'}</li>
            </ol>
          </div>
          <div className="w-56 shrink-0 rounded-2xl border border-[#2a2410] bg-[#0a0e13]/80 p-4 text-center">
            <div className="text-[11px] font-bold uppercase tracking-widest text-[#8b93a1]">{RU ? 'Счёт защиты (локально)' : 'Shield score (local)'}</div>
            <div className="mt-1 text-5xl font-extrabold" style={{ color: threatCol, textShadow: `0 0 24px ${threatCol}55` }}>
              {score == null ? '—' : score}
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-[#1a2230]">
              <div className="h-full rounded-full" style={{ width: `${score ?? 0}%`, background: threatCol }} />
            </div>
            <div className="mt-2 text-[11px] text-[#8b93a1]">{RU ? 'оценка браузера, не вердикт ноды' : 'browser estimate, not node verdict'}</div>
            <button
              onClick={() => exportJson(`shield-snapshot-${Date.now()}.json`, { at: new Date().toISOString(), score, threat: threatTxt, entropy: ent, topShare, hhi, height: liveHeight, tipHash: d.tipHash, registryHash: regHash, anomalies: an, raw: d })}
              className="mt-3 w-full rounded-xl border border-[#e8b923] bg-gradient-to-b from-[#f5cf4d] to-[#d4af37] px-3 py-2 text-sm font-bold text-black shadow-[0_0_16px_rgba(212,175,55,.35)]">
              {RU ? '⤓ Снимок для проверки' : '⤓ Snapshot for verification'}
            </button>
          </div>
        </div>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card title={RU ? 'Энтропия майнинга' : 'Mining entropy'} right={<Stale show={sh.stale} t={t} />}>
          <Gauge value={ent} max={3} />
          <Spark points={hist} />
          <div className={`mt-2 text-xs font-bold ${lowEnt ? 'text-[#ef4444]' : 'text-[#22c55e]'}`}>
            {ent == null ? '—' : lowEnt
              ? (RU ? 'НИЗКАЯ — сеть в одних руках' : 'LOW — network in single hands')
              : (RU ? 'в норме' : 'healthy')}
          </div>
          <div className="mt-1 font-mono text-[11px] text-[#5c6672]">window {d.window ?? '—'} · checked {d.checkedAt ? timeStr(d.checkedAt) : '—'}</div>
        </Card>
        <Card title={RU ? 'Состояние сети (Марков)' : 'Network state (Markov)'} right={<Stale show={sh.stale} t={t} />}>
          <div className="num text-2xl font-bold text-white">{mk.current || '—'}</div>
          <div className="mt-1 break-words font-mono text-xs text-[#8b93a1]">{fcs || '—'}{mk.risk != null ? ` · risk ${Number(mk.risk).toFixed(2)}` : ''}</div>
          <div className="mt-1 text-xs text-[#8b93a1]">CORE-P0: {coreOn ? t('core.on') : t('core.off')} ({t('core.th')})</div>
          <div className="mt-2 rounded-xl bg-[#0a0e13] p-2 font-mono text-[11px] text-[#8b93a1]">
            tip {d.tipHash ? short(d.tipHash) : '—'} {Number.isFinite(liveHeight) ? `#${fmt(liveHeight)}` : ''}
          </div>
        </Card>
        <Card title="SVD" right={<Stale show={sh.stale} t={t} />}>
          <div className={`num text-2xl font-bold ${an.length === 0 ? 'text-[#22c55e]' : 'text-[#e8b923]'}`}>{an.length} {an.length === 0 ? '✓' : '⚠'}</div>
          <div className="mt-1 text-xs text-[#8b93a1]">{RU ? 'объяснено' : 'explained'} {sv.explained ?? '—'} · window {sv.window ?? '—'} · thr {sv.threshold ?? 3}</div>
          <div className="mt-2 text-xs text-[#8b93a1]">{RU ? 'Клик по высоте ведёт в /block — сверяй сам.' : 'Click a height to open /block — verify yourself.'}</div>
        </Card>
        <Card title={RU ? 'Охрана' : 'Guard'} right={<Stale show={sec.stale} t={t} />}>
          <div className="num text-2xl font-bold text-white">{fmt(s.attacksSeen ?? attacks.length)} / {fmt(s.bannedCount ?? banned.length)}</div>
          <div className="mt-1 text-xs text-[#8b93a1]">{RU ? 'атак / забанено' : 'attacks / banned'}</div>
          <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-[#5c6672]">
            <span className="truncate">registry {regHash ? short(regHash) : '—'}</span>
            {regHash ? <Copy text={regHash} /> : null}
          </div>
          <div className="mt-2 font-mono text-[11px] text-[#8b93a1]">HHI {(hhi * 10000).toFixed(0)} · top {(topShare * 100).toFixed(1)}%</div>
        </Card>
      </div>

      <Card title={RU ? 'Ноды — чтение по трём' : 'Nodes — three-source read'} right={<Stale show={nodes3.stale || nodes3.never} t={t} />}>
        {nodeRows.length === 0 ? <div className="text-[#5c6672]">—</div> : (
          <ul className="space-y-2">
            {nodeRows.map((n) => {
              const bad = !n.reachable || n.status === 'stale_tip' || n.status === 'lower_observed_height' || n.status === 'invalid_chain' || n.status === 'unreachable' || (Number.isFinite(Number(n.tipAgeSec)) && Number(n.tipAgeSec) > 300);
              return (
                <li key={String(n.name)} className="flex items-center justify-between gap-2 font-mono text-xs">
                  <span className="text-[#c8d0db]">{String(n.name)}</span>
                  <span className="text-[#8b93a1]">{n.reachable ? `#${fmt(n.blocks)}` : '—'}{n.tipHash ? ` · ${short(n.tipHash)}` : ''}{n.status && n.status !== 'responding' ? ` · ${n.status}` : ''}</span>
                  {bad ? <Stale show t={t} /> : null}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-2 font-mono text-[11px] text-[#5c6672]">{RU ? 'нет данных — «—» + stale; сверяй tip по трём' : 'no data — «—» + stale; compare tip across three'}</div>
      </Card>

      <Card title={RU ? 'Концентрация майнинга — окно 256 блоков' : 'Mining concentration — 256-block window'} right={<Stale show={sh.stale} t={t} />}>
        {entries.length === 0 ? <div className="text-[#5c6672]">—</div> : (
          <ul className="space-y-2">
            {entries.map(([a, c]) => {
              const share = Number(c) / win;
              const isTop = top && a === top.address;
              return (
                <li key={a}>
                  <div className="flex items-center justify-between gap-2 font-mono text-xs">
                    <span className={isTop ? 'font-bold text-[#ffd75e]' : 'text-[#c8d0db]'} title={a}>{short(a)}{isTop ? ' ★' : ''}</span>
                    <span className="text-[#8b93a1]">{fmt(c)} · {(share * 100).toFixed(1)}%</span>
                  </div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-[#1a2230]">
                    <div className={`h-full rounded-full ${isTop ? 'bg-gradient-to-r from-[#f5cf4d] to-[#d4af37]' : 'bg-[#2f3d52]'}`} style={{ width: `${(share * 100).toFixed(1)}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-xs text-[#8b93a1]">
          {RU
            ? `HHI ${(hhi * 10000).toFixed(0)} (10 000 = монополия). Адреса урезаны на экране, полные значения — в сыром /api/v1/shield. Ключей здесь нет и быть не может: это только чтение.`
            : `HHI ${(hhi * 10000).toFixed(0)} (10,000 = monopoly). Addresses are truncated on screen; full values are in raw /api/v1/shield. No keys by design: read-only.`}
        </p>
      </Card>

      <Card title={RU ? `Аномалии SVD (${an.length}) — проверь сам` : `SVD anomalies (${an.length}) — verify yourself`} right={<Stale show={sh.stale} t={t} />}>
        {an.length === 0 ? (
          <div className="text-sm text-[#39d98a]">{RU ? '✓ Аномалий нет в окне.' : '✓ No anomalies in window.'}</div>
        ) : (
          <ul className="grid gap-2 md:grid-cols-3">
            {an.map((a2, i) => (
              <li key={i} className="rounded-xl border border-[#223145] bg-[#0d141f] p-3 font-mono text-xs">
                <div className="flex items-center justify-between">
                  <a className="font-bold text-[#e8b923] underline" href={'/block/' + a2.height} target="_blank" rel="noreferrer">#{fmt(a2.height)}</a>
                  <span className="text-[#ffd75e]">score {a2.score}</span>
                </div>
                <div className="mt-1 text-[#8b93a1]">threshold {sv.threshold ?? 3} · <a className="text-[#5aa2ff] underline" href="/blocks?n=8">/blocks</a></div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Защитная программа: локальный дозор */}
      <Card title={RU ? '🛡 Защитная программа — локальный дозор (только чтение)' : '🛡 Guard program — local watchdog (read-only)'}>
        <p className="max-w-3xl text-[13px] text-[#aeb6c2]">
          {RU
            ? 'Это и есть «защитная программа»: дозор живёт только в твоём браузере, каждые 30 с перечитывает публичные API ноды и складывает тревоги в локальный журнал. Он никого не банит, ничего не разбанивает, не просит ключ и никуда его не отправляет. Мутации — только подписью через SDK/CLI и решением gov.'
            : 'This is the guard program: a watchdog that lives only in your browser, re-reads the public node APIs every 30s and stores alerts in a local log. It bans nobody, unbans nothing, asks for no key and sends none anywhere. Mutations need signatures via SDK/CLI and a gov decision.'}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => setDorEnabled((v) => !v)}
            className={`rounded-xl px-4 py-2 text-sm font-bold ${dorEnabled ? 'bg-gradient-to-b from-[#f5cf4d] to-[#d4af37] text-black' : 'border border-[#2a3646] bg-[#0a0e13] text-[#aeb6c2]'}`}>
            {dorEnabled ? (RU ? '● Дозор включён' : '● Watchdog on') : (RU ? '○ Дозор выключен' : '○ Watchdog off')}
          </button>
          <button
            onClick={async () => {
              try {
                if (!('Notification' in window)) return;
                const p = await Notification.requestPermission();
                noteRef.current = p === 'granted'; setNoteOn(p === 'granted');
              } catch (e) {}
            }}
            className="rounded-xl border border-[#2a3646] bg-[#0a0e13] px-3 py-2 text-sm text-[#aeb6c2] hover:border-[#e8b923]">
            {RU ? '🔔 Уведомления браузера' : '🔔 Browser notifications'}{noteOn ? ' ✓' : ''}
          </button>
          <button
            onClick={() => pushIncident('test', 'Ручная проверка дозора: журнал и уведомления работают.')}
            className="rounded-xl border border-[#2a3646] bg-[#0a0e13] px-3 py-2 text-sm text-[#aeb6c2] hover:border-[#e8b923]">
            {RU ? 'Проверить дозор' : 'Test watchdog'}
          </button>
          <button
            onClick={() => exportJson(`shield-watch-log-${Date.now()}.json`, log)}
            className="rounded-xl border border-[#2a3646] bg-[#0a0e13] px-3 py-2 font-mono text-sm text-[#5aa2ff] hover:border-[#e8b923]">
            ⤓ log.json
          </button>
          <button
            onClick={() => { setLog([]); try { localStorage.removeItem('ag_shield_log'); } catch (e) {} }}
            className="rounded-xl border border-[#2a3646] bg-[#0a0e13] px-3 py-2 text-sm text-[#8b93a1] hover:border-[#ef4444] hover:text-[#ef4444]">
            {RU ? 'Очистить журнал' : 'Clear log'}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {[
            ['entropy', RU ? 'энтропия < 1.0' : 'entropy < 1.0'],
            ['concentration', RU ? 'топ ≥ 50%' : 'top ≥ 50%'],
            ['stall', RU ? 'tip встал' : 'tip stall'],
            ['banchange', 'registryHash'],
            ['stale', 'stale > 5 мин'],
          ].map(([k, label]) => (
            <label key={k} className={`flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1 ${watch[k] ? 'border-[#e8b923] text-[#ffd75e]' : 'border-[#2a3646] text-[#5c6672]'}`}>
              <input type="checkbox" checked={!!watch[k]} onChange={() => setWatch((w) => ({ ...w, [k]: !w[k] }))} className="accent-[#e8b923]" />
              {label}
            </label>
          ))}
        </div>
        <div className="mt-3">
          {log.length === 0 ? (
            <div className="text-sm text-[#39d98a]">{RU ? '✓ Тревог дозора нет. Тишина — тоже данные.' : '✓ No watchdog alerts. Silence is data too.'}</div>
          ) : (
            <ul className="max-h-44 space-y-1 overflow-y-auto font-mono text-xs">
              {[...log].reverse().slice(0, 20).map((e, i) => (
                <li key={i} className="flex gap-2 rounded-lg bg-[#0a0e13] px-2 py-1">
                  <span className="text-[#5c6672]">{timeStr(e.ts)}</span>
                  <span className="font-bold text-[#ffd75e]">{e.kind}</span>
                  <span className="break-words text-[#c8d0db]">{e.msg}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={RU ? 'Проверить адрес в бан-листе' : 'Check an address against the ban-list'}>
          <form onSubmit={checkBan} className="flex flex-col gap-2 md:flex-row">
            <input className={inp} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="AGT… (40 hex)" autoComplete="off" spellCheck="false" />
            <button className="rounded-xl bg-gradient-to-b from-[#f5cf4d] to-[#d4af37] px-4 py-2 font-bold text-black shadow-[0_0_16px_rgba(212,175,55,.35)]">
              {RU ? 'Проверить' : 'Check'}
            </button>
          </form>
          {check?.err && <div className="mt-2 text-sm text-[#ef4444]">{check.err}</div>}
          {check?.address && (
            <div className="mt-2 rounded-xl bg-[#0a0e13] p-3 font-mono text-[13px]">
              <span title={check.address}>{short(check.address)}</span>{' '}
              {check.hit
                ? <span className="font-bold text-[#ef4444]">{RU ? '⛔ В БАН-ЛИСТЕ — переводы/майнинг заблокированы' : '⛔ BANNED — transfers/mining blocked'}</span>
                : <span className="font-bold text-[#39d98a]">{RU ? '✓ не в бан-листе (на момент опроса)' : '✓ not banned (as of last poll)'}</span>}
            </div>
          )}
          <p className="mt-2 text-xs text-[#8b93a1]">
            {RU ? 'Проверка — локальное сравнение с публичным бан-листом, ключ не нужен и никуда не отправляется.' : 'The check is a local comparison against the public ban-list; no key needed or sent.'}
          </p>
        </Card>
        <Card title={RU ? 'Бан-лист и доказательства' : 'Ban-list & evidence'} right={<Stale show={ban.stale} t={t} />}>
          <div className="flex items-center gap-2 font-mono text-xs">
            <span className="break-all text-[#c8d0db]">registryHash {regHash || '—'}</span>
            {regHash && <Copy text={regHash} />}
          </div>
          {banned.length === 0 ? (
            <div className="mt-2 text-sm text-[#8b93a1]">{RU ? 'бан-лист пуст' : 'ban-list empty'}</div>
          ) : (
            <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto font-mono text-xs">
              {banned.map((b) => (
                <li key={b} className="flex items-center justify-between gap-2 rounded-lg bg-[#0a0e13] px-2 py-1">
                  <span className="truncate text-[#ff9d9d]" title={b}>{b}</span>
                  <Copy text={b} />
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap gap-3 font-mono text-xs">
            <a className="text-[#5aa2ff] underline" href="/security/banlist">/security/banlist</a>
            <a className="text-[#5aa2ff] underline" href="/security/attacks">/security/attacks</a>
            <a className="text-[#5aa2ff] underline" href="/security/status">/security/status</a>
          </div>
        </Card>
      </div>

      <Card title={RU ? 'Правила охраны (только чтение)' : 'Guard rules (read-only)'} right={<Stale show={sec.stale} t={t} />}>
        {rules.length === 0 ? <div className="text-[#5c6672]">—</div> : (
          <ul className="grid gap-2 md:grid-cols-2">
            {rules.map(([k, v]) => (
              <li key={k} className="flex items-center justify-between gap-2 rounded-xl border border-[#223145] bg-[#0d141f] px-3 py-2 font-mono text-xs">
                <span className="text-[#c8d0db]">{k}</span>
                <span className={`rounded-full px-2 py-0.5 font-bold ${String(v).includes('ban') ? 'bg-[#2a0d0d] text-[#ff9d9d]' : 'bg-[#1a2230] text-[#8b93a1]'}`}>{String(v)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-[#8b93a1]">
          {RU
            ? 'Разбан — только подписью оператора и решением gov; эта страница кнопок разбана не имеет специально.'
            : 'Unbanning needs the operator signature and a gov decision; this page deliberately has no unban buttons.'}
        </p>
      </Card>

      <Card title={RU ? `Журнал атак (${attacks.length})` : `Attack log (${attacks.length})`} right={<Stale show={atk.stale} t={t} />}>
        {attacks.length === 0 ? (
          <div className="text-sm text-[#39d98a]">{RU ? '✓ Зафиксированных атак нет. Пустой журнал — тоже данные: нода так и отвечает.' : '✓ No recorded attacks. An empty log is data too: that is what the node answers.'}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-[13px]">
              <thead><tr className="text-left text-[#8b93a1]"><th>ID</th><th>{RU ? 'тип' : 'type'}</th><th>{RU ? 'адрес' : 'address'}</th><th>{RU ? 'когда' : 'when'}</th></tr></thead>
              <tbody>
                {attacks.slice(-10).reverse().map((x, i) => (
                  <tr key={i} className="border-t border-[#161d28]">
                    <td>{x.id || '—'}</td><td>{x.type || '—'}</td>
                    <td className="max-w-[220px] truncate" title={x.address || x.addr || ''}>{x.address || x.addr || '—'}</td>
                    <td>{x.ts ? timeStr(x.ts) : (x.at ? timeStr(x.at) : '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={RU ? 'Гигиена безопасности' : 'Security hygiene'}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-[#aeb6c2]">
          <li>{RU ? 'Страница никогда не просит приватный ключ и мнемонику. Любая форма, которая их просит от имени Щита, — подделка.' : 'This page never asks for a private key or seed phrase. Any form asking for them in the Shield’s name is fake.'}</li>
          <li>{RU ? 'Мутации (бан/разбан, переводы) — только подписью через SDK/CLI и решением gov; здесь их нет.' : 'Mutations (ban/unban, transfers) need signatures via SDK/CLI and a gov decision; none live here.'}</li>
          <li>{RU ? 'Нет данных — нет зелёной галочки: страница показывает «—» и stale-бейдж, а не выдуманное «всё хорошо».' : 'No data means no green check: the page shows “—” and a stale badge, never an invented “all good”.'}</li>
          <li>{RU ? 'Сырые данные для своей проверки:' : 'Raw data for your own verification:'} <a className="font-mono text-[#5aa2ff] underline" href="/api/v1/shield">/api/v1/shield</a> · <a className="font-mono text-[#5aa2ff] underline" href="/security/banlist">/security/banlist</a></li>
        </ul>
      </Card>
    </div>
  );
}
