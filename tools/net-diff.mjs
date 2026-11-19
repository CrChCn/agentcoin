#!/usr/bin/env node
// net-diff.mjs — Этап 2: сравнение ожидаемого (реестр) с наблюдаемым (сбор).
// Формирует JSON + Markdown: компонент → ожидалось → наблюдалось → доказательство → вывод.
// Высоты сравниваются с учётом времени опроса; общий номер блока решает «лаг vs форк».
// Прокси-ответ резерва (данные node1) явно помечается как НЕ доказательство локального состояния.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BLOCK_INTERVAL_SEC } from './net-collect.mjs';

export function diff(reg, observations) {
  const obs = Array.isArray(observations) ? observations : [];
  const byId = new Map();
  for (const o of obs) {
    if (!o || typeof o.checkId !== 'string') continue;
    if (!byId.has(o.componentId)) byId.set(o.componentId, []);
    byId.get(o.componentId).push(o);
  }
  const rows = [];
  const unavailable = [];
  const unknown = [];
  const notChecked = [];

  for (const c of (reg.components || [])) {
    if (!c || typeof c.componentId !== 'string') continue;
    const list = byId.get(c.componentId) || [];
    const ok = list.filter((o) => o.status === 'ok').length;
    const mm = list.filter((o) => o.status === 'mismatch');
    const un = list.filter((o) => o.status === 'unavailable');
    const unk = list.filter((o) => o.status === 'unknown');
    const nc = list.filter((o) => o.status === 'not_checked');
    for (const o of un) unavailable.push(o);
    for (const o of unk) unknown.push(o);
    for (const o of nc) notChecked.push(o);
    let verdict = 'unknown';
    let note = '';
    if (!list.length) { verdict = 'not_checked'; note = 'наблюдений нет (цели не заданы или сбор не покрыл)'; }
    else if (mm.length) { verdict = 'mismatch'; note = mm.map((o) => `${o.checkId}: ${o.error}`).join('; ').slice(0, 500); }
    else if (ok && !un.length && !unk.length) { verdict = 'match'; note = `${ok}/${list.length} ok`; }
    else if (ok) { verdict = 'partial'; note = `${ok}/${list.length} ok, unavailable=${un.length} unknown=${unk.length}`; }
    else if (un.length && !ok) { verdict = 'unavailable'; note = un.map((o) => `${o.checkId}: ${o.error}`).join('; ').slice(0, 300); }
    rows.push({
      componentId: c.componentId,
      expected: { expected: c.expected || null, chain: c.chain ? { chainId: c.chain.chainId, genesis: c.chain.genesis } : null, routes: (c.routes || []).filter((r) => r && r.owner === true).map((r) => `${r.method || 'GET'} ${r.host}${r.path}`) },
      observed: list.map((o) => ({ checkId: o.checkId, status: o.status, observedValue: o.observedValue, error: o.error, evidenceFile: o.evidenceFile, startedAt: o.startedAt, completedAt: o.completedAt })),
      verdict, note,
      proof: list.map((o) => o.evidenceFile).filter(Boolean),
    });
  }

  // --- главный дефект мониторинга: локальные ответы vs публичный монитор ---
  const monitor = { comparedAt: new Date().toISOString(), locals: {}, public: null, conclusion: '', proxySuspect: false, commonBlock: null };
  const findObs = (cid, suffix) => (byId.get(cid) || []).find((o) => o.checkId === `${cid}:${suffix}` && o.status === 'ok');
  for (const cid of ['mainnet-node-1', 'mainnet-node-2', 'mainnet-node-3']) {
    const o = findObs(cid, 'local-info') || (byId.get(cid) || []).find((x) => /local-info/.test(x.checkId));
    monitor.locals[cid] = o
      ? { status: o.status, blocks: o.observedValue?.blocks ?? null, tipHash: o.observedValue?.tipHash ?? null, chainId: o.observedValue?.chainId ?? null, genesis: o.observedValue?.genesisHash || o.observedValue?.genesis || null, error: o.error, evidenceFile: o.evidenceFile, startedAt: o.startedAt, completedAt: o.completedAt }
      : { status: 'missing', error: 'no local-info observation' };
  }
  const pubNodes = (byId.get('node-monitor') || []).find((o) => o.checkId === 'node-monitor:pub-nodes');
  if (pubNodes && pubNodes.status === 'ok') {
    monitor.public = { status: 'ok', observedValue: pubNodes.observedValue, evidenceFile: pubNodes.evidenceFile, startedAt: pubNodes.startedAt, completedAt: pubNodes.completedAt };
  } else if (pubNodes) {
    monitor.public = { status: pubNodes.status, error: pubNodes.error, evidenceFile: pubNodes.evidenceFile };
  }
  // Общий блок: сверка одного номера высоты по всем локальным.
  const commons = obs.filter((o) => /:common-block-\d+$/.test(o.checkId || ''));
  if (commons.length) {
    const hashes = {};
    for (const o of commons) {
      const v = o.observedValue || {};
      const h = v.tipHash || (Array.isArray(v.blocks) && v.blocks[0] && (v.blocks[0].hash || v.blocks[0].tipHash)) || JSON.stringify(v).slice(0, 64);
      hashes[o.componentId] = { status: o.status, hash: h, error: o.error, evidenceFile: o.evidenceFile };
    }
    const okH = Object.values(hashes).filter((x) => x.status === 'ok').map((x) => x.hash);
    monitor.commonBlock = {
      height: (commons[0].checkId.match(/common-block-(\d+)/) || [])[1] || null,
      hashes,
      sameChain: okH.length >= 2 ? okH.every((h) => h === okH[0]) : null,
    };
  }
  // Вывод: допуск дрейфа по времени опроса.
  try {
    const ts = [];
    for (const cid of ['mainnet-node-1', 'mainnet-node-2', 'mainnet-node-3']) {
      const l = monitor.locals[cid];
      if (l && Number.isSafeInteger(l.blocks)) ts.push({ cid, blocks: l.blocks, tip: l.tipHash, at: l.completedAt });
    }
    if (ts.length >= 2) {
      const hs = ts.map((t) => t.blocks);
      const spread = Math.max(...hs) - Math.min(...hs);
      const times = ts.map((t) => Date.parse(t.at)).filter(Number.isFinite);
      const pollSec = times.length >= 2 ? Math.max(0, (Math.max(...times) - Math.min(...times)) / 1000) : 0;
      const allowance = Math.ceil(pollSec / BLOCK_INTERVAL_SEC) + 1;
      const tips = new Set(ts.map((t) => t.tip).filter(Boolean));
      if (monitor.commonBlock && monitor.commonBlock.sameChain === true) {
        monitor.conclusion = `COMMON-BLOCK MATCH at height ${monitor.commonBlock.height}: разброс вершин ${spread} — лаг догона, не форк.`;
      } else if (monitor.commonBlock && monitor.commonBlock.sameChain === false) {
        monitor.conclusion = `FORK SIGNAL at height ${monitor.commonBlock.height}: хэши общего блока различаются — расхождение цепей.`;
        monitor.proxySuspect = false;
      } else if (spread <= allowance) {
        monitor.conclusion = `DRIFT-OK: разброс высот ${spread} при допуске ${allowance} (опрос ${Math.round(pollSec)}с, интервал блока ~${BLOCK_INTERVAL_SEC}с). Разные tipHash растущих вершин — не форк без сверки общего блока.`;
      } else {
        monitor.conclusion = `DRIFT-WARN: разброс высот ${spread} превышает допуск ${allowance} (опрос ${Math.round(pollSec)}с). Требуется сверка общего блока; вершины: ${ts.map((t) => `${t.cid}=${t.blocks}`).join(', ')}.`;
      }
      void tips;
    } else {
      monitor.conclusion = 'INSUFFICIENT: локальных высот меньше двух — сравнение невозможно, см. unavailable/unknown.';
    }
  } catch (e) {
    monitor.conclusion = `COMPARE-ERROR: ${String((e && e.message) || e).slice(0, 200)}`;
  }
  // Петля монитора (E23): публичный ответ резерва повторяет node1 вместо локального состояния.
  // Признак: публичный tip резерва == локальный tip node1 при отличающемся локальном tip резерва.
  try {
    const n1 = monitor.locals['mainnet-node-1'];
    for (const cid of ['mainnet-node-2', 'mainnet-node-3']) {
      const local = monitor.locals[cid];
      const pub = (byId.get(cid) || []).find((o) => /:pub-(info|health)$/.test(o.checkId) && o.observedValue && Number.isSafeInteger(o.observedValue.blocks));
      if (!pub || !local || local.status !== 'ok') continue;
      const pubTip = pub.observedValue.tipHash;
      if (n1 && n1.status === 'ok' && pubTip && n1.tipHash && pubTip === n1.tipHash && local.tipHash && pubTip !== local.tipHash) {
        monitor.proxySuspect = true;
        monitor.conclusion += ` PROXY-LOOP: публичный ответ ${cid} (${pub.checkId}) повторяет tip node1 (${String(pubTip).slice(0, 12)}…), локальный tip резерва иной (${String(local.tipHash).slice(0, 12)}…) — публичный монитор показывает node1 вместо резервов. Доказательства: ${pub.evidenceFile || '—'} vs ${local.evidenceFile || '—'}.`;
      }
    }
    if (!monitor.proxySuspect && monitor.public && monitor.public.status === 'ok') {
      monitor.proxyNote = 'Публичный /network/nodes получен; явного расхождения «резерв-публично == node1 при ином локальном» не зафиксировано.';
    }
  } catch { /* ignore */ }

  return { rows, unavailable, unknown, notChecked, monitor };
}

