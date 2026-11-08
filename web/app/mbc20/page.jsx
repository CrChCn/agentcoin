'use client';
import { useState } from 'react';
import { useLang } from '@/lib/i18n';
import { useApi, fmt } from '@/lib/api';
import { Card, Stale } from '@/components/ui';

const HEX40 = /^[0-9a-fA-F]{40}$/;

export default function Mbc20() {
  const { lang, t } = useLang();
  const RU = lang === 'ru';
  const tk = useApi('/api/v1/mbc20/tokens', 30000);
  const tokens = (tk.data && (tk.data.tokens || tk.data.list)) || [];
  const [addr, setAddr] = useState('');
  const [bal, setBal] = useState(null);
  const [err, setErr] = useState('');
  const [dep, setDep] = useState({ sym: '', name: '', supply: '' });
  const [depRes, setDepRes] = useState('');

  async function check(e) {
    e.preventDefault();
    setErr(''); setBal(null);
    if (!HEX40.test(addr.trim())) { setErr(t('err.addr')); return; }
    try {
      const r = await fetch('/api/v1/balance', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: addr.trim() }),
      });
      const j = await r.json();
      setBal(j.balance);
    } catch (e2) { setErr(String(e2.message || e2)); }
  }

  async function deploy(e) {
    e.preventDefault();
    setDepRes('');
    try {
      const r = await fetch('/api/v1/mbc20/deploy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: dep.sym, name: dep.name, supply: Number(dep.supply) }),
      });
      const j = await r.json();
      setDepRes(JSON.stringify(j).slice(0, 300));
    } catch (e2) { setDepRes(String(e2.message || e2)); }
  }

  const inp = 'w-full rounded-xl border border-[#232d3b] bg-[#0a0e13] px-3 py-2 font-mono text-sm';
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-extrabold text-[#e8b923]">MBC-20 {RU ? 'Биржа' : 'Exchange'}</h1>
      <Card title={RU ? 'Токены' : 'Tokens'} right={<Stale show={tk.stale} t={t} />}>
        {tokens.length === 0 ? <div className="text-[#5c6672]">—</div> : (
          <ul className="space-y-1 font-mono text-sm">
            {tokens.map((x, i) => <li key={i}>{x.symbol || x.sym} · {x.name || ''} · {fmt(x.supply ?? x.totalSupply)}</li>)}
          </ul>
        )}
      </Card>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title={RU ? 'Проверить баланс' : 'Check balance'}>
          <form onSubmit={check} className="flex flex-col gap-2">
            <input className={inp} value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="40 hex…" />
            <button className="rounded-xl bg-[#e8b923] px-4 py-2 font-bold text-black">{RU ? 'Проверить' : 'Check'}</button>
          </form>
          {err && <div className="mt-2 text-sm text-[#ef4444]">{err}</div>}
          {bal != null && <div className="num mt-2">{fmt(bal)} AGT</div>}
        </Card>
        <Card title={RU ? 'Эмиссия токена' : 'Deploy token'}>
          <form onSubmit={deploy} className="flex flex-col gap-2">
            <input className={inp} value={dep.sym} onChange={(e) => setDep({ ...dep, sym: e.target.value })} placeholder="SYM" />
            <input className={inp} value={dep.name} onChange={(e) => setDep({ ...dep, name: e.target.value })} placeholder="Name" />
            <input className={inp} value={dep.supply} onChange={(e) => setDep({ ...dep, supply: e.target.value })} placeholder="Supply" />
            <button className="rounded-xl bg-[#e8b923] px-4 py-2 font-bold text-black">{RU ? 'Выпустить' : 'Deploy'}</button>
          </form>
          {depRes && <div className="mt-2 break-all font-mono text-xs text-[#8b93a1]">{depRes}</div>}
        </Card>
      </div>
    </div>
  );
}
