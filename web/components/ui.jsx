'use client';
// DEDUP-20261118: шапка использует обычные <a> (полная перезагрузка с сервера).
// Клиентский Link перехватывал клик и показывал Next-главную по адресу /, тогда как
// сервер отдаёт / = imperial.html. Обычные ссылки убирают конкуренцию
// серверного и клиентского роутеров за один адрес (ТЗ §2, §5, §13).
import { usePathname } from 'next/navigation';
import { useLang } from '@/lib/i18n';

const NAV = [
  ['/', 'nav.home'], ['/mine', 'nav.mine'], ['/jobs', 'nav.jobs'], ['/mbc20', 'nav.mbc20'],
  ['/agent', 'nav.agent'], ['/docs', 'nav.docs'], ['/gov', 'nav.gov'], ['/shield', 'nav.shield'],
];

export function Header() {
  const { lang, setLang, t } = useLang();
  const path = usePathname();
  return (
    <header className="sticky top-0 z-50 border-b border-[#1c2530] bg-[#07090d]/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3">
        <a href="/" className="mr-2 flex items-center gap-2">
          <span className="text-xl">🪙</span>
          <span className="font-bold tracking-wide text-[#e8b923]">AGENTCOIN</span>
        </a>
        <nav className="flex flex-wrap gap-1 text-sm">
          {NAV.map(([href, k]) => (
            <a key={href} href={href}
              className={`rounded-lg px-2.5 py-1.5 ${path === href ? 'bg-[#1a2230] text-[#e8b923]' : 'text-[#aeb6c2] hover:bg-[#111927] hover:text-white'}`}>
              {t(k)}
            </a>
          ))}
          <a href="/stream"
            className={`rounded-lg px-2.5 py-1.5 ${path === '/stream' ? 'bg-[#1a2230] text-[#e8b923]' : 'text-[#aeb6c2] hover:bg-[#111927] hover:text-white'}`}>
            {t('nav.stream')}
          </a>
        </nav>
        <div className="ml-auto flex gap-1">
          {['ru', 'en'].map((l) => (
            <button key={l} onClick={() => setLang(l)}
              className={`rounded-lg px-2.5 py-1 text-xs font-bold ${lang === l ? 'bg-[#e8b923] text-black' : 'bg-[#141b26] text-[#8b93a1]'}`}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

export function Card({ title, children, right }) {
  return (
    <section className="rounded-2xl border border-[#1c2530] bg-[#10161f]/80 p-4 shadow-[0_8px_30px_rgba(0,0,0,.35)] backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-[#e8b923]">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Stale({ show, t }) {
  if (!show) return null;
  return <span className="rounded-full bg-[#3a2b00] px-2 py-0.5 text-[11px] text-[#ffd75e]">{t('stale')}</span>;
}

export function Donut({ parts }) {
  // parts: [{value, color}]
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  let acc = 0;
  const segs = parts.map((p) => {
    const frac = p.value / total;
    const s = { ...p, a0: acc * 2 * Math.PI - Math.PI / 2, a1: (acc + frac) * 2 * Math.PI - Math.PI / 2 };
    acc += frac;
    return s;
  });
  const R = 54, CX = 70, CY = 70;
  return (
    <svg viewBox="0 0 140 140" className="h-36 w-36">
      {segs.map((s, i) => {
        const large = s.a1 - s.a0 > Math.PI ? 1 : 0;
        const x0 = CX + R * Math.cos(s.a0), y0 = CY + R * Math.sin(s.a0);
        const x1 = CX + R * Math.cos(s.a1), y1 = CY + R * Math.sin(s.a1);
        if (s.a1 - s.a0 >= 2 * Math.PI - 0.001)
          return <circle key={i} cx={CX} cy={CY} r={R} fill="none" stroke={s.color} strokeWidth="20" />;
        return <path key={i} d={`M${CX},${CY} L${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} Z`} fill={s.color} opacity="0.9" />;
      })}
      <circle cx={CX} cy={CY} r={34} fill="#10161f" />
    </svg>
  );
}

export function Foot() {
  const { t } = useLang();
  return (
    <footer className="mx-auto max-w-6xl px-4 py-8 text-center text-xs text-[#5c6672]">
      AGENTCOIN · {t('foot.note')}
    </footer>
  );
}
