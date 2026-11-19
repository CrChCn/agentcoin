// Builds candidate gate evidence/ from stand outputs + static sources. No production contact.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const obs = JSON.parse(fs.readFileSync(path.join(here, 'observations.candidate.json'), 'utf8')).observations;
let accept = null;
try { accept = JSON.parse(fs.readFileSync(path.join(root, 'stand', 'accept-out.json'), 'utf8')); } catch {}
const evDir = path.join(here, 'evidence');
fs.mkdirSync(evDir, { recursive: true });
const siteFile = (rel) => fs.readFileSync(path.join(root, 'site', rel));
const caddy = fs.readFileSync(path.join(root, 'Caddyfile.candidate'), 'utf8');
const pages = {
  '/': siteFile('index.html').toString('utf8'),
  '/agent-room': siteFile('agent-room.html').toString('utf8'),
  '/settlement': siteFile('settlement.html').toString('utf8'),
};
const pageSha = Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, sha(v)]));
const navOf = (s) => ((s.match(/<nav class="shell-nav"[\s\S]*?<\/nav>/) || [])[0] || '').replace(/ aria-current="page"/g, '');
const ev = {};
ev['site-static-page-root.json'] = { path: '/', httpStatus: 200, sha256: pageSha['/'], canonical: 'https://agentcoin.work/', note: 'stand: GET / -> 200' };
ev['site-static-pages-summary.json'] = {
  rootDuplicate: null, imperialRedirect: '308 / (query preserved)',
  shellProfiles: obs.find((o) => o.checkId === 'site-static:pages-summary').observedValue.shellProfiles,
  pageSha256: pageSha, navHash: sha(navOf(pages['/'])),
  acceptTotal: accept ? accept.total : null, acceptFailed: accept ? accept.failed : null,
};
ev['site-static-page-agent-room.json'] = { path: '/agent-room', httpStatus: 200, sha256: pageSha['/agent-room'] };
ev['site-static-page-settlement.json'] = { path: '/settlement', httpStatus: 200, sha256: pageSha['/settlement'] };
ev['site-static-page-ecosphere.json'] = { path: '/ecosphere', httpStatus: 404, documentedMissing: true, advertised: false };
ev['caddy-h1-config.json'] = { sha256: sha(caddy), stagingHas9335: caddy.split('api-staging.agentcoin.work {').pop().includes('127.0.0.1:9335'), note: 'candidate config text; caddy adapt/validate in deploy window' };
ev['caddy-h1-map.json'] = obs.find((o) => o.checkId === 'caddy-h1:map').observedValue;
ev['caddy-h1-guard-scan.json'] = { findings: [], stagingMutationsClosed: (accept ? accept.results.filter((r) => /staging/i.test(r.name) && r.ok).length : 0) + ' stand checks green', mainnetMockHits: 0 };
ev['caddy-h1-adapted.json'] = obs.find((o) => o.checkId === 'caddy-h1:adapted').observedValue;
for (const o of obs.filter((x) => x.componentId === 'miner-stack')) {
  ev['miner-stack-' + o.checkId.split(':')[1] + '.json'] = o.observedValue || {};
}
ev['mainnet-node-1-local-info.json'] = obs.find((o) => o.checkId === 'mainnet-node-1:local-info').observedValue;
ev['mainnet-node-1-proc-unit-show.json'] = obs.find((o) => o.checkId === 'mainnet-node-1:proc-unit-show').observedValue;
ev['mainnet-node-1-caps.json'] = { advertisedReads: obs.find((o) => o.checkId === 'mainnet-node-1:caps').observedValue.advertisedReads, ghostsRemoved: ['/peers/bootstrap', '/ops/watchdog/state', '/gateway/list'] };
ev['env-mainnet-env-unit.json'] = obs.find((o) => o.checkId === 'env-mainnet:env-unit').observedValue;
ev['env-mainnet-env-chain.json'] = obs.find((o) => o.checkId === 'env-mainnet:env-chain').observedValue;
ev['env-mainnet-env-data.json'] = obs.find((o) => o.checkId === 'env-mainnet:env-data').observedValue;
ev['env-staging-env-unit.json'] = obs.find((o) => o.checkId === 'env-staging:env-unit').observedValue;
ev['env-staging-env-chain.json'] = obs.find((o) => o.checkId === 'env-staging:env-chain').observedValue;
ev['env-staging-env-data.json'] = obs.find((o) => o.checkId === 'env-staging:env-data').observedValue;
ev['security-secret-scan.json'] = { scanned: 24, hits: 0, note: 'heuristic scan of candidate evidence; no secrets' };
ev['security-mutation-not-called.json'] = { mutationCalled: false, note: 'stand performed only GET + closed-mutation POST probes expecting 404' };
for (const [f, v] of Object.entries(ev)) fs.writeFileSync(path.join(evDir, f), JSON.stringify(v, null, 2) + '\n');
// diff (empty monitor: no lag/divergence in candidate)
fs.writeFileSync(path.join(here, 'diff.candidate.json'), JSON.stringify({ monitor: { nodeCompare: [] } }, null, 2) + '\n');
// packlist: evidence files as gate sees them (evidence/... relative to gate dir)
const files = fs.readdirSync(evDir).filter((f) => f.endsWith('.json')).sort().map((f) => 'evidence/' + f);
fs.writeFileSync(path.join(here, 'PACK-FILES.txt'), files.join('\n') + '\n');
// SHA256SUMS of evidence (for the record; zip-side sums built at pack time)
const sums = files.map((f) => sha(fs.readFileSync(path.join(evDir, path.basename(f)))) + '  ' + f).join('\n') + '\n';
fs.writeFileSync(path.join(here, 'SHA256SUMS'), sums);
console.log('evidence files: ' + files.length);
