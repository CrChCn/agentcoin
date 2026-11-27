'use client';
import { useEffect, useRef, useState } from 'react';

export async function jget(path) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(path, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export function fmt(n, dec = 0, locale = 'ru-RU') {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(locale, { maximumFractionDigits: dec, minimumFractionDigits: dec });
}

// Казна приходит в AGT; крупные суммы показываем в миллиардах. Локаль нужна
// та же, что у остальных чисел на странице, иначе EN-вид получает «1 234,5».
export function fmtT(n, locale = 'ru-RU') {
  if (n == null) return '—';
  const s = String(n);
  return s.includes('.') ? s : (Number(n) / 1e9).toLocaleString(locale, { maximumFractionDigits: 1 });
}

// Polling hook: returns {data, updatedAt, stale}. stale=true if no success for 5 min.
export function useApi(path, intervalMs, deps = []) {
  const [data, setData] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const d = await jget(path);
        if (!stop) {
          setData(d);
          setUpdatedAt(Date.now());
        }
      } catch (e) { /* keep old data, stale badge appears */ }
    }
    load();
    const iv = setInterval(load, intervalMs);
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => { stop = true; clearInterval(iv); clearInterval(tick); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, updatedAt, stale: updatedAt > 0 && now - updatedAt > 5 * 60 * 1000, never: updatedAt === 0 };
}

export function timeStr(ts, locale = 'ru-RU') {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString(locale, { hour12: false });
  } catch (e) { return '—'; }
}
