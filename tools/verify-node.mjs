#!/usr/bin/env node
// VERIFY-NODE: независимая приёмка живой ноды (issuer/кабинет/релиз), исполняется
// с ЛЮБОЙ машины (хост или VM). Используется:
//  · runbook рестарта 9336 (docs/RESTART-9336-RUNBOOK.md) — после подъёма ноды;
//  · CI — symlink-проверка честных негативов AGIP-45/46 на изолированной ноде;
//  · ручная проверка оператора: node tools/verify-node.mjs http://127.0.0.1:9335 [expectedFp]
// Выход: печатает построчно [ok]/[FAIL], код 0 = всё зелёное, 1 = есть провалы.
import { issuerFingerprint } from '../agent-identity.mjs';

const FP_SCHEME = /^sha256:[0-9a-f]{64}$/;

export async function verifyNode(baseUrl, { fetchFn = fetch, expectedFp = null, timeoutMs = 8000 } = {}) {
  const results = [];
  const push = (ok, name, detail) => { results.push({ ok: !!ok, name, detail: detail || '' }); return ok; };
  const call = async (method, route, body, headers = {}) => {
    const r = await fetchFn(baseUrl + route, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json };
  };

  // 1. Живость и честность цепи.
  try {
    const life = await call('GET', '/life');
    const j = life.json || {};
    push(life.status === 200 && j.chainValid === true, 'life chainValid=true', `blocks=${j.blocks} tipAge=${j.tipAgeSec}`);
    push(j.fresh === true, 'life fresh=true (tip свежий)', `tipAge=${j.tipAgeSec}s`);
  } catch (e) { push(false, 'life доступна', e.message); }

  // 2. Issuer: схема sha256:64hex + DER-согласованность issuerPub.
  try {
    const meta = await call('GET', '/identity/meta');
    const m = meta.json || {};
    const fp = m.issuerFingerprint;
    push(FP_SCHEME.test(fp || ''), 'identity issuerFingerprint схема sha256:64hex', String(fp));
    if (meta.status === 200 && FP_SCHEME.test(fp || '')) {
      try {
        push(issuerFingerprint(m.issuerPub) === fp, 'issuerFingerprint == DER(issuerPub) (схема совпадает с прожектной)', fp);
      } catch (e) { push(false, 'issuerFingerprint == DER(issuerPub)', e.message); }
      push(Array.isArray(m.trustedIssuers) && m.trustedIssuers.includes(fp),
        'issuerFingerprint в trustedIssuers (пин не отъехал от issuer)', (m.trustedIssuers || []).length + ' пинов');
      if (m.passportIssuerFingerprint !== undefined) {
        push(m.passportIssuerFingerprint === fp, 'passportIssuerFingerprint == issuerFingerprint (пин не устарел)', String(m.passportIssuerFingerprint));
      }
    }
    if (expectedFp) push(fp === expectedFp, `issuerFingerprint == ожиданию (${expectedFp.slice(0, 20)}…)`, String(fp));
  } catch (e) { push(false, 'identity/meta доступна', e.message); }

  // 3. Кабинет v2 (AGIP-45/46): страница + честные негативы маршрутов.
  try {
    const page = await call('GET', '/cabinet');
    const hasOps = page.text.includes('Операции (локальная подпись)');
    push(page.status === 200 && hasOps, 'cabinet v2 отдаётся (раздел «Операции (локальная подпись)»)', `HTTP ${page.status}`);
  } catch (e) { push(false, 'cabinet доступен', e.message); }
  try {
    const csrf = await call('POST', '/cabinet/autologin', {});
    push(csrf.status === 400 && csrf.json?.error === 'autologin_csrf_header_required',
      'autologin без CSRF-заголовка → 400 честно', JSON.stringify(csrf.json || {}).slice(0, 80));
  } catch (e) { push(false, 'autologin CSRF-негатив', e.message); }
  try {
    const alien = 'AGT1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9aa1';
    const op = await call('POST', '/cabinet/op-request', { address: alien });
    push(op.json?.error === 'session_invalid_or_foreign' || op.json?.error === 'bad_address',
      'op-request без живой сессии → честный отказ', JSON.stringify(op.json || {}).slice(0, 90));
  } catch (e) { push(false, 'op-request негатив', e.message); }

  // 4. Site-release идентифицирован.
  try {
    const rel = await call('GET', '/site/release');
    const rel2 = rel.json?.release || (rel.text.match(/site-v2-[0-9a-f]{16}/) || [])[0];
    push(/site-v2-[0-9a-f]{16}/.test(rel2 || ''), 'site/release отдаёт именованный release', String(rel2));
  } catch (e) { push(false, 'site/release', e.message); }

  return results;
}

export function printVerify(results) {
  let bad = 0;
  for (const r of results) {
    console.log(`[${r.ok ? 'ok' : 'FAIL'}] ${r.name}` + (r.detail ? ` → ${r.detail}` : ''));
    if (!r.ok) bad++;
  }
  return bad;
}

export async function runVerifyNode(baseUrl, opts) {
  const results = await verifyNode(baseUrl, opts);
  const bad = printVerify(results);
  return { ok: bad === 0, results, bad };
}

const invokedDirectly = process.argv[1] && /verify-node\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  const baseUrl = process.argv[2];
  if (!baseUrl || !/^https?:\/\/[^\s]+$/.test(baseUrl)) {
    console.error('usage: node tools/verify-node.mjs http://HOST:PORT [expectedIssuerFingerprint]');
    process.exitCode = 2;
  } else {
    const expected = process.argv[3] && FP_SCHEME.test(process.argv[3]) ? process.argv[3] : null;
    runVerifyNode(baseUrl, { expectedFp: expected }).then(({ ok }) => { process.exitCode = ok ? 0 : 1; });
  }
}
