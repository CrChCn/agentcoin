'use client';
import { useLang } from '@/lib/i18n';
import { useApi, fmt } from '@/lib/api';
import { Card, Stale } from '@/components/ui';

export default function Mine() {
  const { lang, t } = useLang();
  const info = useApi('/api/v1/info', 15000);
  const d = info.data || {};
  const RU = lang === 'ru';
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-[#e8b923]">{RU ? 'Майнинг' : 'Mining'}</h1>
      <div className="grid gap-4 md:grid-cols-3">
        <Card title={RU ? 'Высота' : 'Height'} right={<Stale show={info.stale} t={t} />}>
          <div className="num text-2xl font-bold">{(d.blocks ?? d.height) != null ? fmt(d.blocks ?? d.height) : '—'}</div>
        </Card>
        <Card title={RU ? 'Сложность/таргет' : 'Difficulty/target'}>
          <div className="num break-all font-mono text-sm">{d.target || d.difficulty || '—'}</div>
        </Card>
        <Card title="Mempool">
          <div className="num text-2xl font-bold">{d.mempool != null ? fmt(d.mempool) : (d.mempoolSize != null ? fmt(d.mempoolSize) : '—')}</div>
        </Card>
      </div>
      <Card title={RU ? 'Как майнить' : 'How to mine'}>
        <pre className="overflow-x-auto rounded-xl bg-[#0a0e13] p-4 font-mono text-[13px] text-[#c8d0db]">{`git clone https://github.com/agentcoin && cd agentcoin
cargo run --release --bin miner -- --node 127.0.0.1:9335 --address YOUR_40HEX`}</pre>
        <p className="mt-2 text-sm text-[#8b93a1]">
          {RU ? 'Награда за блок: 50 AGT. Сложность пересчитывается каждые 2016 блоков.' : 'Block reward: 50 AGT. Difficulty retargets every 2016 blocks.'}
        </p>
      </Card>
    </div>
  );
}
