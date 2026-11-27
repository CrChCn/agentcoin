'use client';
import { useState } from 'react';
import { useLang } from '@/lib/i18n';
import { useApi, fmt } from '@/lib/api';
import { normAddr } from '@/lib/addr';
import { Card, Stale } from '@/components/ui';

export default function Mbc20() {
  const { t, locale } = useLang();
  const st = useApi('/api/v1/mbc20/state', 30000);
  const d = st.data || {};
  const tokens = Array.isArray(d.tokens) ? d.tokens : [];
  const prices = d.prices || {};
  const [addr, setAddr] = useState('');
  const [bal, setBal] = useState(null);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState('CRCHCN');
  const [book, setBook] = useState(null);
  const [bookErr, setBookErr] = useState('');

  async function check(e) {
    e.preventDefault();
    setErr(''); setBal(null);
    const n = normAddr(addr);
    if (!n.ok) { setErr(t('err.addr')); return; }
    try {
      const r = await fetch('/api/v1/balance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: n.address }),
      });
      const j = await r.json();
      setBal(j.balance);
    } catch (e2) { setErr(String(e2.message || e2)); }
  }

  async function loadBook(e) {
    e.preventDefault();
    setBookErr(''); setBook(null);
    const tk = String(tick || '').trim().toUpperCase().slice(0, 8);
    if (!tk) { setBookErr(t('mbc20.tickErr')); return; }
    try {
      const r = await fetch('/api/v1/mbc20/book?tick=' + encodeURIComponent(tk), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setBook(await r.json());
    } catch (e2) { setBookErr(String(e2.message || e2)); }
  }

  const inp = 'w-full rounded-xl border border-[#232d3b] bg-[#0a0e13] px-3 py-2 font-mono text-sm';
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-[#e8b923]">{t('mbc20.title')}</h1>
      <Card title={t('mbc20.tokens')} right={<Stale show={st.stale} t={t} />}>
        {tokens.length === 0 ? <div className="text-[#5c6672]">—</div> : (
          <ul className="space-y-2 text-sm">
            {tokens.map((x) => {
              const p = prices[x.tick] || {};
              return (
                <li key={x.tick} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="font-mono font-bold text-[#e8b923]">{x.tick}</span>
                  <span className="text-[#8b93a1]">{t('mbc20.minted')} {fmt(x.minted, 0, locale)}/{fmt(x.max, 0, locale)}</span>
                  <span className="text-[#8b93a1]">{x.status}</span>
                  {(p.bestBidAGT != null || p.bestAskAGT != null) && (
                    <span className="font-mono text-xs text-[#aeb6c2]">
                      bid {p.bestBidAGT ?? '—'} / ask {p.bestAskAGT ?? '—'} AGT
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-2 text-xs text-[#5c6672]">{d.standard || ''} · {t('mbc20.base')}: {d.baseUnit || '—'}</p>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t('mbc20.balTitle')}>
          <form onSubmit={check} className="flex flex-col gap-2">
            <input className={inp} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="AGT… (40 hex)" />
            <button className="rounded-xl bg-[#e8b923] px-4 py-2 font-bold text-black">{t('mbc20.balBtn')}</button>
          </form>
          {err && <div className="mt-2 text-sm text-[#ef4444]">{err}</div>}
          {bal != null && <div className="num mt-2">{fmt(bal, 0, locale)} AGT</div>}
        </Card>
        <Card title={t('mbc20.bookTitle')}>
          <form onSubmit={loadBook} className="flex flex-col gap-2">
            <input className={inp} value={tick} onChange={(e) => setTick(e.target.value)} placeholder="TICK" />
            <button className="rounded-xl bg-[#e8b923] px-4 py-2 font-bold text-black">{t('mbc20.bookBtn')}</button>
          </form>
          {bookErr && <div className="mt-2 text-sm text-[#ef4444]">{bookErr}</div>}
          {book && (
            <div className="mt-2 font-mono text-xs">
              <div className="text-[#8b93a1]">{book.item} · spread {book.spread}</div>
              <div className="mt-1 grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[#5ee6ff]">bids ({(book.bids || []).length})</div>
                  {(book.bids || []).slice(0, 5).map((b) => (
                    <div key={b.ref}>{b.price} × {b.remaining ?? b.qty}</div>
                  ))}
                </div>
                <div>
                  <div className="text-[#e8b923]">asks ({(book.asks || []).length})</div>
                  {(book.asks || []).slice(0, 5).map((a) => (
                    <div key={a.ref}>{a.price} × {a.remaining ?? a.qty}</div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
