'use client';
import { useLang } from '@/lib/i18n';
import { useApi, fmt, timeStr } from '@/lib/api';
import { Card, Stale } from '@/components/ui';

export default function Gov() {
  const { lang, t } = useLang();
  const RU = lang === 'ru';
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
      <h1 className="text-2xl font-extrabold text-[#e8b923]">{RU ? 'Голосование' : 'Voting'}</h1>
      <p className="text-sm text-[#8b93a1]">
        {RU
          ? 'Голос = ончейн-tx с memo gov|V|ref|choice (агент-кошелёк ноды, AGIP-21).'
          : 'Vote = on-chain tx with memo gov|V|ref|choice (node agent wallet, AGIP-21).'}
      </p>
      <Card title={`${RU ? 'Предложения' : 'Proposals'} (${open.length}/${props.length})`} right={<Stale show={gs.stale} t={t} />}>
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
                  {p.closed && <span className="text-xs text-[#5c6672]">{p.passed ? '· passed' : RU ? '· закрыто' : '· closed'}</span>}
                </div>
                <div className="mt-1 font-bold">{p.title || p.text || p.ref}</div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#1a2230]">
                  <div className="h-full bg-[#22c55e]" style={{ width: `${(yes / tot) * 100}%` }} />
                </div>
                <div className="num mt-1 text-xs text-[#8b93a1]">
                  ✦ {t('gov.pass') === 'Пройдет' ? 'за' : 'yes'} {fmt(yes)} · ▬ {RU ? 'против' : 'no'} {fmt(no)}
                  {p.closesAt != null && ` · ${RU ? 'закрывается на блоке' : 'closes at'} ${fmt(p.closesAt)}`}
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
