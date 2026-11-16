'use client';
import { useState } from 'react';
import { useLang } from '@/lib/i18n';
import { useApi, fmt, timeStr } from '@/lib/api';
import { Card, Stale } from '@/components/ui';

export default function Jobs() {
  const { lang, t } = useLang();
  const RU = lang === 'ru';
  const js = useApi('/api/v1/jobs/state', 15000);
  const auc = useApi('/api/v1/jobs/auction/list', 30000);
  const d = js.data || {};
  const stats = d.stats || {};
  const hist = d.history || [];
  const auctions = Array.isArray(auc.data) ? auc.data : ((auc.data && auc.data.auctions) || []);
  const [showTest, setShowTest] = useState(false);
  const isTestJob = (h) => String(h.id || h.jobId || '').toLowerCase().startsWith('test');
  const visHist = showTest ? hist : hist.filter((h) => !isTestJob(h));
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-[#e8b923]">{RU ? 'Джобборд' : 'Job board'}</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[[RU ? 'Открыто' : 'Open', stats.open], [RU ? 'В работе' : 'Active', stats.active ?? stats.inWork],
          [RU ? 'Завершено' : 'Done', stats.done ?? stats.completed], [RU ? 'Выплачено' : 'Paid', stats.paidOut]].map(([l, v]) => (
          <div key={l} className="rounded-2xl border border-[#1c2530] bg-[#10161f]/80 p-4">
            <div className="num text-2xl font-bold">{v != null ? fmt(v) : '—'}</div>
            <div className="mt-1 text-xs text-[#8b93a1]">{l}</div>
          </div>
        ))}
      </div>
      <Card title={RU ? 'Аукцион (VCG)' : 'Auction (VCG)'} right={<Stale show={auc.stale} t={t} />}>
        {auctions.length === 0 ? <div className="text-[#5c6672]">{RU ? 'нет' : 'none'}</div> : (
          <ul className="space-y-1 text-sm">
            <div className="mb-2 text-xs text-[#8b93a1]">{RU ? 'Ставка = то, что платишь ТЫ (держи крошечной). Брифы:' : 'Your bid = what YOU pay (keep tiny). Briefs:'} <a className="font-bold text-[#e8b923] underline" href="/auctions.html">/auctions.html</a></div>
            {auctions.map((a, i) => <li key={i} className="font-mono">{(a.id || a.jobId || '').slice(0, 8)} · {a.status || ''} · bids {a.commits ?? '?'} <a className="text-[#e8b923] underline" href={'/api/v1/jobs/auction/state?id=' + (a.id || a.jobId) + '&full=1'}>full</a></li>)}
          </ul>
        )}
      </Card>
      <Card title={RU ? 'История (50)' : 'History (50)'} right={<span className="flex items-center gap-2"><label className="flex items-center gap-1 text-xs text-[#8b93a1]"><input type="checkbox" checked={showTest} onChange={(e) => setShowTest(e.target.checked)} />{RU ? 'тестовые' : 'test'}</label><Stale show={js.stale} t={t} /></span>}>
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-[13px]">
            <thead><tr className="text-left text-[#8b93a1]">
              <th>ID</th><th>{RU ? 'исполнитель' : 'worker'}</th><th>{RU ? 'выплата' : 'payout'}</th><th>{RU ? 'когда' : 'when'}</th>
            </tr></thead>
            <tbody>
              {visHist.slice(0, 50).map((h, i) => (
                <tr key={i} className="border-t border-[#161d28]">
                  <td>{h.id || h.jobId || '—'}</td><td>{h.worker || h.executor || '—'}</td>
                  <td className="num">{h.paidOut != null ? fmt(h.paidOut) : '—'}</td>
                  <td>{h.finishedAt ? timeStr(h.finishedAt) : (h.ts ? timeStr(h.ts) : '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
