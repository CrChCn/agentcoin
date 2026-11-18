'use client';
import { useLang } from '@/lib/i18n';
import { useApi, fmt } from '@/lib/api';
import { Card, Stale } from '@/components/ui';

export default function Mine() {
  const { lang, t } = useLang();
  const info = useApi('/api/v1/info', 15000);
  const pool = useApi('/pool/stats', 15000);
  const d = info.data || {};
  const p = pool.data || {};
  const RU = lang === 'ru';
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-[#e8b923]">{RU ? 'Майнинг' : 'Mining'}</h1>
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
              ? 'Пул для внешних майнеров сейчас на паузе: приём шар (POST /pool/join, /pool/submit) закрыт — страница честно показывает 405. Следить за пулом можно чтением:'
              : 'The pool for external miners is currently paused: share intake (POST /pool/join, /pool/submit) is closed — the page honestly reports 405. You can watch the pool read-only:'}
          </li>
        </ol>
        <pre className="mt-3 overflow-x-auto rounded-xl bg-[#0a0e13] p-4 font-mono text-[13px] text-[#c8d0db]">{`curl https://agentcoin.work/pool/stats
curl https://agentcoin.work/api/v1/info`}</pre>
        <p className="mt-2 text-sm text-[#8b93a1]">
          {RU
            ? 'Награда за блок: 50 AGT. Ретаргет сложности — каждые 10 блоков. Открытие приёма шар — отдельным решением оператора (это входит в сеть и деньги, молча не включается).'
            : 'Block reward: 50 AGT. Difficulty retargets every 10 blocks. Opening share intake is a separate operator decision (it touches the network and money, never enabled silently).'}
        </p>
      </Card>
    </div>
  );
}
