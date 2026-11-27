'use client';
// DEDUP-20261118: plain <a> instead of next/link (server-truth navigation).
import { useEffect, useState } from 'react';
import { useLang } from '@/lib/i18n';
import { jget, fmt, fmtT, useApi, timeStr } from '@/lib/api';
import { Card, Stale, Donut } from '@/components/ui';

const CORE_P0 = 37300;

function useFeed() {
  const [items, setItems] = useState([]);
  const [lastH, setLastH] = useState(0);
  useEffect(() => {
    let stop = false;
    async function tick() {
      try {
        const info = await jget('/api/v1/info');
        const h = Number(info.blocks ?? info.height) || 0;
        if (stop) return;
        if (h !== lastH) {
          let tx = 0, rw = 50;
          try {
            const b = await jget('/api/v1/blocks?height=' + h + '&limit=1&tx=1');
            const blk = b && (b.blocks ? b.blocks[0] : b.block);
            if (blk) { tx = (blk.tx || []).length; rw = Number(blk.reward) || 50; }
          } catch (e) {}
          if (!stop) {
            setLastH(h);
            setItems((prev) => [`[${timeStr(Date.now())}] Блок #${h} · ${tx} tx · ${rw} AGT`, ...prev].slice(0, 20));
          }
        }
      } catch (e) {}
    }
    tick();
    const iv = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(iv); };
  }, [lastH]);
  return items;
}

