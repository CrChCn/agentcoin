#!/usr/bin/env node
// net-diff.mjs — Этап 2: сравнение ожидаемого (реестр) с наблюдаемым (сбор).
// Формирует JSON + Markdown: компонент → ожидалось → наблюдалось → доказательство → вывод.
// Высоты сравниваются с учётом времени опроса; общий номер блока решает «лаг vs форк».
// Прокси-ответ резерва (данные node1) явно помечается как НЕ доказательство локального состояния.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BLOCK_INTERVAL_SEC, HEX64_RE, unifyLocalState } from './net-collect.mjs';

export const MONITOR_STALE_SEC = 180;

function isPubCheck(o) {
  return /:pub-/.test(o.checkId) || /:caps/.test(o.checkId);
}
function isLocalCheck(o) {
  return /:local-/.test(o.checkId) || /:proc-/.test(o.checkId) || /:files-sha/.test(o.checkId)
    || /:listen/.test(o.checkId) || /:common-block-\d+/.test(o.checkId);
}

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
    // Пропущенные обязательные проверки исключают полный match.
    let verdict = 'unknown';
    let note = '';
    const pubL = list.filter(isPubCheck);
    const locL = list.filter(isLocalCheck);
    const pubOk = pubL.filter((o) => o.status === 'ok').length;
    const locOk = locL.filter((o) => o.status === 'ok').length;
    const coverage = `public=${pubOk}/${pubL.length} local=${locOk}/${locL.length} skipped=${nc.length} unavailable=${un.length} unknown=${unk.length}`;
    if (!list.length) { verdict = 'not_checked'; note = 'наблюдений нет (цели не заданы или сбор не покрыл)'; }
    else if (mm.length) { verdict = 'mismatch'; note = mm.map((o) => `${o.checkId}: ${o.error}`).join('; ').slice(0, 500) + ` | ${coverage}`; }
    else if (ok === list.length) { verdict = 'match'; note = `${ok}/${list.length} ok | ${coverage}`; }
    else if (ok > 0) {
      verdict = 'partial';
      note = `${ok}/${list.length} ok, not_checked=${nc.length} unavailable=${un.length} unknown=${unk.length} | ${coverage}. Доступность публичных маршрутов и исправность ноды — разные выводы: см. public vs local.`;
    }
    else if (un.length && !unk.length && !nc.length) { verdict = 'unavailable'; note = un.map((o) => `${o.checkId}: ${o.error}`).join('; ').slice(0, 300) + ` | ${coverage}`; }
    else if (nc.length && !un.length && !unk.length) { verdict = 'not_checked'; note = `все ${nc.length} пропущены: ` + nc.map((o) => `${o.checkId}: ${o.error}`).join('; ').slice(0, 300) + ` | ${coverage}`; }
    else if (unk.length && !un.length && !nc.length) { verdict = 'unknown'; note = unk.map((o) => `${o.checkId}: ${o.error}`).join('; ').slice(0, 300) + ` | ${coverage}`; }
    else if (un.length) { verdict = 'unavailable'; note = `ok=0, unavailable=${un.length} unknown=${unk.length} not_checked=${nc.length} | ${coverage}`; }
    else { verdict = un.length ? 'unavailable' : (unk.length ? 'unknown' : 'not_checked'); note = coverage; }
    rows.push({
      componentId: c.componentId,
      expected: { expected: c.expected || null, chain: c.chain ? { chainId: c.chain.chainId, genesis: c.chain.genesis } : null, routes: (c.routes || []).filter((r) => r && r.owner === true).map((r) => `${r.method || 'GET'} ${r.host}${r.path}`) },
      observed: list.map((o) => ({ checkId: o.checkId, status: o.status, observedValue: o.observedValue, error: o.error, evidenceFile: o.evidenceFile, startedAt: o.startedAt, completedAt: o.completedAt })),
      verdict, note, coverage,
      proof: list.map((o) => o.evidenceFile).filter(Boolean),
    });
  }

  // --- монитор: локальные ответы vs публичный /network/nodes ---
  const monitor = { comparedAt: new Date().toISOString(), locals: {}, public: null, conclusion: '', proxySuspect: false, commonBlock: null, nodeCompare: [], proxyNote: '' };
  const findObs = (cid, suffix) => (byId.get(cid) || []).find((o) => o.checkId === `${cid}:${suffix}` && o.status === 'ok');
  // fix5: единое локальное представление: blocks+tipHeight из local-info,
  // tipHash из local-health иначе local-ws-status иначе local-life, с sources.
  for (const cid of ['mainnet-node-1', 'mainnet-node-2', 'mainnet-node-3']) {
    const compObs = byId.get(cid) || [];
    const u = unifyLocalState(compObs, cid);
    const info = compObs.find((o) => o.checkId === `${cid}:local-info`);
    const tipSrcId = (u.sources && u.sources.tipHash) || null;
    const tipObs = tipSrcId ? compObs.find((o) => o.checkId === tipSrcId) : null;
    const primary = (info && info.status === 'ok') ? info : (tipObs && tipObs.status === 'ok' ? tipObs : (compObs.find((o) => /:local-(info|health|ws-status|life)$/.test(o.checkId)) || null));
    if (u.blocks !== null && u.tipHeight !== null) {
      monitor.locals[cid] = {
        status: 'ok', blocks: u.blocks, tipHeight: u.tipHeight, tipHash: u.tipHash,
        chainId: u.chainId, genesis: u.genesis, tipAgeSec: u.tipAgeSec ?? null, sources: u.sources,
        error: u.tipHash ? null : 'local_tip_missing: no valid tipHash in local-health/ws-status/life',
        evidenceFile: info?.evidenceFile || null, tipEvidenceFile: tipObs?.evidenceFile || null,
        startedAt: primary?.startedAt || null, completedAt: primary?.completedAt || null,
      };
    } else {
      monitor.locals[cid] = {
        status: info ? info.status : 'missing', blocks: null, tipHeight: null, tipHash: u.tipHash,
        chainId: u.chainId, genesis: u.genesis, tipAgeSec: null, sources: u.sources,
        error: info ? (info.error || 'no local blocks>=1 in local-info') : 'no local-info observation',
        evidenceFile: info?.evidenceFile || null, tipEvidenceFile: null,
        startedAt: primary?.startedAt || null, completedAt: primary?.completedAt || null,
      };
    }
  }
  const pubNodes = (byId.get('node-monitor') || []).find((o) => o.checkId === 'node-monitor:pub-nodes');
  if (pubNodes && pubNodes.status === 'ok') {
    monitor.public = { status: 'ok', observedValue: pubNodes.observedValue, evidenceFile: pubNodes.evidenceFile, startedAt: pubNodes.startedAt, completedAt: pubNodes.completedAt };
  } else if (pubNodes) {
    monitor.public = { status: pubNodes.status, error: pubNodes.error, evidenceFile: pubNodes.evidenceFile };
  }
  // Общий блок: сверка одного номера высоты по всем локальным. Только валидные хэши.
  const commons = obs.filter((o) => /:common-block-\d+$/.test(o.checkId || ''));
  if (commons.length) {
    const hashes = {};
    for (const o of commons) {
      const v = o.observedValue || {};
      let h = null;
      let heightOk = false;
      const want = Number((o.checkId.match(/common-block-(\d+)/) || [])[1]);
      if (o.status === 'ok' && typeof v.hash === 'string' && HEX64_RE.test(v.hash) && Number.isSafeInteger(v.height) && v.height === want) {
        h = v.hash.toLowerCase();
        heightOk = true;
      } else {
        h = null;
      }
      hashes[o.componentId] = { status: o.status, hash: h, heightOk, height: v.height ?? null, requestedHeight: want, error: o.error, evidenceFile: o.evidenceFile };
    }
    const valid = Object.values(hashes).filter((x) => x.status === 'ok' && x.hash && x.heightOk).map((x) => x.hash);
    monitor.commonBlock = {
      height: (commons[0].checkId.match(/common-block-(\d+)/) || [])[1] || null,
      hashes,
      validCount: valid.length,
      sameChain: valid.length >= 2 ? valid.every((h) => h === valid[0]) : null,
    };
  }
  // Сопоставление записей монитора с локальными нодами.
  try {
    const entries = monitor.public && monitor.public.status === 'ok' && Array.isArray(monitor.public.observedValue?.nodes)
      ? monitor.public.observedValue.nodes : null;
    const pick = (pred) => (entries || []).find(pred) || null;
    const selfEntry = entries ? (pick((n) => /эта нода|node1|self/i.test(String(n.name || ''))) || entries[0]) : null;
    const n2Entry = entries ? pick((n) => /node2/i.test(String(n.name || ''))) : null;
    const n3Entry = entries ? pick((n) => /node3/i.test(String(n.name || ''))) : null;
    const map = { 'mainnet-node-1': selfEntry, 'mainnet-node-2': n2Entry, 'mainnet-node-3': n3Entry };
    // fix5: tipHash:null никогда не DIVERGENT; без сравнимого хэша — INSUFFICIENT;
    // расхождение времени больше допуска — STALE.
    for (const cid of ['mainnet-node-1', 'mainnet-node-2', 'mainnet-node-3']) {
      const local = monitor.locals[cid];
      const entry = map[cid];
      const base = {
        componentId: cid,
        localBlocks: local?.blocks ?? null, localTipHeight: local?.tipHeight ?? null, localTip: local?.tipHash ?? null,
        localSources: local?.sources ?? null,
        monitorBlocks: entry?.blocks ?? null, monitorTip: entry?.tipHash ?? null,
        at: local?.completedAt ?? null,
      };
      if (!entry) {
        monitor.nodeCompare.push({ ...base, result: 'INSUFFICIENT', reason: 'no monitor entry' });
        continue;
      }
      if (!local || local.status !== 'ok' || !Number.isSafeInteger(local.blocks) || local.tipHeight === null) {
        monitor.nodeCompare.push({ ...base, result: 'INSUFFICIENT', reason: `local ${local?.status || 'missing'}: no comparable blocks/tipHeight`, localError: local?.error || null });
        continue;
      }
      if (typeof local.tipHash !== 'string' || !HEX64_RE.test(local.tipHash)) {
        monitor.nodeCompare.push({ ...base, result: 'INSUFFICIENT', reason: 'local_tip_missing: no valid tipHash in local-health/ws-status/life', localError: local.error || null });
        continue;
      }
      if (!Number.isSafeInteger(entry.blocks)) {
        monitor.nodeCompare.push({ ...base, result: 'INSUFFICIENT', reason: 'monitor blocks missing' });
        continue;
      }
      if (typeof entry.tipHash !== 'string' || !HEX64_RE.test(entry.tipHash)) {
        monitor.nodeCompare.push({ ...base, result: 'INSUFFICIENT', reason: 'monitor tip missing' });
        continue;
      }
      const lt = Date.parse(local.completedAt);
      const pt = Date.parse(monitor.public?.completedAt || monitor.public?.startedAt);
      let dtSec = null;
      if (Number.isFinite(lt) && Number.isFinite(pt)) dtSec = Math.abs(lt - pt) / 1000;
      const blocksEqual = entry.blocks === local.blocks;
      const tipEqual = String(entry.tipHash).toLowerCase() === String(local.tipHash).toLowerCase();
      if (dtSec !== null && dtSec > MONITOR_STALE_SEC) {
        monitor.nodeCompare.push({
          ...base, result: 'STALE', reason: `time_separated ${Math.round(dtSec)}s > ${MONITOR_STALE_SEC}s`,
          blocksEqual, tipEqual, dtSec: Math.round(dtSec),
          monitorStatus: entry.status ?? null, monitorReachable: entry.reachable ?? null,
        });
        continue;
      }
      if (blocksEqual && tipEqual) {
        monitor.nodeCompare.push({
          ...base, result: 'CONSISTENT', reason: 'comparable height+hash match within time window',
          blocksEqual, tipEqual, dtSec,
          monitorStatus: entry.status ?? null, monitorReachable: entry.reachable ?? null,
        });
      } else {
        monitor.nodeCompare.push({
          ...base, result: 'DIVERGENT', reason: 'comparable values differ',
          blocksEqual, tipEqual, dtSec,
          monitorStatus: entry.status ?? null, monitorReachable: entry.reachable ?? null,
        });
      }
    }
  } catch (e) {
    monitor.nodeCompare.push({ componentId: '*', result: 'INSUFFICIENT', reason: `compare-error ${String((e && e.message) || e).slice(0, 120)}` });
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
      if (monitor.commonBlock && monitor.commonBlock.sameChain === true) {
        monitor.conclusion = `COMMON-BLOCK MATCH at height ${monitor.commonBlock.height}: same hash on ${monitor.commonBlock.validCount} nodes for that historic height; does not prove absence of divergence above it. Разброс вершин ${spread} — отдельно.`;
      } else if (monitor.commonBlock && monitor.commonBlock.sameChain === false) {
        monitor.conclusion = `FORK SIGNAL at height ${monitor.commonBlock.height}: хэши общего блока различаются — расхождение цепей на этой высоте.`;
        monitor.proxySuspect = false;
      } else if (spread <= allowance) {
        monitor.conclusion = `DRIFT-OK: разброс высот ${spread} при допуске ${allowance} (опрос ${Math.round(pollSec)}с, интервал блока ~${BLOCK_INTERVAL_SEC}с). Различия tipHash растущих вершин сами по себе inconclusive: требуется сверка общего блока, чтобы отличить лаг от форка.`;
      } else {
        monitor.conclusion = `DRIFT-WARN: разброс высот ${spread} превышает допуск ${allowance} (опрос ${Math.round(pollSec)}с). Требуется сверка общего блока; вершины: ${ts.map((t) => `${t.cid}=${t.blocks}`).join(', ')}.`;
      }
    } else {
      monitor.conclusion = 'INSUFFICIENT: локальных высот меньше двух — сравнение невозможно, см. unavailable/unknown.';
    }
  } catch (e) {
    monitor.conclusion = `COMPARE-ERROR: ${String((e && e.message) || e).slice(0, 200)}`;
  }
  // Подмена монитора (E23): запись резерва повторяет node1 при отличающемся локальном tip.
  // Совпадение вершин само по себе НЕ доказывает проксирование: требуем время, общий блок
  // и подтверждённый маршрут источника. Иначе — INSUFFICIENT/SUSPECT, а не LOOP.
  try {
    const n1 = monitor.locals['mainnet-node-1'];
    const times = [];
    for (const cid of ['mainnet-node-1', 'mainnet-node-2', 'mainnet-node-3']) {
      const t = Date.parse(monitor.locals[cid]?.completedAt);
      if (Number.isFinite(t)) times.push(t);
    }
    const pollSpreadSec = times.length >= 2 ? (Math.max(...times) - Math.min(...times)) / 1000 : 0;
    const timeOk = pollSpreadSec <= 180;
    for (const cid of ['mainnet-node-2', 'mainnet-node-3']) {
      const local = monitor.locals[cid];
      const cmp = monitor.nodeCompare.find((x) => x.componentId === cid);
      if (!cmp || cmp.result === 'INSUFFICIENT') continue;
      if (!local || local.status !== 'ok' || !n1 || n1.status !== 'ok') continue;
      if (!local.tipHash || !n1.tipHash || !cmp.monitorTip) continue;
      const monitorEqualsN1 = cmp.monitorTip === n1.tipHash && cmp.monitorBlocks === n1.blocks;
      const localDiffersN1 = local.tipHash !== n1.tipHash;
      if (monitorEqualsN1 && localDiffersN1) {
        if (!timeOk) {
          monitor.proxyNote = (monitor.proxyNote ? monitor.proxyNote + ' ' : '') + `SUSPECT-TIME: запись ${cid} повторяет node1, но опросы разнесены на ${Math.round(pollSpreadSec)}с — inconclusive.`;
          continue;
        }
        if (monitor.commonBlock && monitor.commonBlock.sameChain === true) {
          monitor.proxySuspect = true;
          monitor.conclusion += ` PROXY-LOOP: запись ${cid} в /network/nodes повторяет tip/height node1 (${String(n1.tipHash).slice(0, 12)}…/${n1.blocks}), локальный tip резерва иной (${String(local.tipHash).slice(0, 12)}…/${local.blocks}); общий блок совпал — расхождение именно в подаче монитора. Маршрут источника подтверждён: ${pubNodes?.evidenceFile || '—'}.`;
        } else if (monitor.commonBlock && monitor.commonBlock.sameChain === false) {
          monitor.conclusion += ` DIVERGENCE (не прокси-вывод): общий блок различается — цепи разошлись, совпадение записи ${cid} с node1 требует отдельной проверки.`;
        } else {
          monitor.conclusion += ` PROXY-SUSPECT (unconfirmed): запись ${cid} повторяет node1 при ином локальном tip; общего блока нет — вывод о проксировании premature, требуется common-block.`;
        }
      }
    }
    if (!monitor.proxySuspect && monitor.public && monitor.public.status === 'ok' && !/PROXY/.test(monitor.conclusion)) {
      const insuf = monitor.nodeCompare.filter((x) => x.result === 'INSUFFICIENT').length;
      monitor.proxyNote = `Публичный /network/nodes получен; прямых расхождений «резерв==node1 при ином локальном» не зафиксировано. INSUFFICIENT записей: ${insuf}. Совпадение вершин само по себе проксирование не доказывает.`;
    }
    if ((!monitor.public || monitor.public.status !== 'ok')) {
      monitor.proxyNote = `INSUFFICIENT: публичный /network/nodes недоступен (${monitor.public?.status || 'missing'}) — сопоставление невозможно.`;
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
  L.push(`- match = все наблюдения ok; любые not_checked/unavailable/unknown исключают match (partial). Публичные маршруты и исправность ноды — разные выводы (см. coverage).`);
  L.push('');
  L.push('## 1. Монитор: локальные ответы vs публичный /network/nodes');
  L.push(`- conclusion: ${d.monitor.conclusion}`);
  if (d.monitor.proxyNote) L.push(`- proxy-note: ${d.monitor.proxyNote}`);
  for (const cid of ['mainnet-node-1', 'mainnet-node-2', 'mainnet-node-3']) {
    const l = d.monitor.locals[cid];
    L.push(`- ${cid} local: status=${l.status} blocks=${l.blocks ?? '—'} tipHeight=${l.tipHeight ?? '—'} tip=${l.tipHash ? String(l.tipHash).slice(0, 12) + '…' : '—'} src=${l.sources ? JSON.stringify(l.sources) : '—'} err=${l.error || '—'} proof=${l.evidenceFile || '—'}`);
  }
  L.push(`- public /network/nodes: status=${d.monitor.public ? d.monitor.public.status : 'missing'} err=${(d.monitor.public && d.monitor.public.error) || '—'} proof=${(d.monitor.public && d.monitor.public.evidenceFile) || '—'}`);
  for (const nc of (d.monitor.nodeCompare || [])) {
    L.push(`- compare ${nc.componentId}: ${nc.result} local=${nc.localBlocks ?? '—'}/${nc.localTip ? String(nc.localTip).slice(0, 12) + '…' : '—'} monitor=${nc.monitorBlocks ?? '—'}/${nc.monitorTip ? String(nc.monitorTip).slice(0, 12) + '…' : '—'}${nc.reason ? ` reason=${nc.reason}` : ''}`);
  }
  if (d.monitor.commonBlock) {
    L.push(`- common-block height=${d.monitor.commonBlock.height} sameChain=${d.monitor.commonBlock.sameChain} valid=${d.monitor.commonBlock.validCount}`);
    for (const [cid, h] of Object.entries(d.monitor.commonBlock.hashes)) {
      L.push(`  - ${cid}: status=${h.status} hash=${h.hash ? String(h.hash).slice(0, 32) + '…' : '—'} heightOk=${h.heightOk} err=${h.error || '—'}`);
    }
    L.push(`- note: совпадение одного исторического блока подтверждает общий блок на этой высоте; отсутствие расхождения выше этим не доказывается.`);
  } else {
    L.push('- common-block: нет (понадобится при DRIFT-WARN или споре о форке)');
  }
  L.push('- Петля E23: если публичные записи node2/node3 повторяют tip/height node1 при отличающихся локальных — публичный монитор показывает node1 вместо резервов. Конфиги и монитор не менялись (этап 2 — только чтение).');
  L.push('');
  L.push('## 2. Компоненты: ожидалось → наблюдалось → доказательство → вывод');
  for (const r of d.rows) {
    L.push(`### ${r.componentId} [${r.verdict}]`);
    L.push(`- ожидалось: ${JSON.stringify(r.expected.expected || r.expected)}`);
    L.push(`- coverage: ${r.coverage || '—'}`);
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
