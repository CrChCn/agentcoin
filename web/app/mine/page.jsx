'use client';
import { useState } from 'react';
import { useLang } from '@/lib/i18n';
import { useApi, fmt } from '@/lib/api';
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

export default function Mine() {
  const { t, locale } = useLang();
  const info = useApi('/api/v1/info', 15000);
  const pool = useApi('/pool/stats', 15000);
  const feed = useApi('/blocks?n=8', 20000);
  const [probe, setProbe] = useState(null);
  const [probing, setProbing] = useState(false);
  const d = info.data || {};
  const p = pool.data || {};

  async function probeJoin() {
    setProbing(true);
    try {
      const r = await fetch('/pool/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ probe: true }) });
      setProbe({ status: r.status, body: (await r.text()).slice(0, 200) });
    } catch (e) {
      setProbe({ status: '—', body: String(e.message || e).slice(0, 200) });
    }
    setProbing(false);
  }

  const blocks = (feed.data && feed.data.blocks) || [];
  const paused = true;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-[#2a2410] bg-gradient-to-br from-[#141007] to-[#10161f] p-6 shadow-[0_0_40px_rgba(232,185,35,.08)]">
        <p className="text-xs font-bold uppercase tracking-[.2em] text-[#e8b923]">{t('mine.badge')}</p>
        <h1 className="mt-1 bg-gradient-to-b from-[#f5cf4d] to-[#d4af37] bg-clip-text text-3xl font-extrabold text-transparent md:text-4xl" style={{ filter: 'drop-shadow(0 0 18px rgba(212,175,55,.35))' }}>
          {t('mine.title')}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[#aeb6c2]">{t('mine.intro')}</p>
        <ol className="mt-3 grid gap-2 text-[13px] text-[#aeb6c2] md:grid-cols-2">
          <li><b className="text-[#e8b923]">1.</b> {t('mine.step1')}</li>
          <li><b className="text-[#e8b923]">2.</b> {t('mine.step2')}</li>
          <li><b className="text-[#e8b923]">3.</b> {t('mine.step3')}</li>
          <li><b className="text-[#e8b923]">4.</b> {t('mine.step4')}</li>
        </ol>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card title={t('mine.height')} right={<Stale show={info.stale} t={t} />}>
          <div className="num text-2xl font-bold">{(d.blocks ?? d.height) != null ? fmt(d.blocks ?? d.height, 0, locale) : '—'}</div>
        </Card>
        <Card title={t('mine.difficulty')}>
          <div className="num break-all font-mono text-sm">{d.target || d.difficulty || (d.difficultyBits != null ? 'bits ' + d.difficultyBits : '—')}</div>
        </Card>
        <Card title={t('mine.mempool')}>
          <div className="num text-2xl font-bold">{d.mempool != null ? fmt(d.mempool, 0, locale) : (d.mempoolSize != null ? fmt(d.mempoolSize, 0, locale) : '—')}</div>
        </Card>
        <Card title={t('mine.pool')} right={<Stale show={pool.stale} t={t} />}>
          <div className="num text-2xl font-bold">{p.miners != null ? fmt(p.miners, 0, locale) : '—'}</div>
          <div className="mt-1 font-mono text-xs text-[#8b93a1]">
            {t('mine.shares')} {p.shares != null ? fmt(p.shares, 0, locale) : '—'} · {t('mine.shareDiffBits')} {p.shareDiffBits ?? '—'}
          </div>
        </Card>
      </div>

      <Card title={t('mine.intake.title')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-3 py-1 text-sm font-bold ${paused ? 'bg-[#3a2b00] text-[#ffd75e] shadow-[0_0_14px_rgba(232,185,35,.35)]' : 'bg-[#0b2e1f] text-[#39d98a]'}`}>
            {paused ? t('mine.intake.paused') : t('mine.intake.open')}
          </span>
          <button onClick={probeJoin} disabled={probing}
            className="rounded-lg bg-gradient-to-b from-[#f5cf4d] to-[#d4af37] px-3 py-1.5 text-sm font-bold text-black shadow-[0_0_16px_rgba(212,175,55,.35)] disabled:opacity-50">
            {probing ? '…' : t('mine.intake.probe')}
          </button>
        </div>
        {probe && (
          <div className="mt-2 rounded-xl bg-[#0a0e13] p-3 font-mono text-[13px]">
            <span className={probe.status === 405 ? 'text-[#ffd75e]' : 'text-[#39d98a]'}>HTTP {probe.status}</span>
            <span className="text-[#8b93a1]"> — {probe.status === 405
              ? t('mine.intake.closed')
              : probe.body}</span>
          </div>
        )}
        <p className="mt-2 text-sm text-[#8b93a1]">{t('mine.intake.note')}</p>
      </Card>

      <Card title={t('mine.blocks.title')} right={<Stale show={feed.stale} t={t} />}>
        {blocks.length === 0 ? (
          <div className="text-sm text-[#8b93a1]">—</div>
        ) : (
          <ol className="grid gap-2 md:grid-cols-2">
            {blocks.slice(0, 8).map((b) => (
              <li key={b.hash || b.height} className="flex items-center justify-between gap-2 rounded-xl border border-[#223145] bg-[#0d141f] px-3 py-2 font-mono text-xs">
                <span className="text-[#e8b923]">#{fmt(b.height, 0, locale)}</span>
                <span className="truncate text-[#8b93a1]">{String(b.hash || '').slice(0, 16)}…</span>
                <span className="text-[#c8d0db]">{t('mine.blocks.txs')} {(b.txs || []).length}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title={t('mine.how.title')}>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-[#aeb6c2]">
          <li>
            {t('mine.how.s1a')}{' '}
            <a href="/create-wallet">/create-wallet</a>{' '}
            {t('mine.how.s1b')}
          </li>
          <li>{t('mine.how.s2')}</li>
          <li>{t('mine.how.s3')}</li>
        </ol>
        <div className="mt-3 flex items-start gap-2 overflow-x-auto rounded-xl bg-[#0a0e13] p-4 font-mono text-[13px] text-[#c8d0db]">
          <pre className="flex-1">{`curl https://agentcoin.work/pool/stats\ncurl https://agentcoin.work/api/v1/info`}</pre>
          <Copy text={'curl https://agentcoin.work/pool/stats\ncurl https://agentcoin.work/api/v1/info'} />
        </div>
        <p className="mt-2 text-sm text-[#8b93a1]">{t('mine.how.reward')}</p>
      </Card>
    </div>
  );
}
