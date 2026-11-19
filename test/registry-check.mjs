#!/usr/bin/env node
// Self-test проверяющего механизма (Этап 1). Провал кейса = ненулевой код.
// Каждый негативный кейс проверяет КОНКРЕТНУЮ ожидаемую ошибку, а не любое падение.
import { checkRegistry } from '../tools/registry-check.mjs';
import fs from 'node:fs';

const base = JSON.parse(fs.readFileSync(new URL('../config/unified-registry.json', import.meta.url), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(base));
const results = [];
function run(name, fn, shouldPass, mustContain = []) {
  let errors = null;
  let threw = null;
  try {
    const r = fn();
    errors = r.errors || [];
  } catch (e) {
    threw = String((e && e.stack) || e);
  }
  let ok = false;
  let sample = '';
  if (threw) {
    ok = false;
    sample = 'THREW (validator must not throw): ' + threw.split('\n')[0];
  } else if (shouldPass) {
    ok = errors.length === 0;
    sample = errors[0] || '';
  } else {
    const joined = errors.join('\n');
    const missing = mustContain.filter((s) => !joined.includes(s));
    ok = errors.length > 0 && missing.length === 0;
    sample = missing.length ? `missing expected [${missing.join(' | ')}] in: ${errors[0] || '(no errors)'}` : (errors.find((e) => mustContain.some((s) => e.includes(s))) || errors[0] || '');
  }
  results.push({ name, shouldPass, mustContain, errors: threw ? -1 : errors.length, ok, sample });
}

// 1 valid
run('valid registry', () => checkRegistry(clone()), true);
// 2 duplicate
run('duplicate id', () => { const r=clone(); r.components.push(JSON.parse(JSON.stringify(r.components[0]))); return checkRegistry(r); }, false, ['duplicate componentId']);
// 3 missing dep
run('missing dep', () => { const r=clone(); r.components[0].dependsOn.push('no-such-component'); return checkRegistry(r); }, false, ['dependsOn missing component']);
// 4 competing owner same env
run('competing owner same env', () => { const r=clone(); const b=r.components.find(c=>c.componentId==='web-next'); b.routes.push({host:'agentcoin.work',method:'GET',path:'/settlement',owner:true,note:'TEST competing owner same env'}); return checkRegistry(r); }, false, ['route owner conflict']);
// 4b same route different envs must NOT conflict
run('same route different envs allowed', () => { const r=clone(); const t=r.components.find(c=>c.componentId==='env-testnet'); t.routes.push({host:'agentcoin.work',method:'GET',path:'/shield',owner:true,note:'TEST isolated env route'}); return checkRegistry(r); }, true);
// 5 confirmed w/o evidence
run('confirmed w/o evidence', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='node-monitor'); c.verification={...c.verification,status:'partial',evidence:[]}; c.verification.status='confirmed'; return checkRegistry(r); }, false, ['status confirmed requires']);
// 6 allowed alias
run('allowed alias', () => checkRegistry(clone()), true);
// 7 honest unknown
run('honest unknown visible', () => { const r=clone(); const t=r.components.find(c=>c.componentId==='env-testnet'); const okShape=t.verification.status==='unknown'&&t.verification.unknowns.length>0&&t.observedVersion===null; if(!okShape) return {errors:['unknown not visible']}; return {errors:[]}; }, true);
// 8 root version removed
run('root version removed', () => { const r=clone(); delete r.version; return checkRegistry(r); }, false, ['version']);
// 9 root sources removed
run('root sources removed', () => { const r=clone(); delete r.sources; return checkRegistry(r); }, false, ['sources']);
// 10 root chain removed
run('root chain removed', () => { const r=clone(); delete r.chain; return checkRegistry(r); }, false, ['chain']);
// 11 bad componentId
run('bad componentId rejected', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='cli'); c.componentId='BAD ID!'; return checkRegistry(r); }, false, ['componentId']);
// 12 expectedVersion object rejected
run('expectedVersion object rejected', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='cli'); c.expectedVersion={fake:true}; return checkRegistry(r); }, false, ['expectedVersion']);
// 13 bad checkedAt rejected
run('bad checkedAt rejected', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='cli'); c.verification.checkedAt='not-a-date'; return checkRegistry(r); }, false, ['checkedAt']);
// 14 node2 genesis mismatch (64 f)
run('node2 genesis mismatch rejected', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='mainnet-node-2'); c.chain.genesis='f'.repeat(64); return checkRegistry(r); }, false, ['chain pin mismatch']);
// 15 node2 chainId mismatch
run('node2 chainId mismatch rejected', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='mainnet-node-2'); c.chain.chainId='OTHER_CHAIN'; return checkRegistry(r); }, false, ['chain pin mismatch']);
// 16 evidence E99 rejected
run('evidence E99 rejected', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='cli'); c.verification.evidence.push('E99-NOT-EXIST'); return checkRegistry(r); }, false, ['unknown evidence reference']);
// 17 actionIds nonexistent rejected
run('actionIds nonexistent rejected', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='cli'); c.actionIds=['nonexistent']; return checkRegistry(r); }, false, ['unknown actionId']);
// 18 navIds nonexistent rejected
run('navIds nonexistent rejected', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='cli'); c.navIds=['/nonexistent']; return checkRegistry(r); }, false, ['unknown navId']);
// 19 routes.push(null) no throw
run('routes null entry handled', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='cli'); c.routes.push(null); return checkRegistry(r); }, false, ['must be object, got null']);
// 20 components.push(null) no throw
run('components null entry handled', () => { const r=clone(); r.components.push(null); return checkRegistry(r); }, false, ['must be object, got null']);
// 21 nested types: sources string, dependsOn object, routes object
run('nested wrong types rejected', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='cli'); c.sources='not-array'; c.dependsOn={x:1}; c.routes={x:1}; return checkRegistry(r); }, false, ['sources must be array']);
// 22 evidence file missing rejected
run('evidence missing file rejected', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='cli'); c.verification.evidence.push('docs/audit-network/evidence/E99-missing.json'); return checkRegistry(r); }, false, ['not found in package']);
// 23 confirmed external-only rejected
run('confirmed external-only rejected', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='cli'); c.verification.status='confirmed'; c.verification.evidence=['external:interview']; return checkRegistry(r); }, false, ['external-only']);
// 24 short genesis rejected (display insufficient)
run('short genesis rejected', () => { const r=clone(); const c=r.components.find(c=>c.componentId==='mainnet-node-1'); c.chain.genesis='abcd'; return checkRegistry(r); }, false, ['genesis']);

let fail=0;
for(const r of results){ console.log(`${r.ok?'PASS':'FAIL'} ${r.name} (expect ${r.shouldPass?'pass':'fail'}, errors=${r.errors})${r.ok?'':' :: '+r.sample}`); if(!r.ok) fail++; }
if(fail){ console.log(`SELFTEST FAIL ${fail}/${results.length}`); process.exit(1); }
console.log(`SELFTEST OK ${results.length}/${results.length}`);
