// Candidate stand: mainnet mock (loopback only). No production contact.
import http from 'node:http';
export const MAINNET_PORT = 18081;
export const hits = { count: 0, paths: [] };
const GENESIS = '00026d18205c7c873bd612d6e2480321171eb0cb0b3d06c2c2cb0b17b9188e4e';
export function start() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.count++; hits.paths.push(req.method + ' ' + u.pathname);
    if (u.pathname === '/info') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ chainId: 'AGENTCOIN', genesisHash: GENESIS, blocks: 50053 }));
      return;
    }
    if (u.pathname.startsWith('/txproof/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, owner: 'mainnet-mock', path: u.pathname }));
      return;
    }
    if (u.pathname === '/balance' || u.pathname === '/identity/meta' || u.pathname === '/peers/list' || u.pathname === '/peers/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, owner: 'mainnet-mock', path: u.pathname }));
      return;
    }
    if (u.pathname === '/tx' && req.method === 'POST') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
  return new Promise((resolve) => srv.listen(MAINNET_PORT, '127.0.0.1', () => resolve(srv)));
}
if (process.argv[1] && process.argv[1].endsWith('mock-mainnet.mjs')) {
  start().then(() => console.log('mainnet-mock on ' + MAINNET_PORT));
}
