#!/usr/bin/env node
/* Этап A: CLI рынка услуг — паритет с MCP/SDK, прогон против изолированного стенда.
   Стенд живёт в этом же процессе, поэтому CLI запускается асинхронно (spawn):
   spawnSync заблокировал бы event loop и сервер не смог бы ответить.
   Проверяем коды выхода, чистоту stdout, идемпотентность и отказы без имитации успеха. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createStand } from '../sdk/js/stand-server.mjs';
import { makeClient } from '../sdk/js/agentcoin-sdk.mjs';
import { addressFromPub } from '../core.mjs';

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS  ' : 'FAIL  ') + name + (extra ? ' — ' + extra : '')); };

const CLI = fileURLToPath(new URL('../sdk/js/agentcoin-cli.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agtcli-'));
const stand = await createStand(tmp);
const J = (n) => path.join(tmp, n + '.json');

const mk = (name) => {
  const k = crypto.generateKeyPairSync('ed25519');
  const pub = k.publicKey.export({ type: 'spki', format: 'pem' });
  const addr = addressFromPub(pub);
  const w = path.join(tmp, name + '.wallet.json');
  fs.writeFileSync(w, JSON.stringify({
    address: addr,
    public_key_pem: pub,
    privateKeyPem: k.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  }));
  return { addr, w };
};
const prov = mk('prov'), cust = mk('cust');
const wf = (p, name) => ({ wallet: p.w, address: p.addr, journal: J(name) });
const flags = ({ wallet, address, journal } = {}) => [
  ...(address ? ['--address', address] : []),
  ...(wallet ? ['--wallet', wallet] : []),
  ...(journal ? ['--journal', journal] : []),
];

/* Один запуск — один процесс. stdout обязан быть ровно одним JSON-объектом. */
function cli(args, ctx) {
  const argv = [...args, ...flags(ctx)];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...argv], {
      env: { ...process.env, AGENTCOIN_NODE: stand.url, AGENTCOIN_ALLOW_LEGACY_WRITE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('close', (code) => {
      clearTimeout(timer);
      let json = null, parseError = null;
      try { json = JSON.parse(stdout); } catch (e) { parseError = e.message; }
      resolve({ code, stdout, stderr, json, parseError });
    });
  });
}

// 0. help и версия — успех, без сети
{
  const h = await cli(['--help']);
  ok(h.code === 0 && /agentcoin-cli/.test(h.stdout), '--help → exit 0');
  const v = await cli(['--version']);
  ok(v.code === 0 && v.json?.cli === '0.3.0', '--version → версия CLI');
}

// 1. неизвестная команда — ошибка аргументов (2), не «успех»
{
  const r = await cli(['nonsense']);
  ok(r.code === 2 && r.json?.error === 'bad_arguments', 'неизвестная команда → exit 2');
}

// 2. чтение без кошелька
{
  const r = await cli(['status'], { address: prov.addr });
  ok(r.code === 0 && r.json?.node === stand.url && r.json?.info?.blocks === 1 && !r.json?.netError,
    'status без кошелька → данные узла', r.json?.netError ? 'netError=' + r.json.netError : '');
  const m = await cli(['ops-metrics']);
  ok(m.code === 0 && m.json && typeof m.json === 'object', 'ops-metrics → JSON без ключа');
  const t = await cli(['my-task'], { address: prov.addr });
  ok(t.code === 0 && 'task' in t.json, 'my-task → task (null = принадлежность неизвестна)');
}

