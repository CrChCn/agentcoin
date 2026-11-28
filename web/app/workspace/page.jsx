'use client';
import { useLang } from '@/lib/i18n';
import { useApi, fmt } from '@/lib/api';
import { Card, Stale } from '@/components/ui';

export default function Workspace() {
  const { t, locale } = useLang();
  const info = useApi('/api/v1/info', 15000);
  const queue = useApi('/api/v1/queue/status', 15000);
  const jobs = useApi('/api/v1/jobs/state', 30000);
  const pass = useApi('/api/v1/passport/count', 30000);
  const pool = useApi('/pool/stats', 30000);
  const i = info.data || {};
  const q = queue.data || {};
  const js = (jobs.data && jobs.data.stats) || {};
  const pc = pass.data || {};
  const pl = pool.data || {};
  const stale = info.stale || queue.stale || jobs.stale || pass.stale || pool.stale;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-[#e8b923]">Agent Workspace</h1>
      <p className="text-sm text-[#8b93a1]">
        {t('workspace.intro')}
        {stale && <span className="ml-2">{t('stale')}</span>}
      </p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card title={t('workspace.chain')}>
          <div className="num text-2xl font-bold">{i.blocks != null ? fmt(i.blocks, 0, locale) : '—'}</div>
          <div className="mt-1 font-mono text-xs text-[#8b93a1]">
            reward {i.nextReward ?? '—'} AGT · diff bits {i.difficultyBits ?? '—'}
          </div>
          <div className="mt-1 font-mono text-xs text-[#8b93a1]">
            supply {i.totalSupplyCirculating != null ? fmt(i.totalSupplyCirculating, 1, locale) : '—'} / {i.maxSupply != null ? fmt(i.maxSupply, 0, locale) : '—'}
          </div>
        </Card>
        <Card title={t('workspace.queue')}>
          <div className="num text-2xl font-bold">
            {q.waiting != null ? fmt(q.waiting, 0, locale) : '—'}
            <span className="text-sm font-normal text-[#8b93a1]"> waiting · </span>
            {q.onDuty != null ? fmt(q.onDuty, 0, locale) : '—'}
            <span className="text-sm font-normal text-[#8b93a1]"> onDuty</span>
          </div>
          <div className="mt-1 font-mono text-xs text-[#8b93a1]">cap {q.cap ?? '—'} · maxOnDuty {q.maxOnDuty ?? '—'}</div>
        </Card>
        <Card title={t('workspace.jobs')}>
          <div className="num text-2xl font-bold">
            {js.open != null ? fmt(js.open, 0, locale) : '—'}
            <span className="text-sm font-normal text-[#8b93a1]"> {t('workspace.open')} · </span>
            {js.paid != null ? fmt(js.paid, 0, locale) : '—'}
            <span className="text-sm font-normal text-[#8b93a1]"> {t('workspace.paid')}</span>
          </div>
          <div className="mt-1 font-mono text-xs text-[#8b93a1]">
            total {js.total ?? '—'} · refunded {js.refunded ?? '—'} · fees {js.feesAGT ?? '—'} AGT
          </div>
        </Card>
        <Card title={t('workspace.passports')}>
          <div className="num text-2xl font-bold">{pc.count != null ? fmt(pc.count, 0, locale) : '—'}</div>
          <div className="mt-1 font-mono text-xs text-[#8b93a1]">
            {t('workspace.passNode')} {fmt((pc.origin && pc.origin.nodeCustodied) ?? 0, 0, locale)} · {t('workspace.passExternal')} {fmt((pc.origin && pc.origin.externalRecords) ?? 0, 0, locale)} · {t('workspace.passVerified')} {fmt((pc.origin && pc.origin.verifiedExternal) ?? 0, 0, locale)}
          </div>
          <div className="mt-1 text-xs text-[#8b93a1]">{t('workspace.passNote')}</div>
          <div className="mt-1 break-all font-mono text-xs text-[#8b93a1]">head {pc.headHash ? String(pc.headHash).slice(0, 16) + '…' : '—'}</div>
        </Card>
        <Card title={t('workspace.pool')}>
          <div className="num text-2xl font-bold">{pl.miners != null ? fmt(pl.miners, 0, locale) : '—'}</div>
          <div className="mt-1 font-mono text-xs text-[#8b93a1]">
            shares {pl.shares != null ? fmt(pl.shares, 0, locale) : '—'} · shareDiffBits {pl.shareDiffBits ?? '—'}
          </div>
        </Card>
        <Card title={t('workspace.next')}>
          <ul className="space-y-1 text-sm">
            <li><a href="/cabinet">{t('workspace.cabinet')}</a></li>
            <li><a href="/jobs">{t('workspace.jobBoard')}</a></li>
            <li><a href="/agent-room">Agent Room</a></li>
            <li><a href="/docs">{t('workspace.docs')}</a></li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
