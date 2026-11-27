'use client';
import { useLang } from '@/lib/i18n';
import { useApi, fmt, timeStr } from '@/lib/api';
import { Card, Stale } from '@/components/ui';

export default function Gov() {
  const { t, locale } = useLang();
  const gs = useApi('/api/v1/gov/state', 15000);
  const d = gs.data || {};
  const props = d.proposals || d.items || [];
  const open = props.filter((p) => !p.closed && (p.closesAt == null || (d.blocks ?? d.height ?? 0) < p.closesAt));

  function badge(p) {
    const wp = p.lawWouldPass ?? p.wouldPass;
    if (p.closed || wp == null) return null;
    const pass = wp === true;
    return (
      <span className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${pass ? 'bg-[#052e1b] text-[#4ade80]' : 'bg-[#3a1111] text-[#f87171]'}`}>
        {pass ? t('gov.pass') : t('gov.fail')}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-[#e8b923]">{t('gov.title')}</h1>
      <p className="text-sm text-[#8b93a1]">{t('gov.intro')}</p>
      <Card title={`${t('gov.proposals')} (${open.length}/${props.length})`} right={<Stale show={gs.stale} t={t} />}>
        <div className="grid gap-3">
          {props.slice(-12).reverse().map((p, i) => {
            const yes = (p.votes && (p.votes.yes ?? p.votes.Yes)) || p.yes || 0;
            const no = (p.votes && (p.votes.no ?? p.votes.No)) || p.no || 0;
            const tot = yes + no || 1;
            return (
              <div key={i} className="rounded-xl border border-[#232d3b] bg-[#0a0e13] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-[#8b93a1]">ref {p.ref}</span>
                  {badge(p)}
                  {p.closed && <span className="text-xs text-[#5c6672]">{p.passed ? t('gov.passedNote') : t('gov.closed')}</span>}
                </div>
                <div className="mt-1 font-bold">{p.title || p.text || p.ref}</div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#1a2230]">
                  <div className="h-full bg-[#22c55e]" style={{ width: `${(yes / tot) * 100}%` }} />
                </div>
                <div className="num mt-1 text-xs text-[#8b93a1]">
                  ✦ {t('gov.yes')} {fmt(yes, 0, locale)} · ▬ {t('gov.no')} {fmt(no, 0, locale)}
                  {p.closesAt != null && ` · ${t('gov.closesBlock')} ${fmt(p.closesAt, 0, locale)}`}
                </div>
              </div>
            );
          })}
          {props.length === 0 && <div className="text-[#5c6672]">—</div>}
        </div>
      </Card>
    </div>
  );
}
