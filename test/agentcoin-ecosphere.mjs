#!/usr/bin/env node
/* Ecosphere pass-1: браузерное ядро не смешивает логику, блокирует мутации без signed, XSS-чисто. */
import assert from 'node:assert';
import { makeBrowserClient, escHtml, shortAddr } from '../sdk/js/agentcoin-browser.mjs';

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log('ok ' + n + ' ' + m); };

// XSS
ok(escHtml('<script>alert(1)</script>').includes('&lt;script&gt;'), 'xss escaped');
ok(shortAddr('abcdef123456').endsWith('…'), 'short addr');

// signed unsupported блокирует без signer и без auto-fallback
{
  const fake = async () => ({ status: 404, json: async () => ({}) });
  const c = makeBrowserClient({ apiBase: 'http://x', fetchImpl: fake, signer: null });
  const r = await c.mutate({ action: 'order', endpoint: '/orders/create', body: {} });
  ok(r.error === 'signed_unsupported', 'no signed -> explicit block, no legacy');
}
// wrong network блокирует
{
  let seq = 0;
  const fake = async (url) => {
    seq++;
    const j = (o) => ({ status: 200, json: async () => o });
    if (String(url).includes('auth-capabilities')) return j({ signed: true, chain: 'AGENTCOIN', genesis: 'gen-A' });
    if (String(url).includes('/info')) return j({ genesisHash: 'gen-A' });
    return j({});
  };
  const c = makeBrowserClient({ apiBase: 'http://x', fetchImpl: fake, signer: { sign: async () => { throw new Error('must not be called'); } } });
  const r = await c.mutate({ action: 'order', endpoint: '/orders/create', body: {}, expectedGenesis: 'gen-B' });
  ok(r.blocked === true && r.reason === 'wrong_network', 'foreign genesis blocks mutation');
}
// stale marking
{
  const fake = async (url) => {
    if (String(url).includes('auth-capabilities')) return { status: 404, json: async () => ({}) };
    return { status: 500, json: async () => ({}) };
  };
  const c = makeBrowserClient({ apiBase: 'http://x', fetchImpl: fake });
  const s = await c.status('A');
  ok(s.stale === true, 'failed read marked stale');
}
// no keystore in browser core source
{
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../sdk/js/agentcoin-browser.mjs', import.meta.url), 'utf8');
  ok(!src.includes("from 'node:fs'") && !src.includes('from "node:fs"') && !src.includes('privateKeyPem'), 'browser core has no fs/keystore');
}
console.log(`ecosphere PASS ${n}/${n}`);