// 3. публикация и поиск
const offer = {
  offerId: 'cli-check-demo', version: '1', provider: prov.addr, title: 'Проверка API через CLI',
  skills: ['api-check'], acceptedInputFormats: ['application/json'], producedOutputFormats: ['application/json'],
  inputSchema: { url: 'string' }, outputSchema: { url: 'string', status: 'number' },
  acceptance: { method: 'human', rules: 'customer compares status' },
  priceAtomic: 1000, expiresAt: Date.now() + 3600000, license: 'result-research-only',
  deadline: '24h', limits: 'stand only',
};
const offerFile = path.join(tmp, 'offer.json');
fs.writeFileSync(offerFile, JSON.stringify(offer));
{
  const pub = await cli(['offer-publish', '--offer', '@' + offerFile], wf(prov, 'p1'));
  ok(pub.code === 0 && pub.json?.ok === true, 'offer-publish с кошельком', pub.json?.error || '');
  const search = await cli(['offers', '--skill', 'api-check', '--max-price', '2000'], { address: cust.addr });
  ok(search.code === 0 && (search.json?.offers || []).some(o => o.offerId === 'cli-check-demo'), 'offers находит услугу');
  const cheap = await cli(['offers', '--skill', 'api-check', '--max-price', '10'], { address: cust.addr });
  ok(!(cheap.json?.offers || []).some(o => o.offerId === 'cli-check-demo'), 'offers отсекает по цене');
}

// 4. заказ идемпотентен
let aid = null;
{
  const input = path.join(tmp, 'input.json');
  fs.writeFileSync(input, JSON.stringify({ url: 'https://x' }));
  const a = await cli(['order-create', '--offer-id', 'cli-check-demo', '--input', '@' + input, '--idempotency', 'idem-cli-1'], wf(cust, 'o1'));
  ok(a.code === 0 && a.json?.ok === true && a.json?.result?.assignment?.assignmentId, 'order-create создаёт обязательство', a.json?.error || '');
  aid = a.json?.result?.assignment?.assignmentId;
  const b = await cli(['order-create', '--offer-id', 'cli-check-demo', '--input', '@' + input, '--idempotency', 'idem-cli-1'], wf(cust, 'o1'));
  ok(b.code === 0 && b.json?.replay === true && b.json?.result?.assignment?.assignmentId === aid, 'повтор order-create → replay, не новый заказ');
}

// 5. артефакт: локальная проверка до сети, затем приём
{
  const contentPath = path.join(tmp, 'content.bin');
  const bytes = Buffer.from(JSON.stringify({ url: 'https://x', status: 200 }));
  fs.writeFileSync(contentPath, bytes);
  const artifact = {
    artifactId: 'cli-a1', attemptId: 't1',
    contentHash: crypto.createHash('sha256').update(bytes).digest('hex'),
    mediaType: 'application/json', sizeBytes: bytes.length, location: 'inline',
    accessPolicy: 'parties', createdAt: Date.now(), producerSignature: 'sig',
  };
  const artFile = path.join(tmp, 'artifact.json');
  fs.writeFileSync(artFile, JSON.stringify(artifact));

  // битое содержимое: отказ ДО сети, заказ не должен получить артефакт
  const badFile = path.join(tmp, 'bad.bin');
  fs.writeFileSync(badFile, Buffer.from('other'));
  const bad = await cli(['order-submit', '--assignment', aid, '--artifact', '@' + artFile, '--content', '@' + badFile], wf(prov, 'a0'));
  ok(bad.code === 2 && bad.json?.error === 'bad_arguments' && /artifact_hash_mismatch/.test(bad.json?.hint || ''), 'битый хеш отвергнут локально (exit 2)');
  const before = await makeClient({ node: stand.url, journalFile: J('chk') }).getOrder(aid, cust.addr);
  ok((before.artifacts || []).length === 0, 'после локального отказа артефакт не отправлен');

  const good = await cli(['order-submit', '--assignment', aid, '--artifact', '@' + artFile, '--content', '@' + contentPath], wf(prov, 'a1'));
  ok(good.code === 0 && good.json?.ok === true, 'order-submit с верным хешем принят', good.json?.error || '');

  const foreign = await cli(['order-submit', '--assignment', aid, '--artifact', '@' + artFile, '--content', '@' + contentPath], wf(mk('other'), 'a2'));
  ok(foreign.code === 1 && foreign.json?.ok === false, 'чужой provider → отказ (exit 1)');
}

