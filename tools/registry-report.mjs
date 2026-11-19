#!/usr/bin/env node
// registry-report.mjs — отчёт генерируется из реестра, без ручной карты.
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2] || path.join(path.dirname(process.argv[1]), '..', 'config', 'unified-registry.json');
const out = process.argv[3] || null;
const reg = JSON.parse(fs.readFileSync(file, 'utf8'));

const L = [];
L.push('# Единый реестр Agentcoin — отчёт (generated)');
L.push('');
L.push(`- registry: ${reg.version}, updatedAt=${reg.updatedAt}, chain=${reg.chain?.network}/${reg.chain?.genesis?.slice(0, 8)}…`);
L.push(`- sources: system=${reg.sources?.systemRegistry} actions=${reg.sources?.actionRegistry} tree=${reg.sources?.navTree}`);
L.push('');
L.push('## 1. Компоненты (ожидаемое vs наблюдаемое)');
for (const c of reg.components) {
  const v = c.verification || {};
  L.push(`### ${c.componentId} [${v.status || '?'}]`);
  L.push(`- назначение: ${c.purpose}`);
  L.push(`- env/host/process: ${c.env} / ${c.host} / ${c.process}`);
  L.push(`- версии: expected=${c.expectedVersion ?? '—'} observed=${c.observedVersion ?? '—'}`);
  L.push(`- expected: ${JSON.stringify(c.expected)}`);
  L.push(`- observed: ${JSON.stringify(c.observed)}`);
  L.push(`- storage: ${c.storage ?? '—'}; network: ${c.network ?? '—'}`);
  if (c.observe) L.push(`- observe: ${JSON.stringify(c.observe)}`);
  L.push(`- dependsOn: ${(c.dependsOn || []).join(', ') || '—'}`);
  L.push(`- check: ${c.checkMethod}; proof: ${c.proofSource}; checkedAt=${v.checkedAt}`);
  L.push(`- evidence: ${(v.evidence || []).join(', ') || '—'}`);
  L.push(`- unknowns: ${(v.unknowns || []).join('; ') || '—'}`);
  if (c.chain) L.push(`- chain: ${JSON.stringify(c.chain)}`);
  if (Array.isArray(c.routes) && c.routes.length) {
    L.push(`- routes:`);
    for (const r of c.routes) L.push(`  - ${r.method || 'GET'} ${r.host}${r.path} owner=${r.owner}${r.aliasOf ? ` aliasOf=${r.aliasOf}` : ''} — ${r.note}`);
  }
}
L.push('');
L.push('## 2. Дерево зависимостей');
for (const c of reg.components) L.push(`- ${c.componentId} -> ${(c.dependsOn || []).join(', ') || '(none)'}`);
L.push('');
L.push('## 3. Владельцы маршрутов (только owner:true)');
const owners = new Map();
for (const c of reg.components) for (const r of (c.routes || [])) {
  if (r.owner !== true) continue;
  const k = `${r.method || 'GET'} ${r.host}${r.path}`;
  if (!owners.has(k)) owners.set(k, []);
  owners.get(k).push(c.componentId);
}
for (const [k, v] of [...owners.entries()].sort()) L.push(`- ${k} — ${v.join(', ')}`);
L.push('');
L.push('## 4. Противоречия / частичное / неизвестное');
for (const c of reg.components) {
  const v = c.verification || {};
  if (v.status !== 'confirmed') L.push(`- ${c.componentId} [${v.status}]: ${(v.unknowns || []).join('; ') || 'см. evidence'}`);
}
L.push('');
L.push('## 5. Недостающие доказательства');
for (const c of reg.components) {
  const v = c.verification || {};
  if ((v.unknowns || []).length) L.push(`- ${c.componentId}: ${(v.unknowns || []).join('; ')} (evidence: ${(v.evidence || []).join(', ')})`);
}
const md = L.join('\n') + '\n';
if (out) fs.writeFileSync(out, md);
else process.stdout.write(md);
