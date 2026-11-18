'use client';
import { useState } from 'react';
import { useLang } from '@/lib/i18n';
import { jget } from '@/lib/api';
import { normAddr } from '@/lib/addr';
import { Card } from '@/components/ui';


export default function Agent() {
  const { lang, t } = useLang();
  const RU = lang === 'ru';
  const [addr, setAddr] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const inp = 'w-full rounded-xl border border-[#232d3b] bg-[#0a0e13] px-3 py-2 font-mono text-sm';

  async function verify(e) {
    e.preventDefault();
    setErr(''); setRes(null);
    const n = normAddr(addr);
    if (!n.ok) { setErr(t('err.addr')); return; }
    try {
      const j = await jget('/api/v1/trust?address=' + n.address);
      setRes(j);
    } catch (e2) { setErr(String(e2.message || e2)); }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-[#e8b923]">{RU ? 'Агент' : 'Agent'}</h1>
      <Card title={RU ? 'Паспорт агента (DS-доверие)' : 'Agent passport (DS trust)'}>
        <form onSubmit={verify} className="flex flex-col gap-2">
          <input className={inp} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="AGT… (40 hex)" />
          <button className="rounded-xl bg-[#e8b923] px-4 py-2 font-bold text-black">{RU ? 'Проверить' : 'Verify'}</button>
        </form>
        {err && <div className="mt-2 text-sm text-[#ef4444]">{err}</div>}
        {res && <pre className="mt-2 overflow-x-auto rounded-xl bg-[#0a0e13] p-3 font-mono text-xs">{JSON.stringify(res, null, 1).slice(0, 1500)}</pre>}
      </Card>
    </div>
  );
}
