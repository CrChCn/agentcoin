'use client';
import { useState } from 'react';
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
  const col = Number(value) < 1 ? '#ef4444' : Number(value) < 1.5 ? '#ffd75e' : '#39d98a';
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

export default function Shield() {
  const { lang, t } = useLang();
  const RU = lang === 'ru';
  const sh = useApi('/api/v1/shield', 30000);
  const sec = useApi('/security/status', 30000);
  const atk = useApi('/security/attacks', 30000);
  const ban = useApi('/security/banlist', 60000);
  const info = useApi('/api/v1/info', 30000);
  const d = sh.data || {};
  const ent = d.miningEntropy;
  const mk = d.markov || {};
  const sv = d.svd || {};
  const an = Array.isArray(sv.anomalies) ? sv.anomalies : [];
  const miners = d.miner || d.miners || {};
  const entries = Object.entries(miners).sort((a, b) => b[1] - a[1]);
  const win = d.window || entries.reduce((s, [, c]) => s + Number(c || 0), 0) || 1;
  const top = d.topMiner || (entries[0] ? { address: entries[0][0], blocks: entries[0][1], share: entries[0][1] / win } : null);
  const lowEnt = ent != null && Number(ent) < 1;
  const s = sec.data || {};
  const banned = Array.isArray(s.banned) ? s.banned : (Array.isArray(ban.data?.banned) ? ban.data.banned : []);
  const regHash = s.registryHash || ban.data?.registryHash || null;
  const rules = (s.rules && typeof s.rules === 'object') ? Object.entries(s.rules) : [];
  const attacks = Array.isArray(atk.data?.attacks) ? atk.data.attacks : [];
  const height = info.data && Number(info.data.blocks ?? info.data.height);
  const coreOn = height != null && height >= 37300;
  const fc = mk.forecast;
  const fcs = fc && typeof fc === 'object'
    ? Object.keys(fc).map((k) => `${k}:${Number(fc[k]).toFixed(2)}`).join(' ')
    : fc;

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
      <section className="rounded-2xl border border-[#2a2410] bg-gradient-to-br from-[#141007] to-[#10161f] p-6 shadow-[0_0_40px_rgba(232,185,35,.08)]">
        <p className="text-xs font-bold uppercase tracking-[.2em] text-[#e8b923]">🛡 Agentcoin · {RU ? 'Щит' : 'Shield'} v0.3</p>
        <h1 className="mt-1 bg-gradient-to-b from-[#f5cf4d] to-[#d4af37] bg-clip-text text-3xl font-extrabold text-transparent md:text-4xl" style={{ filter: 'drop-shadow(0 0 18px rgba(212,175,55,.35))' }}>
          {RU ? 'Щит сети' : 'Network shield'}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[#aeb6c2]">
          {RU
            ? 'Честная картина безопасности: энтропия майнинга, концентрация, аномалии SVD, состояние цепи и бан-лист — только живое чтение с настоящей ноды, без ключа и без мутаций.'
            : 'An honest security picture: mining entropy, concentration, SVD anomalies, chain state and ban-list — live read-only data from the real node, no key, no mutations.'}
        </p>
        {d.alert === 'mining_concentration' && (
          <p className="mt-2 max-w-2xl rounded-xl border border-[#5a1a1a] bg-[#1c0d0d] px-3 py-2 text-sm text-[#ff9d9d]">
            {RU
              ? '⚠ Нода честно сообщает: mining_concentration — почти все блоки последних 256 делает один майнер. Это не сбой страницы, это факт сети.'
              : '⚠ The node honestly reports: mining_concentration — nearly all of the last 256 blocks come from one miner. That is a network fact, not a page bug.'}
          </p>
        )}
        <ol className="mt-3 grid gap-2 text-[13px] text-[#aeb6c2] md:grid-cols-2">
          <li><b className="text-[#e8b923]">1.</b> {RU ? 'Смотри энтропию: ниже 1.0 — сеть фактически в одних руках.' : 'Watch entropy: below 1.0 means the network is effectively in one pair of hands.'}</li>
          <li><b className="text-[#e8b923]">2.</b> {RU ? 'Проверь концентрацию: доля топ-майнера и распределение ниже.' : 'Check concentration: top-miner share and distribution below.'}</li>
          <li><b className="text-[#e8b923]">3.</b> {RU ? 'Аномалии SVD кликабельны — каждый блок открывается в /block.' : 'SVD anomalies are clickable — each block opens in /block.'}</li>
          <li><b className="text-[#e8b923]">4.</b> {RU ? 'Бан-лист сверяй по registryHash; страница ничего не разбанивает.' : 'Verify the ban-list against registryHash; this page unbans nothing.'}</li>
        </ol>
      </section>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card title={RU ? 'Энтропия майнинга' : 'Mining entropy'} right={<Stale show={sh.stale} t={t} />}>
          <Gauge value={ent} max={3} />
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
        </Card>
        <Card title="SVD" right={<Stale show={sh.stale} t={t} />}>
          <div className={`num text-2xl font-bold ${an.length === 0 ? 'text-[#22c55e]' : 'text-[#e8b923]'}`}>{an.length} {an.length === 0 ? '✓' : '⚠'}</div>
          <div className="mt-1 text-xs text-[#8b93a1]">{RU ? 'объяснено' : 'explained'} {sv.explained ?? '—'} · window {sv.window ?? '—'}</div>
          <div className="mt-1 text-xs text-[#8b93a1]">tip {d.tipHash ? short(d.tipHash) : '—'} {d.height != null ? `#${fmt(d.height)}` : ''}</div>
        </Card>
        <Card title={RU ? 'Охрана' : 'Guard'} right={<Stale show={sec.stale} t={t} />}>
          <div className="num text-2xl font-bold text-white">{fmt(s.attacksSeen ?? attacks.length)} / {fmt(s.bannedCount ?? banned.length)}</div>
          <div className="mt-1 text-xs text-[#8b93a1]">{RU ? 'атак / забанено' : 'attacks / banned'}</div>
          <div className="mt-1 font-mono text-[11px] text-[#5c6672]">registry {regHash ? short(regHash) : '—'}</div>
        </Card>
      </div>

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
            ? 'Адреса урезаны на экране, полные значения — в сыром /api/v1/shield. Ключей здесь нет и быть не может: это только чтение.'
            : 'Addresses are truncated on screen; full values are in raw /api/v1/shield. There are no keys here by design: read-only.'}
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
            <ul className="mt-2 space-y-1 font-mono text-xs">
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