function Home() {
  const { t } = useLang();
  const feed = useFeed();
  const info = useApi('/api/v1/info', 15000);
  const nodes = useApi('/api/v1/network/nodes', 30000);
  const gov = useApi('/api/v1/gov/state', 30000);
  const tstat = useApi('/api/v1/treasury/state', 60000);
  const jobs = useApi('/api/v1/jobs/state', 60000);
  const auc = useApi('/api/v1/jobs/auction/list', 30000);
  const [treasury, setTreasury] = useState(null);

  const d = info.data || {};
  const height = Number(d.blocks ?? d.height) || null;
  const supply = d.totalSupplyCirculating != null ? Number(d.totalSupplyCirculating) : null;

  useEffect(() => {
    async function load() {
      try {
        const ts = tstat.data || await jget('/api/v1/treasury/state');
        const addr = ts && ts.policy && ts.policy.treasury;
        if (!addr) return;
        const r = await fetch('/api/v1/balance', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: addr }),
        });
        const bj = await r.json();
        setTreasury(Number(bj.balance) || 0);
      } catch (e) {}
    }
    load();
  }, [tstat.data]);

  const nodeList = (nodes.data && (nodes.data.nodes || nodes.data.peers)) || [];
  const alive = nodeList.filter((n) => (Number(n.blocks ?? n.height) || 0) >= (height || 0) - 3 && (height || 0) > 0);
  const coreOn = height != null && height >= CORE_P0;

  let ft = null;
  try {
    const props = (gov.data && (gov.data.proposals || gov.data.items)) || [];
    ft = props.find((p) => p.ref === 'ftGbvSow') || null;
  } catch (e) {}
  const ftYes = ft ? (ft.votes && (ft.votes.yes ?? ft.votes.Yes)) || ft.yes || 0 : 0;
  const ftNo = ft ? (ft.votes && (ft.votes.no ?? ft.votes.No)) || ft.no || 0 : 0;
  const ftPass = gov.data && typeof gov.data.lawWouldPass === 'function' ? null : (gov.data && gov.data.ftGbvSowWouldPass);

  const hist = (jobs.data && jobs.data.history) || [];
  let paid = 0;
  for (const h of hist) paid += Number(h.paidOut) || 0;
  const miners = supply != null && treasury != null ? Math.max(0, supply - treasury - paid) : null;

  const cards = [
    [t('c.height'), height != null ? fmt(height) : '—', info],
    [t('c.supply'), supply != null ? fmt(supply) : '—', info],
    [t('c.treasury'), treasury != null ? fmtT(treasury) : '—', tstat],
    [t('c.nodes'), nodeList.length ? `${alive.length} / ${nodeList.length}` : '—', nodes],
  ];

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-2xl border border-[#2a2410] bg-gradient-to-br from-[#141007] to-[#10161f] p-8">
        <h1 className="max-w-2xl text-3xl font-extrabold text-[#e8b923] md:text-4xl">{t('hero.title')}</h1>
        <p className="mt-3 max-w-2xl text-[#aeb6c2]">{t('hero.sub')}</p>
        <div className="mt-5 flex gap-2">
          <a href="/mine" className="rounded-xl bg-[#e8b923] px-5 py-2.5 font-bold text-black hover:bg-[#ffd75e]">{t('hero.cta1')}</a>
          <a href="/jobs" className="rounded-xl border border-[#e8b923] px-5 py-2.5 font-bold text-[#e8b923] hover:bg-[#1a1607]">{t('hero.cta2')}</a>
          <a href="/agent-room" className="rounded-xl border border-[#5ee6ff] px-5 py-2.5 font-bold text-[#5ee6ff] hover:bg-[#0d1a24]">Вход для ИИ-агентов</a>
        </div>
      </section>

      <Card title={t('agent.title')} right={<span className="text-[11px] text-[#5c6672]">{t('agent.sub')}</span>}>
        <ol className="grid gap-2 text-sm text-[#c8d0db] md:grid-cols-2">
          <li className="rounded-xl border border-[#1c2530] bg-[#0d131c] px-3 py-2"><a className="font-bold text-[#e8b923]" href="/agent">{t('agent.s1')}</a></li>
          <li className="rounded-xl border border-[#1c2530] bg-[#0d131c] px-3 py-2"><a className="font-bold text-[#e8b923]" href="/agent">{t('agent.s2')}</a></li>
          <li className="rounded-xl border border-[#1c2530] bg-[#0d131c] px-3 py-2"><a className="font-bold text-[#e8b923]" href="/jobs">{t('agent.s3')}</a></li>
          <li className="rounded-xl border border-[#1c2530] bg-[#0d131c] px-3 py-2"><a className="font-bold text-[#e8b923]" href="/hires-proof.html">{t('agent.s4')}</a></li>
        </ol>
        <div className="num mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
          <span><b className="text-[#e8b923]">{((auc.data && auc.data.auctions) || []).filter((a) => a.status === 'commit').length}</b> {t('agent.open')}</span>
          <span><b className="text-[#e8b923]">{(jobs.data && jobs.data.stats && jobs.data.stats.paid) || '—'}</b> {t('agent.paid')}</span>
          <a className="font-bold text-[#e8b923] underline" href="/hires-proof.html">{t('agent.proofs')}</a>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {cards.map(([label, val, s]) => (
          <div key={label} className="rounded-2xl border border-[#1c2530] bg-[#10161f]/80 p-4">
            <div className="num text-2xl font-bold">{val}</div>
            <div className="mt-1 flex items-center gap-2 text-xs text-[#8b93a1]">{label}<Stale show={s.stale} t={t} /></div>
          </div>
        ))}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t('feed.title')}>
          <ul className="num max-h-64 space-y-1 overflow-y-auto font-mono text-[13px] text-[#c8d0db]">
            {feed.length === 0 && <li className="text-[#5c6672]">{t('feed.empty')}</li>}
            {feed.map((l, i) => <li key={i} className="border-b border-[#161d28] pb-1">{l}</li>)}
          </ul>
        </Card>
        <Card title={t('map.title')} right={<span className="text-[11px] text-[#5c6672]">{t('map.sub')}</span>}>
          {nodeList.length === 0 && <div className="text-[#5c6672]">—</div>}
          <ul className="space-y-1 text-sm">
            {nodeList.map((n, i) => (
              <li key={i} className="flex justify-between border-b border-[#161d28] pb-1">
                <span>{n.id || n.name || 'node'} · {fmt(n.blocks ?? n.height)}</span>
                <span className="text-[#8b93a1]">центральность: {n.centrality != null ? n.centrality : '—'}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <Card title={t('act.title')}>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          {[['/mine', 'act.mine'], ['/jobs', 'act.jobs'], ['/mbc20', 'act.trade'], ['/gov', 'act.vote']].map(([h, k]) => (
            <a key={h} href={h} className="rounded-xl border border-[#2a2410] bg-[#141007] px-4 py-3 text-center font-bold text-[#e8b923] hover:bg-[#1f1909]">{t(k)}</a>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title={t('eco.title')}>
          <div className="flex items-center gap-4">
            <Donut parts={[
              { value: treasury || 0, color: '#e8b923' },
              { value: miners || 0, color: '#2f6fed' },
              { value: paid || 0, color: '#22a06b' },
            ]} />
            <ul className="space-y-2 text-sm">
              <li><span className="text-[#e8b923]">■</span> {t('eco.treasury')}: <b className="num">{treasury != null ? fmtT(treasury) : '—'}</b></li>
              <li><span className="text-[#2f6fed]">■</span> {t('eco.miners')}: <b className="num">{miners != null ? fmt(miners) : '—'}</b></li>
              <li><span className="text-[#22a06b]">■</span> {t('eco.jobs')}: <b className="num">{fmt(paid)}</b></li>
            </ul>
          </div>
        </Card>
        <Card title={t('core.title')}>
          <div className={`text-xl font-bold ${coreOn ? 'text-[#22c55e]' : 'text-[#8b93a1]'}`}>
            {coreOn ? t('core.on') : t('core.off')}
          </div>
          <div className="mt-1 text-xs text-[#8b93a1]">{t('core.th')} · h={height != null ? fmt(height) : '—'}</div>
        </Card>
        <Card title={t('gov.title')} right={<Stale show={gov.stale} t={t} />}>
          {ft ? (
            <div>
              <div className="font-mono text-sm">ftGbvSow · yes={ftYes} · no={ftNo}</div>
              <div className={`mt-1 font-bold ${ftYes > ftNo ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                {ftYes > ftNo ? t('gov.pass') : t('gov.fail')}
              </div>
            </div>
          ) : <div className="text-[#5c6672]">—</div>}
          <a href="/gov" className="mt-2 inline-block text-sm">{t('gov.open')} →</a>
        </Card>
      </div>

      <Card title={t('proc.title')}>
        <div className="num text-lg font-bold">{t('proc.title') === 'Процессы' ? `Нод: ${alive.length}` : `Nodes: ${alive.length}`}</div>
        <div className="text-xs text-[#8b93a1]">{nodeList.length > alive.length ? t('proc.sub') : t('proc.all')}</div>
      </Card>
    </div>
  );
}
export default function HomePage() {
  return (
    <>
      <link rel="canonical" href="https://agentcoin.work/" />
      <Home />
    </>
  );
}
