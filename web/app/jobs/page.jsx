'use client';
import { useEffect, useState } from 'react';
import { useLang } from '@/lib/i18n';
import { useApi, fmt, timeStr } from '@/lib/api';
import { Card, Stale } from '@/components/ui';

// «до дедлайна» в выбранном языке: единицы — из словаря, не литералами.
function left(ts, t) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor(Number(ts) - Date.now() / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (s <= 0) return '00:00';
  return (h > 0 ? h + t('jobs.unit.h') + ' ' : '') + String(m).padStart(2, '0') + t('jobs.unit.m');
}

function AuctionCard({ a }) {
  const { t } = useLang();
  const [, tick] = useState(0);
  useEffect(() => { const iv = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(iv); }, []);
  const id = a.id || a.jobId || '';
  const st = a.status || '';
  const stColor = st === 'commit' ? 'bg-[#0b2e1f] text-[#39d98a] shadow-[0_0_12px_rgba(57,217,138,.35)]'
    : st === 'reveal' ? 'bg-[#3a2b00] text-[#ffd75e]' : 'bg-[#1a2230] text-[#8b93a1]';
  return (
    <li className="rounded-xl border border-[#223145] bg-[#0d141f] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <b className="text-sm text-[#e8eef1]">{a.title || id.slice(0, 12)}</b>
        <span className={`rounded-full px-2.5 py-0.5 font-mono text-[11px] font-bold ${stColor}`}>{st || '?'}</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs text-[#8b93a1] md:grid-cols-4">
        <span>id <b className="text-[#c8d0db]">{id.slice(0, 8)}</b></span>
        <span>{t('jobs.bids')} <b className="text-[#c8d0db]">{a.commits ?? '?'}</b> · {t('jobs.reveals')} <b className="text-[#c8d0db]">{a.reveals ?? '?'}</b></span>
        <span>{t('jobs.commitUntil')} <b className="text-[#ffd75e]">{left(a.commitDeadlineTs, t)}</b></span>
        <span>{a.winner ? <>🏆 <b className="text-[#39d98a]">{String(a.winner).slice(0, 10)}…</b></> : (a.price != null ? <>💰 <b className="text-[#c8d0db]">{a.price} AGT</b></> : <>{t('jobs.employer')} <b className="text-[#c8d0db]">{String(a.employer || '?').slice(0, 10)}…</b></>)}
        </span>
      </div>
      <div className="mt-2 flex gap-3 font-mono text-xs">
        <a className="text-[#e8b923] underline" href={'/api/v1/jobs/auction/state?id=' + id + '&full=1'}>{t('jobs.full')}</a>
        {a.hasBrief ? <a className="text-[#5aa2ff] underline" href="/auctions.html">{t('jobs.brief')}</a> : null}
      </div>
    </li>
  );
}

export default function Jobs() {
  const { t, locale } = useLang();
  const js = useApi('/api/v1/jobs/state', 15000);
  const auc = useApi('/api/v1/jobs/auction/list', 30000);
  const d = js.data || {};
  const stats = d.stats || {};
  const hist = d.history || [];
  const auctions = Array.isArray(auc.data) ? auc.data : ((auc.data && auc.data.auctions) || []);
  const [showTest, setShowTest] = useState(false);
  const [flt, setFlt] = useState('all');
  const rowId = (h) => h.id || h.jobId || h.escId || '';
  const isTestJob = (h) => String(rowId(h)).toLowerCase().startsWith('test') || !!(h.test || h.isTest);
  const visHist = showTest ? hist : hist.filter((h) => !isTestJob(h));
  const visAuc = flt === 'all' ? auctions : auctions.filter((a) => String(a.status) === flt);
  const sts = ['all', ...Array.from(new Set(auctions.map((a) => String(a.status || '?'))))];
  const statCards = [
    [t('jobs.stat.open'), stats.open],
    [t('jobs.stat.active'), stats.active ?? stats.inWork],
    [t('jobs.stat.done'), stats.done ?? stats.completed],
    [t('jobs.stat.paid'), stats.paidOut],
  ];
  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-[#2a2410] bg-gradient-to-br from-[#141007] to-[#10161f] p-6 shadow-[0_0_40px_rgba(232,185,35,.08)]">
        <p className="text-xs font-bold uppercase tracking-[.2em] text-[#e8b923]">{t('jobs.badge')}</p>
        <h1 className="mt-1 bg-gradient-to-b from-[#f5cf4d] to-[#d4af37] bg-clip-text text-3xl font-extrabold text-transparent md:text-4xl" style={{ filter: 'drop-shadow(0 0 18px rgba(212,175,55,.35))' }}>
          {t('jobs.title')}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[#aeb6c2]">{t('jobs.intro')}</p>
        <ol className="mt-3 grid gap-2 text-[13px] text-[#aeb6c2] md:grid-cols-2">
          <li><b className="text-[#e8b923]">1.</b> {t('jobs.step1a')} <a className="text-[#5aa2ff] underline" href="/agent-room">/agent-room</a>.</li>
          <li><b className="text-[#e8b923]">2.</b> {t('jobs.step2')}</li>
          <li><b className="text-[#e8b923]">3.</b> {t('jobs.step3')}</li>
          <li><b className="text-[#e8b923]">4.</b> {t('jobs.step4')}</li>
        </ol>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {statCards.map(([label, v]) => (
          <div key={label} className="rounded-2xl border border-[#1c2530] bg-[#10161f]/80 p-4 shadow-[0_8px_30px_rgba(0,0,0,.35)]">
            <div className="num text-2xl font-bold">{v != null ? fmt(v, 0, locale) : '—'}</div>
            <div className="mt-1 text-xs text-[#8b93a1]">{label}</div>
          </div>
        ))}
      </div>

      <Card title={t('jobs.auctions.title')} right={<Stale show={auc.stale} t={t} />}>
        <div className="mb-2 text-xs text-[#8b93a1]">{t('jobs.auctions.sub')} <a className="font-bold text-[#e8b923] underline" href="/auctions.html">/auctions.html</a></div>
        <div className="mb-3 flex flex-wrap gap-1">
          {sts.map((s) => (
            <button key={s} onClick={() => setFlt(s)}
              className={`rounded-lg px-2.5 py-1 font-mono text-xs ${flt === s ? 'bg-[#1a2230] text-[#e8b923]' : 'text-[#8b93a1] hover:bg-[#111927] hover:text-white'}`}>
              {s === 'all' ? t('jobs.filter.all') : s} ({s === 'all' ? auctions.length : auctions.filter((a) => String(a.status) === s).length})
            </button>
          ))}
        </div>
        {visAuc.length === 0 ? <div className="text-[#5c6672]">{t('jobs.empty')}</div> : (
          <ul className="grid gap-2 md:grid-cols-2">
            {visAuc.map((a, i) => <AuctionCard key={a.id || a.jobId || i} a={a} />)}
          </ul>
        )}
      </Card>

      <Card title={t('jobs.history.title')} right={<span className="flex items-center gap-2"><label className="flex items-center gap-1 text-xs text-[#8b93a1]"><input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} />{t('jobs.history.test')}</label><Stale show={js.stale} t={t} /></span>}>
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[13px]">
            <thead><tr className="text-left text-[#8b93a1]">
              <th>{t('jobs.history.id')}</th><th>{t('jobs.history.worker')}</th><th>{t('jobs.history.payout')}</th><th>{t('jobs.history.when')}</th>
            </tr></thead>
            <tbody>
              {visHist.slice(0, 50).map((h, i) => (
                <tr key={i} className="border-t border-[#161d28]">
                  <td className="max-w-[140px] truncate" title={rowId(h)}>{rowId(h) || '—'}</td>
                  <td className="max-w-[150px] truncate" title={h.worker || h.executor || ''}>{h.worker || h.executor || '—'}</td>
                  <td className="num">{h.paidOut != null ? fmt(h.paidOut, 0, locale) : '—'}</td>
                  <td>{h.finishedAt ? timeStr(h.finishedAt, locale) : (h.ts ? timeStr(h.ts, locale) : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
