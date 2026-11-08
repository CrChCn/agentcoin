'use client';
import { useLang } from '@/lib/i18n';
import { useApi, fmt, timeStr } from '@/lib/api';
import { Card, Stale } from '@/components/ui';

export default function Shield() {
  const { lang, t } = useLang();
  const RU = lang === 'ru';
  const sh = useApi('/api/v1/shield', 30000);
  const info = useApi('/api/v1/info', 30000);
  const d = sh.data || {};
  const ent = d.miningEntropy;
  const mk = d.markov || {};
  const sv = d.svd || {};
  const an = (sv && sv.anomalies) ? sv.anomalies.length : 0;
  const height = info.data && Number(info.data.blocks ?? info.data.height);
  const coreOn = height != null && height >= 37300;
  const fc = mk.forecast;
  const fcs = fc && typeof fc === 'object'
    ? Object.keys(fc).map((k) => `${k}:${Number(fc[k]).toFixed(2)}`).join(' ')
    : fc;

  const cards = [
    [RU ? 'Энтропия майнинга' : 'Mining entropy',
      ent != null ? Number(ent).toFixed(3) : '—',
      ent != null && ent < 1 ? (RU ? 'НИЗКАЯ — сеть в одних руках' : 'LOW — network in single hands') : '',
      ent != null && ent < 1 ? 'text-[#ef4444]' : 'text-[#22c55e]'],
    [RU ? 'Состояние сети (Марков)' : 'Network state (Markov)',
      mk.current || '—', fcs ? `→ ${fcs}` + (mk.risk != null ? ` · risk ${Number(mk.risk).toFixed(2)}` : '') : '', 'text-white'],
    ['SVD', sv ? `${an} ${an === 0 ? '✓' : '⚠'}` : '—',
      sv && sv.explained != null ? `explained ${sv.explained}` : '', an === 0 ? 'text-[#22c55e]' : 'text-[#e8b923]'],
    ['VCG', RU ? 'нет' : 'none', '/jobs/auction/list', 'text-[#8b93a1]'],
    ['CORE-P0', coreOn ? t('core.on') : t('core.off'), t('core.th'), coreOn ? 'text-[#22c55e]' : 'text-[#8b93a1]'],
    [RU ? 'Охрана' : 'Guard', `${fmt(d.attacks)} / ${fmt(d.banned)}`, 'attacks / banned', 'text-white'],
  ];

  const inc = (d.recentIncidents || d.incidents || []).slice(0, 10);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-[#e8b923]">🛡 {RU ? 'Щит сети' : 'Network shield'}</h1>
      <p className="text-sm text-[#8b93a1]">
        {RU ? 'Энтропия майнинга, состояние сети, аномалии SVD и инциденты — только реальные данные ноды.' : 'Mining entropy, network state, SVD anomalies and incidents — only real node data.'}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map(([title, val, sub, cls]) => (
          <Card key={title} title={title} right={<Stale show={sh.stale} t={t} />}>
            <div className={`num text-2xl font-bold ${cls}`}>{val}</div>
            <div className="mt-1 text-xs text-[#8b93a1]">{sub}</div>
          </Card>
        ))}
      </div>
      <Card title={RU ? 'Последние 10 инцидентов' : 'Last 10 incidents'}>
        {inc.length === 0 ? <div className="text-[#5c6672]">—</div> : (
          <div className="overflow-x-auto">
            <table className="w-full font-mono text-[13px]">
              <thead><tr className="text-left text-[#8b93a1]"><th>ID</th><th>{RU ? 'тип' : 'type'}</th><th>{RU ? 'адрес' : 'address'}</th><th>{RU ? 'когда' : 'when'}</th></tr></thead>
              <tbody>
                {inc.map((x, i) => (
                  <tr key={i} className="border-t border-[#161d28]">
                    <td>{x.id || '—'}</td><td>{x.type || '—'}</td><td>{x.address || x.addr || '—'}</td>
                    <td>{x.ts ? timeStr(x.ts) : (x.at ? timeStr(x.at) : '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
