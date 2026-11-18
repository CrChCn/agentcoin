'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLang } from '@/lib/i18n';
import { Card } from '@/components/ui';

// Только файлы, реально лежащие в /docs на проде. Сырой md остаётся доступен
// напрямую (/docs/ФАЙЛ) для curl/агентов; здесь — та же побайтово версия в дизайне сайта.
const FILES = [
  'WHITEPAPER-AGENTS.md', 'WHAT-IS-AGT.md', 'README.md', 'PoUW-PLAN.md',
  'AGENT-HANDOFF.md', 'RUST-WALLET.md', 'SDK.md', 'SEED-NODES.md',
];

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s) {
  let h = esc(s);
  h = h.replace(/`([^`]+)`/g, '<code class="rounded bg-[#0a0e13] px-1 font-mono text-[13px] text-[#5ee6ff]">$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return h;
}

function renderMd(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let html = '', inList = false, inFence = false, fenceBuf = [];
  const closeList = () => { if (inList) { html += '</ul>'; inList = false; } };
  for (const ln of lines) {
    if (/^```/.test(ln)) {
      if (inFence) {
        html += '<pre class="overflow-x-auto rounded-xl bg-[#0a0e13] p-4 font-mono text-[13px] text-[#c8d0db]">' + esc(fenceBuf.join('\n')) + '</pre>';
        fenceBuf = []; inFence = false;
      } else { closeList(); inFence = true; }
      continue;
    }
    if (inFence) { fenceBuf.push(ln); continue; }
    let m;
    if ((m = ln.match(/^(#{1,3})\s+(.*)/))) {
      closeList();
      const lvl = m[1].length;
      html += `<h${lvl + 1} class="mt-4 font-extrabold text-[#e8b923]${lvl === 1 ? ' text-xl' : ''}">${inline(m[2])}</h${lvl + 1}>`;
    } else if (/^---+\s*$/.test(ln) || /^___+\s*$/.test(ln)) {
      closeList(); html += '<hr class="my-4 border-[#1c2530]" />';
    } else if ((m = ln.match(/^\s*[-*+]\s+(.*)/)) || (m = ln.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (!inList) { html += '<ul class="list-disc space-y-1 pl-5">'; inList = true; }
      html += '<li>' + inline(m[1]) + '</li>';
    } else if (/^\s*>+\s?(.*)/.test(ln)) {
      closeList();
      html += '<blockquote class="border-l-2 border-[#e8b923] pl-3 text-[#8b93a1]">' + inline(ln.replace(/^\s*>+\s?/, '')) + '</blockquote>';
    } else if (/^\s*$/.test(ln)) {
      closeList();
    } else {
      closeList();
      html += '<p class="my-2">' + inline(ln) + '</p>';
    }
  }
  closeList();
  return html;
}

function Viewer() {
  const sp = useSearchParams();
  const { lang } = useLang();
  const RU = lang === 'ru';
  const f = sp.get('f') || '';
  const [text, setText] = useState(null);
  const [err, setErr] = useState('');
  const ok = FILES.includes(f);
  useEffect(() => {
    if (!ok) return;
    let stop = false;
    (async () => {
      try {
        const r = await fetch('/docs/' + f, { cache: 'no-store' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const t = await r.text();
        if (!stop) setText(t);
      } catch (e) { if (!stop) setErr(String(e.message || e)); }
    })();
    return () => { stop = true; };
  }, [f, ok]);
  if (!ok) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-extrabold text-[#e8b923]">{RU ? 'Документация' : 'Documentation'}</h1>
        <Card title={RU ? 'Файл не найден' : 'File not found'}>
          <p className="text-sm text-[#aeb6c2]">{RU ? 'Доступны:' : 'Available:'}</p>
          <ul className="mt-2 space-y-1 font-mono text-sm">
            {FILES.map((x) => <li key={x}><a href={'/docs/view?f=' + x}>{x}</a></li>)}
          </ul>
        </Card>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="font-mono text-xs text-[#5c6672]"><a href="/docs">← {RU ? 'Документы' : 'Docs'}</a> · {f}</div>
      <h1 className="font-mono text-lg font-bold text-[#e8b923]">{f}</h1>
      <Card title={RU ? 'Текст документа (та же версия, что отдаёт /docs/' + f + ')' : 'Document text (same bytes as /docs/' + f + ')'}>
        {err && <div className="text-sm text-[#ef4444]">{err}</div>}
        {text == null && !err && <div className="text-sm text-[#5c6672]">…</div>}
        {text != null && (
          <div className="text-sm leading-relaxed text-[#c8d0db]" dangerouslySetInnerHTML={{ __html: renderMd(text) }} />
        )}
      </Card>
      <p className="font-mono text-xs text-[#5c6672]">
        {RU ? 'Сырец для curl/агентов: ' : 'Raw source for curl/agents: '}<a href={'/docs/' + f}>{'/docs/' + f}</a>
      </p>
    </div>
  );
}

export default function DocsView() {
  return (
    <Suspense>
      <Viewer />
    </Suspense>
  );
}