export function renderMarkdown(reg, observations, d) {
  const L = [];
  L.push('# Этап 2 — отчёт расхождений (реестр vs наблюдение)');
  L.push('');
  L.push(`- registry: v${reg.version} updatedAt=${reg.updatedAt} chain=${reg.chain?.network}/${String(reg.chain?.genesis || '').slice(0, 8)}…`);
  L.push(`- наблюдений: ${observations.length}; вердикты: ` + ['match', 'partial', 'mismatch', 'unavailable', 'unknown', 'not_checked'].map((v) => `${v}=${d.rows.filter((r) => r.verdict === v).length}`).join(' '));
  L.push(`- Старые evidence (E01–E25) за новый опрос НЕ выдаются: доказательства — только evidenceFile ниже.`);
  L.push('');
  L.push('## 1. Монитор: локальные ответы vs публичный /network/nodes');
  L.push(`- conclusion: ${d.monitor.conclusion}`);
  for (const cid of ['mainnet-node-1', 'mainnet-node-2', 'mainnet-node-3']) {
    const l = d.monitor.locals[cid];
    L.push(`- ${cid} local: status=${l.status} blocks=${l.blocks ?? '—'} tip=${l.tipHash ? String(l.tipHash).slice(0, 12) + '…' : '—'} err=${l.error || '—'} proof=${l.evidenceFile || '—'}`);
  }
  L.push(`- public /network/nodes: status=${d.monitor.public ? d.monitor.public.status : 'missing'} err=${(d.monitor.public && d.monitor.public.error) || '—'} proof=${(d.monitor.public && d.monitor.public.evidenceFile) || '—'}`);
  if (d.monitor.commonBlock) {
    L.push(`- common-block height=${d.monitor.commonBlock.height} sameChain=${d.monitor.commonBlock.sameChain}`);
    for (const [cid, h] of Object.entries(d.monitor.commonBlock.hashes)) {
      L.push(`  - ${cid}: status=${h.status} hash=${String(h.hash || '').slice(0, 32)}… err=${h.error || '—'}`);
    }
  } else {
    L.push('- common-block: нет (понадобится при DRIFT-WARN или споре о форке)');
  }
  L.push('- Петля E23: если публичные записи node2/node3 повторяют tip/height node1 при отличающихся локальных — публичный монитор показывает node1 вместо резервов. Конфиги и монитор не менялись (этап 2 — только чтение).');
  L.push('');
  L.push('## 2. Компоненты: ожидалось → наблюдалось → доказательство → вывод');
  for (const r of d.rows) {
    L.push(`### ${r.componentId} [${r.verdict}]`);
    L.push(`- ожидалось: ${JSON.stringify(r.expected.expected || r.expected)}`);
    L.push(`- наблюдалось: ${r.observed.length ? '' : '—'}`);
    for (const o of r.observed.slice(0, 12)) {
      L.push(`  - ${o.checkId}: ${o.status} err=${o.error || '—'} val=${JSON.stringify(o.observedValue || {}).slice(0, 300)} proof=${o.evidenceFile || '—'}`);
    }
    if (r.observed.length > 12) L.push(`  - … ещё ${r.observed.length - 12} наблюдений (см. diff.json)`);
    L.push(`- вывод: ${r.note}`);
  }
  L.push('');
  L.push(`## 3. Недоступные проверки (${d.unavailable.length})`);
  for (const o of d.unavailable) L.push(`- ${o.checkId} [${o.componentId}] err=${o.error || '—'} src=${o.sourceEndpoint}`);
  if (!d.unavailable.length) L.push('- нет');
  L.push('');
  L.push(`## 4. Неизвестные (${d.unknown.length}) и не проверявшиеся (${d.notChecked.length})`);
  for (const o of d.unknown) L.push(`- unknown ${o.checkId} [${o.componentId}] err=${o.error || '—'} src=${o.sourceEndpoint}`);
  for (const o of d.notChecked) L.push(`- not_checked ${o.checkId} [${o.componentId}] err=${o.error || '—'} src=${o.sourceEndpoint}`);
  if (!d.unknown.length && !d.notChecked.length) L.push('- нет');
  L.push('');
  return L.join('\n') + '\n';
}

const isMain = (() => { try { return import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href; } catch { return false; } })();
if (isMain) {
  const obsFile = process.argv[2];
  const outFile = process.argv[3] || null;
  if (!obsFile) { console.error('usage: node tools/net-diff.mjs <observations.json> [out.md] [--registry <reg>]'); process.exit(2); }
  let regFile = null;
  const ri = process.argv.indexOf('--registry');
  if (ri >= 0) regFile = process.argv[ri + 1];
  const here = path.dirname(fileURLToPath(import.meta.url));
  const reg = JSON.parse(fs.readFileSync(regFile || path.resolve(here, '..', 'config', 'unified-registry.json'), 'utf8'));
  const raw = JSON.parse(fs.readFileSync(obsFile, 'utf8'));
  const observations = Array.isArray(raw) ? raw : raw.observations;
  const d = diff(reg, observations);
  fs.writeFileSync(path.join(path.dirname(obsFile), 'diff.json'), JSON.stringify(d, null, 1));
  const md = renderMarkdown(reg, observations, d);
  if (outFile) fs.writeFileSync(outFile, md);
  else process.stdout.write(md);
}
