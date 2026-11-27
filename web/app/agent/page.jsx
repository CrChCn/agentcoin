'use client';
import { useState } from 'react';
import { useLang } from '@/lib/i18n';
import { jget } from '@/lib/api';
import { normAddr } from '@/lib/addr';
import { Card } from '@/components/ui';

function KV({ k, v, good }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-[#8b93a1]">{k}</span>
      <b className={good ? 'text-[#39d98a]' : 'text-[#e8eef1]'}>{v}</b>
    </div>
  );
}

export default function Agent() {
  const { t } = useLang();
  const [addr, setAddr] = useState('');
  const [trust, setTrust] = useState(null);
  const [state, setState] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const inp = 'w-full rounded-xl border border-[#232d3b] bg-[#0a0e13] px-3 py-2 font-mono text-sm focus:border-[#e8b923] focus:outline-none';

  async function verify(e) {
    e.preventDefault();
    setErr(''); setTrust(null); setState(null);
    const n = normAddr(addr);
    if (!n.ok) { setErr(t('err.addr')); return; }
    setLoading(true);
    try {
      const [tr, st] = await Promise.all([
        jget('/api/v1/trust?address=' + n.address),
        jget('/agent-state?address=' + n.address).catch(() => null),
      ]);
      setTrust(tr); setState(st);
    } catch (e2) { setErr(String(e2.message || e2)); }
    setLoading(false);
  }

  const m = (trust && trust.mass) || {};
  const newcomer = trust && (trust.reviews || 0) === 0;

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-[#2a2410] bg-gradient-to-br from-[#141007] to-[#10161f] p-6 shadow-[0_0_40px_rgba(232,185,35,.08)]">
        <p className="text-xs font-bold uppercase tracking-[.2em] text-[#e8b923]">{t('agentpage.badge')}</p>
        <h1 className="mt-1 bg-gradient-to-b from-[#f5cf4d] to-[#d4af37] bg-clip-text text-3xl font-extrabold text-transparent md:text-4xl" style={{ filter: 'drop-shadow(0 0 18px rgba(212,175,55,.35))' }}>
          {t('agentpage.title')}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[#aeb6c2]">{t('agentpage.intro')}</p>
        <ol className="mt-3 grid gap-2 text-[13px] text-[#aeb6c2] md:grid-cols-2">
          <li><b className="text-[#e8b923]">1.</b> {t('agentpage.s1')}</li>
          <li><b className="text-[#e8b923]">2.</b> {t('agentpage.s2')}</li>
          <li><b className="text-[#e8b923]">3.</b> {t('agentpage.s3')}</li>
          <li><b className="text-[#e8b923]">4.</b> {t('agentpage.s4')} <a className="text-[#5aa2ff] underline" href="/agent-room">/agent-room</a>.</li>
        </ol>
      </section>

      <Card title={t('agentpage.checkTitle')}>
        <form onSubmit={verify} className="flex flex-col gap-2 md:flex-row">
          <input className={inp} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="AGT… (40 hex)" autoComplete="off" spellCheck="false" />
          <button disabled={loading} className="rounded-xl bg-gradient-to-b from-[#f5cf4d] to-[#d4af37] px-4 py-2 font-bold text-black shadow-[0_0_16px_rgba(212,175,55,.35)] disabled:opacity-50">
            {loading ? '…' : t('agentpage.verify')}
          </button>
        </form>
        {err && <div className="mt-2 text-sm text-[#ef4444]">{err}</div>}
      </Card>

      {trust && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title={t('agentpage.passportTitle')}>
            {state ? (
              <div className="font-mono text-[13px]">
                <KV k={t('agentpage.address')} v={String(state.address || '').slice(0, 12) + '…' + String(state.address || '').slice(-6)} />
                <KV k={t('agentpage.passport')} v={state.passport || '?'} good={state.passport && state.passport !== 'none'} />
                <KV k="gate" v={state.gate || '?'} />
                <KV k={t('agentpage.queue')} v={state.queue && state.queue.position != null ? `${t('agentpage.position')} ${state.queue.position}` : t('agentpage.notQueued')} />
                <KV k={t('agentpage.assignment')} v={(state.assignment && (state.assignment.jobId || state.assignment.id)) || '—'} />
                <KV k="nextAction" v={state.nextAction || '?'} good />
              </div>
            ) : <div className="text-sm text-[#8b93a1]">{t('agentpage.stateNA')}</div>}
          </Card>
          <Card title={t('agentpage.trustTitle')}>
            <div className="mb-2">
              <span className={`rounded-full px-3 py-1 font-mono text-xs font-bold ${newcomer ? 'bg-[#1a2230] text-[#8b93a1]' : 'bg-[#0b2e1f] text-[#39d98a] shadow-[0_0_12px_rgba(57,217,138,.35)]'}`}>
                {newcomer ? t('agentpage.newcomer') : t('agentpage.hasHistory')}
              </span>
            </div>
            <div className="font-mono text-[13px]">
              <KV k={t('agentpage.interval')} v={Array.isArray(trust.interval) ? trust.interval.join(' – ') : '?'} />
              <KV k={t('agentpage.mass')} v={`${m.t ?? '?'} / ${m.u ?? '?'} / ${m.i ?? '?'}`} />
              <KV k={t('agentpage.reviews')} v={trust.reviews ?? '?'} />
              <KV k={t('agentpage.paid')} v={trust.paid ?? '?'} good={(trust.paid || 0) > 0} />
              <KV k={t('agentpage.refunded')} v={trust.refunded ?? '?'} />
              <KV k={t('agentpage.open')} v={trust.open ?? '?'} />
            </div>
            {trust.sources && trust.sources.length > 0 && (
              <div className="mt-2 border-t border-[#161d28] pt-2">
                <div className="mb-1 text-xs text-[#8b93a1]">{t('agentpage.sources')}:</div>
                <ul className="space-y-1 font-mono text-xs text-[#8b93a1]">
                  {trust.sources.map((s, i) => (
                    <li key={i}>· {s.name} <span className="text-[#5c6672]">{s.mass ? `${s.mass.t ?? 0}/${s.mass.u ?? 0}/${s.mass.i ?? 0}` : ''}</span></li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
