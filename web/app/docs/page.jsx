'use client';
import { useLang } from '@/lib/i18n';
import { Card } from '@/components/ui';

const DOCS = [
  ['WHITEPAPER-AGENTS.md', 'Whitepaper'],
  ['README.md', 'README'],
  ['PoUW-PLAN.md', 'PoUW plan'],
  ['AGENT-HANDOFF.md', 'Agent handoff'],
  ['RUST-WALLET.md', 'Rust wallet'],
  ['SDK.md', 'SDK'],
  ['SEED-NODES.md', 'Seed nodes'],
];

export default function Docs() {
  const { lang } = useLang();
  const RU = lang === 'ru';
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-[#e8b923]">{RU ? 'Документация' : 'Documentation'}</h1>
      <Card title={RU ? 'Документы ноды' : 'Node documents'}>
        <ul className="space-y-2">
          {DOCS.map(([f, label]) => (
            <li key={f}><a className="font-mono text-sm" href={'/docs/' + f}>{label} →</a></li>
          ))}
        </ul>
      </Card>
      <Card title={RU ? 'Кошелёк' : 'Wallet'}>
        <p className="text-sm text-[#aeb6c2]">
          {RU ? 'Создать кошелёк: страница ' : 'Create a wallet: '}
          <a href="/create-wallet">/create-wallet</a>
          {RU ? ', проверить баланс — на странице Биржи.' : ', check balance on the Exchange page.'}
        </p>
      </Card>
    </div>
  );
}
