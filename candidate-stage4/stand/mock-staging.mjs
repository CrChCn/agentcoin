// Candidate stand: staging mock (loopback only). Own chainId/genesis, separate from mainnet.
import http from 'node:http';
export const STAGING_PORT = 18082;
export const hits = { count: 0, paths: [] };
const GENESIS = '00022668STAGING000000000000000000000000000000000000000000203f8c';
export function start() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.count++; hits.paths.push(req.method + ' ' + u.pathname);
    if (u.pathname === '/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ chainId: 'AGT_TESTNET', genesisHash: GENESIS }));
      return;
    }
    if (u.pathname.startsWith('/txproof/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, owner: 'staging-mock', path: u.pathname }));
      return;
    }
    if (u.pathname === '/balance' || u.pathname === '/node-info' || u.pathname === '/identity/meta') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, owner: 'staging-mock', path: u.pathname }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
  return new Promise((resolve) => srv.listen(STAGING_PORT, '127.0.0.1', () => resolve(srv)));
}
if (process.argv[1] && process.argv[1].endsWith('mock-staging.mjs')) {
  start().then(() => console.log('staging-mock on ' + STAGING_PORT));
}
