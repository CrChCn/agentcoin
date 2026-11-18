'use client';
import { useState } from 'react';
import { useLang } from '@/lib/i18n';
import { useApi, fmt, jget } from '@/lib/api';
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
  const { lang, t } = useLang();
  const info = useApi('/api/v1/info', 15000);
  const pool = useApi('/pool/stats', 15000);
  const feed = useApi('/blocks?n=8', 20000);
  const [probe, setProbe] = useState(null);
  const [probing, setProbing] = useState(false);
  const d = info.data || {};
  const p = pool.data || {};
  const RU = lang === 'ru';

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
        <p className="text-xs font-bold uppercase tracking-[.2em] text-[#e8b923]">⚒ Agentcoin · {RU ? 'Шахта' : 'Mine'} v0.2</p>
        <h1 className="mt-1 bg-gradient-to-b from-[#f5cf4d] to-[#d4af37] bg-clip-text text-3xl font-extrabold text-transparent md:text-4xl" style={{ filter: 'drop-shadow(0 0 18px rgba(212,175,55,.35))' }}>
          {RU ? 'Майнинг' : 'Mining'}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-[#aeb6c2]">
          {RU
            ? 'Пул для внешних майнеров сейчас на паузе: приём шар закрыт, и страница показывает это честно. Всё ниже — живое чтение с настоящей сети, без ключа.'
            : 'The pool for external miners is paused: share intake is closed, and this page says so honestly. Everything below is live read-only data from the real network, no key needed.'}
        </p>
        <ol className="mt-3 grid gap-2 text-[13px] text-[#aeb6c2] md:grid-cols-2">
          <li><b className="text-[#e8b923]">1.</b> {RU ? 'Создай кошелёк и получи AGT-адрес — он же твой miner id.' : 'Create a wallet to get an AGT address — also your miner id.'}</li>
          <li><b className="text-[#e8b923]">2.</b> {RU ? 'Соло-майнинг идёт только на ноде оператора.' : 'Solo mining runs on the operator node only.'}</li>
          <li><b className="text-[#e8b923]">3.</b> {RU ? 'Пул на паузе: шар не принимаются (405). Нажми «проверить приём» и убедись сам.' : 'Pool paused: shares are refused (405). Hit “probe intake” and see for yourself.'}</li>
          <li><b className="text-[#e8b923]">4.</b> {RU ? 'Открытие приёма шар — отдельное решение оператора (деньги сети).' : 'Opening intake is a separate operator decision (network money).'}</li>
        </ol>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card title={RU ? 'Высота' : 'Height'} right={<Stale show={info.stale} t={t} />}>
          <div className="num text-2xl font-bold">{(d.blocks ?? d.height) != null ? fmt(d.blocks ?? d.height) : '—'}</div>
        </Card>
        <Card title={RU ? 'Сложность/таргет' : 'Difficulty/target'}>
          <div className="num break-all font-mono text-sm">{d.target || d.difficulty || (d.difficultyBits != null ? 'bits ' + d.difficultyBits : '—')}</div>
        </Card>
        <Card title="Mempool">
          <div className="num text-2xl font-bold">{d.mempool != null ? fmt(d.mempool) : (d.mempoolSize != null ? fmt(d.mempoolSize) : '—')}</div>
        </Card>
        <Card title={RU ? 'Пул (шары)' : 'Pool (shares)'} right={<Stale show={pool.stale} t={t} />}>
          <div className="num text-2xl font-bold">{p.miners != null ? fmt(p.miners) : '—'}</div>
          <div className="mt-1 font-mono text-xs text-[#8b93a1]">
            shares {p.shares != null ? fmt(p.shares) : '—'} · shareDiffBits {p.shareDiffBits ?? '—'}
          </div>
        </Card>
      </div>

      <Card title={RU ? 'Статус приёма шар — проверь сам' : 'Share intake status — probe it yourself'}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-3 py-1 text-sm font-bold ${paused ? 'bg-[#3a2b00] text-[#ffd75e] shadow-[0_0_14px_rgba(232,185,35,.35)]' : 'bg-[#0b2e1f] text-[#39d98a]'}`}>
            {paused ? (RU ? '◌ приём закрыт (пауза)' : '◌ intake closed (paused)') : (RU ? '● приём открыт' : '● intake open')}
          </span>
          <button onClick={probeJoin} disabled={probing}
            className="rounded-lg bg-gradient-to-b from-[#f5cf4d] to-[#d4af37] px-3 py-1.5 text-sm font-bold text-black shadow-[0_0_16px_rgba(212,175,55,.35)] disabled:opacity-50">
            {probing ? '…' : (RU ? 'проверить приём ↻' : 'probe intake ↻')}
          </button>
        </div>
        {probe && (
          <div className="mt-2 rounded-xl bg-[#0a0e13] p-3 font-mono text-[13px]">
            <span className={probe.status === 405 ? 'text-[#ffd75e]' : 'text-[#39d98a]'}>HTTP {probe.status}</span>
            <span className="text-[#8b93a1]"> — {probe.status === 405
              ? (RU ? 'приём закрыт оператором, шар не уходят в никуда' : 'intake closed by operator, no shares go nowhere')
              : probe.body}</span>
          </div>
        )}
        <p className="mt-2 text-sm text-[#8b93a1]">
          {RU
            ? 'Проба — безопасна: закрытый маршрут отвечает 405 и ничего не принимает. Открытие приёма — отдельным словом оператора.'
            : 'Probing is safe: the closed route answers 405 and accepts nothing. Opening intake needs the operator’s explicit word.'}
        </p>
      </Card>

      <Card title={RU ? 'Последние блоки — живьём' : 'Recent blocks — live'} right={<Stale show={feed.stale} t={t} />}>
        {blocks.length === 0 ? (
          <div className="text-sm text-[#8b93a1]">—</div>
        ) : (
          <ol className="grid gap-2 md:grid-cols-2">
            {blocks.slice(0, 8).map((b) => (
              <li key={b.hash || b.height} className="flex items-center justify-between gap-2 rounded-xl border border-[#223145] bg-[#0d141f] px-3 py-2 font-mono text-xs">
                <span className="text-[#e8b923]">#{fmt(b.height)}</span>
                <span className="truncate text-[#8b93a1]">{String(b.hash || '').slice(0, 16)}…</span>
                <span className="text-[#c8d0db]">tx {(b.txs || []).length}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card title={RU ? 'Как майнить' : 'How to mine'}>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-[#aeb6c2]">
          <li>
            {RU ? 'Создай кошелёк и получи AGT-адрес: ' : 'Create a wallet to get an AGT address: '}
            <a href="/create-wallet">/create-wallet</a>
            {RU ? ' (адрес вида AGT + 40 hex — он же miner для пула).' : ' (an AGT + 40 hex address — also your pool miner id).'}
          </li>
          <li>
            {RU ? 'Соло-майнинг идёт только на ноде оператора (внешний POST /mine закрыт).' : 'Solo mining runs on the operator node only (external POST /mine is closed).'}
          </li>
          <li>
            {RU
              ? 'Пул для внешних майнеров сейчас на паузе: приём шар (POST /pool/join, /pool/submit) закрыт. Следить за пулом можно чтением:'
              : 'The pool for external miners is currently paused: share intake (POST /pool/join, /pool/submit) is closed. You can watch the pool read-only:'}
          </li>
        </ol>
        <div className="mt-3 flex items-start gap-2 overflow-x-auto rounded-xl bg-[#0a0e13] p-4 font-mono text-[13px] text-[#c8d0db]">
          <pre className="flex-1">{`curl https://agentcoin.work/pool/stats\ncurl https://agentcoin.work/api/v1/info`}</pre>
          <Copy text={'curl https://agentcoin.work/pool/stats\ncurl https://agentcoin.work/api/v1/info'} />
        </div>
        <p className="mt-2 text-sm text-[#8b93a1]">
          {RU
            ? 'Награда за блок: 50 AGT. Ретаргет сложности — каждые 10 блоков. Открытие приёма шар — отдельным решением оператора (это деньги сети, молча не включается).'
            : 'Block reward: 50 AGT. Difficulty retargets every 10 blocks. Opening share intake is a separate operator decision (network money, never enabled silently).'}
        </p>
      </Card>
    </div>
  );
}
