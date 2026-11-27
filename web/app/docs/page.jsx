'use client';
import { useLang } from '@/lib/i18n';
import { Card } from '@/components/ui';

// Только файлы, реально лежащие в /docs (сырцы для curl/агентов).
// Чтение — через стилизованный просмотрщик /docs/view?f= (та же побайтово версия).
const DOCS = [
  ['WHITEPAPER-AGENTS.md', 'Whitepaper'],
  ['WHAT-IS-AGT.md', 'Что такое AGT'],
  ['README.md', 'README'],
  ['PoUW-PLAN.md', 'PoUW plan'],
  ['AGENT-HANDOFF.md', 'Agent handoff'],
  ['RUST-WALLET.md', 'Rust wallet'],
  ['SDK.md', 'SDK'],
  ['SEED-NODES.md', 'Seed nodes'],
];

export default function Docs() {
  const { t } = useLang();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-[#e8b923]">{t('docs.title')}</h1>
      <Card title={t('docs.node.title')}>
        <ul className="space-y-2">
          {DOCS.map(([f, label]) => (
            <li key={f}><a className="font-mono text-sm" href={'/docs/view?f=' + f}>{label} →</a></li>
          ))}
        </ul>
      </Card>
      <Card title={t('docs.wallet.title')}>
        <p className="text-sm text-[#aeb6c2]">
          {t('docs.wallet.s1')} <a href="/create-wallet">/create-wallet</a>{t('docs.wallet.s2')}
        </p>
      </Card>
    </div>
  );
}