// 6. приёмка и повтор
{
  const a = await cli(['order-accept', '--assignment', aid, '--verdict', 'accepted: cli'], wf(cust, 'ac1'));
  ok(a.code === 0 && a.json?.ok === true && a.json?.result?.assignment?.state === 'accepted', 'order-accept принимает результат', a.json?.error || '');
  const b = await cli(['order-accept', '--assignment', aid, '--verdict', 'accepted: cli'], wf(cust, 'ac1'));
  ok(b.code === 0 && b.json?.replay === true, 'повтор order-accept → тот же исход');
  const read = await cli(['order-get', '--assignment', aid], { ...wf(cust, 'g1'), });
  ok(read.code === 0 && read.json?.assignment?.state === 'accepted', 'order-get читает принятый заказ');
}

// 7. события с курсором
{
  const e = await cli(['events', '--cursor', '0', '--limit', '10'], { address: cust.addr });
  ok(e.code === 0 && Array.isArray(e.json?.events), 'events отдаёт ленту с курсором');
}

// 8. отказ не выдаётся за успех
{
  const unknown = await cli(['order-accept', '--assignment', '0000000000000000', '--verdict', 'x'], wf(cust, 'u1'));
  ok(unknown.code === 1 && unknown.json?.ok === false, 'accept неизвестного заказа → exit 1');
  const missing = await cli(['order-get', '--assignment', 'deadbeefdeadbeef'], { address: cust.addr });
  ok(missing.code === 1 && typeof missing.json?.error === 'string', 'order-get неизвестного заказа → exit 1, не пустой успех');
}

// 9. запись без кошелька не выполняется
{
  const r = await cli(['order-create', '--offer-id', 'cli-check-demo'], { address: cust.addr });
  ok(r.code === 2 && r.json?.error === 'bad_arguments' && /wallet/.test(r.json?.hint || ''), 'запись без --wallet → отказ, сеть не тронута');
}

// 10. подписка (§6) и тик — те же операции, что в SDK/MCP
{
  const sub = {
    serviceId: 'cli-sub-1', customer: cust.addr, provider: prov.addr, cadence: 60000,
    periodStart: Date.now(), periodEnd: Date.now() + 3_600_000,
    maxCostPerPeriodAtomic: 500, priceAtomicPerRun: 100,
    acceptanceRules: { method: 'human', rules: 'status + evidence' },
    cancellationRules: { noticeMs: 0 },
    renewalPolicy: { autoRenew: false },
    targetUrl: 'https://example/api/health', maxConcurrentRuns: 4,
  };
  const subFile = path.join(tmp, 'sub.json');
  fs.writeFileSync(subFile, JSON.stringify(sub));
  const c = await cli(['subscription-create', '--subscription', '@' + subFile], wf(cust, 's1'));
  ok(c.code === 0 && c.json?.ok === true && c.json?.result?.monitor?.subscription?.acceptanceRules,
    'subscription-create через CLI сохраняет условия', c.json?.error || '');
  const createdAt = c.json?.result?.monitor?.createdAt;
  const t = await cli(['monitor-tick', '--monitor', 'cli-sub-1', '--now', String(createdAt + 10)], wf(cust, 's2'));
  ok(t.code === 0 && (t.json?.ran || []).length === 1, 'monitor-tick через CLI создаёт один прогон', t.json?.error || '');
}

// 11. stdout — ровно один JSON, диагностика отдельно
{
  const r = await cli(['status', '--pretty'], { address: prov.addr });
  ok(r.parseError === null && r.stdout.trim().startsWith('{') && r.stdout.trim().endsWith('}'), 'stdout — ровно один JSON-объект');
}

console.log(`\nитог: ${pass} PASS, ${fail} FAIL`);
stand.close();
process.exit(fail ? 1 : 0);
