#!/usr/bin/env node
/* Agentcoin MCP-сервер v0.2 (stdio, zero-deps). stdout — ТОЛЬКО протокол,
   диагностика — stderr. Мутирующие инструменты помечены destructive. */
import fs from 'node:fs';
import { makeClient } from '../sdk/js/agentcoin-sdk.mjs';

const NODE = process.env.AGENTCOIN_NODE || 'http://127.0.0.1:9333';
const ADDRESS = process.env.AGENTCOIN_ADDRESS || '';
const WALLET = process.env.AGENTCOIN_WALLET || '';
const err = (m) => process.stderr.write(String(m) + '\n');

const TOOLS = [
  { name: 'status', description: 'READ-ONLY: публичное состояние сети и очереди', inputSchema: { type: 'object', properties: { address: { type: 'string' } } } },
  { name: 'my_task', description: 'READ-ONLY: моё текущее назначение', inputSchema: { type: 'object', properties: { address: { type: 'string' } } } },
  { name: 'payments', description: 'READ-ONLY: стадии выплаты (accepted/txSent/confirmed)', inputSchema: { type: 'object', properties: { address: { type: 'string' } } } },
  { name: 'queue_join', description: 'MUTATING (destructive): встать в очередь', inputSchema: { type: 'object', properties: { address: { type: 'string' }, handle: { type: 'string' } }, required: ['address'] } },
  { name: 'jobs_claim', description: 'MUTATING (destructive): взять только свою задачу', inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] } },
  { name: 'jobs_submit', description: 'MUTATING (destructive): сдать работу (summary>=40)', inputSchema: { type: 'object', properties: { address: { type: 'string' }, jobId: { type: 'string' }, summary: { type: 'string' } }, required: ['address', 'jobId', 'summary'] } },
  { name: 'offers_search', description: 'READ-ONLY: поиск услуг по навыку/цене/формату', inputSchema: { type: 'object', properties: { skill: { type: 'string' }, maxPriceAtomic: { type: 'number' }, format: { type: 'string' } } } },
  { name: 'trust_card', description: 'READ-ONLY: Trust Card — интервал доверия, grade и доказательства по адресу', inputSchema: { type: 'object', properties: { address: { type: 'string' }, role: { type: 'string' } }, required: ['address'] } },
  { name: 'offers_ranked', description: 'READ-ONLY: ранжирование услуг по нижней границе доверия и цене', inputSchema: { type: 'object', properties: { skill: { type: 'string' }, maxPriceAtomic: { type: 'number' }, format: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'offers_publish', description: 'MUTATING (destructive): опубликовать предложение услуги', inputSchema: { type: 'object', properties: { address: { type: 'string' }, offer: { type: 'object' } }, required: ['address', 'offer'] } },
  { name: 'orders_create', description: 'MUTATING (destructive): создать заказ (идемпотентный)', inputSchema: { type: 'object', properties: { address: { type: 'string' }, offerId: { type: 'string' }, input: { type: 'object' }, idempotencyKey: { type: 'string' } }, required: ['address', 'offerId'] } },
  { name: 'orders_submit', description: 'MUTATING (destructive): сдать артефакт результата', inputSchema: { type: 'object', properties: { address: { type: 'string' }, assignmentId: { type: 'string' }, artifact: { type: 'object' }, contentB64: { type: 'string' } }, required: ['address', 'assignmentId', 'artifact', 'contentB64'] } },
  { name: 'orders_accept', description: 'MUTATING (destructive): принять результат заказа', inputSchema: { type: 'object', properties: { address: { type: 'string' }, assignmentId: { type: 'string' }, verdict: { type: 'string' } }, required: ['address', 'assignmentId'] } },
  { name: 'events_read', description: 'READ-ONLY: события с курсором (cursor/limit)', inputSchema: { type: 'object', properties: { address: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'monitors_history', description: 'READ-ONLY: история запусков api-monitor/подписки', inputSchema: { type: 'object', properties: { address: { type: 'string' }, monitorId: { type: 'string' } }, required: ['address', 'monitorId'] } },
  { name: 'monitors_create', description: 'MUTATING (destructive): создать api-monitor', inputSchema: { type: 'object', properties: { address: { type: 'string' }, monitor: { type: 'object' } }, required: ['address', 'monitor'] } },
  { name: 'subscription_create', description: 'MUTATING (destructive): создать повторяющуюся услугу (условия до работы)', inputSchema: { type: 'object', properties: { address: { type: 'string' }, subscription: { type: 'object' } }, required: ['address', 'subscription'] } },
  { name: 'monitors_tick', description: 'MUTATING (destructive): тик подписки — missed не оплачивается, повтор идемпотентен', inputSchema: { type: 'object', properties: { address: { type: 'string' }, monitorId: { type: 'string' }, nowMs: { type: 'number' }, result: { type: 'object' } }, required: ['address', 'monitorId'] } },
  { name: 'monitors_pause', description: 'MUTATING (destructive): пауза/возобновление подписки', inputSchema: { type: 'object', properties: { address: { type: 'string' }, monitorId: { type: 'string' }, paused: { type: 'boolean' } }, required: ['address', 'monitorId'] } },
  { name: 'monitors_cancel', description: 'MUTATING (destructive): отмена подписки (будущие обязательства прекращаются, возникшие — нет)', inputSchema: { type: 'object', properties: { address: { type: 'string' }, monitorId: { type: 'string' } }, required: ['address', 'monitorId'] } },
  { name: 'orders_delegate', description: 'MUTATING (destructive): нанять подрядчика в рамках бюджета/глубины родительского заказа', inputSchema: { type: 'object', properties: { address: { type: 'string' }, parentId: { type: 'string' }, offerId: { type: 'string' }, offerVersion: { type: 'string' }, input: { type: 'object' }, budgetAtomic: { type: 'number' }, maxDepth: { type: 'number' }, idempotencyKey: { type: 'string' } }, required: ['address', 'parentId', 'offerId', 'budgetAtomic'] } },
  { name: 'orders_review', description: 'MUTATING (destructive): независимый отзыв (ревьюер не сторона заказа)', inputSchema: { type: 'object', properties: { address: { type: 'string' }, assignmentId: { type: 'string' }, verdict: { type: 'string' }, rationale: { type: 'string' }, evidenceHash: { type: 'string' } }, required: ['address', 'assignmentId', 'verdict'] } },
  { name: 'orders_dispute', description: 'MUTATING (destructive): открыть спор стороны — расчёт замораживается', inputSchema: { type: 'object', properties: { address: { type: 'string' }, assignmentId: { type: 'string' }, reason: { type: 'string' }, evidenceHash: { type: 'string' } }, required: ['address', 'assignmentId', 'reason'] } },
  { name: 'orders_resolve_dispute', description: 'MUTATING (destructive): решение спора независимым арбитром (не сторона, не ревьюер)', inputSchema: { type: 'object', properties: { address: { type: 'string' }, disputeId: { type: 'string' }, verdict: { type: 'string' }, rationale: { type: 'string' } }, required: ['address', 'disputeId', 'verdict'] } },
  { name: 'resources_list', description: 'READ-ONLY: каталог ресурсов (квота, цена за единицу); verified=false', inputSchema: { type: 'object', properties: { kind: { type: 'string' } } } },
  { name: 'resources_get', description: 'READ-ONLY: карточка ресурса', inputSchema: { type: 'object', properties: { resourceId: { type: 'string' } }, required: ['resourceId'] } },
  { name: 'resource_register', description: 'MUTATING (destructive): опубликовать ресурс (поставщик со своим endpoint)', inputSchema: { type: 'object', properties: { address: { type: 'string' }, resource: { type: 'object' } }, required: ['address', 'resource'] } },
  { name: 'resource_lease', description: 'MUTATING (destructive): арендовать квоту ресурса (потолок, не списание)', inputSchema: { type: 'object', properties: { address: { type: 'string' }, resourceId: { type: 'string' }, units: { type: 'number' }, idempotencyKey: { type: 'string' }, leaseMs: { type: 'number' } }, required: ['address', 'resourceId', 'units'] } },
  { name: 'resource_consume', description: 'MUTATING (destructive): поставщик фиксирует измеренное потребление (идемпотентно по usageId)', inputSchema: { type: 'object', properties: { address: { type: 'string' }, leaseId: { type: 'string' }, units: { type: 'number' }, usageId: { type: 'string' } }, required: ['address', 'leaseId', 'units', 'usageId'] } },
  { name: 'resource_close', description: 'MUTATING (destructive): закрыть аренду — оплата по измеренному потреблению', inputSchema: { type: 'object', properties: { address: { type: 'string' }, leaseId: { type: 'string' } }, required: ['address', 'leaseId'] } },
  { name: 'settlements_read', description: 'READ-ONLY: стадии тестового расчёта заказа', inputSchema: { type: 'object', properties: { address: { type: 'string' }, assignmentId: { type: 'string' } }, required: ['address', 'assignmentId'] } },
  { name: 'ops_metrics', description: 'READ-ONLY: эксплуатационные метрики стенда', inputSchema: { type: 'object', properties: {} } },
];
function client(addr) {
  const a = addr || ADDRESS;
  if (!a) throw Object.assign(new Error('address required'), { code: -32000 });
  return { c: makeClient({ node: NODE, address: a, walletFile: WALLET || undefined }), addr: a };
}
async function call(name, args = {}) {
  if (name === 'ops_metrics') return await makeClient({ node: NODE }).opsMetrics();
  if (name === 'trust_card') {
    const address = String(args.address || ADDRESS || '');
    if (!address) throw Object.assign(new Error('address required'), { code: -32602 });
    return await makeClient({ node: NODE }).getTrustCard(address, String(args.role || 'provider'));
  }
  if (name === 'offers_ranked') {
    const limit = Math.max(1, Math.min(20, Number(args.limit) || 5));
    const pub = makeClient({ node: NODE });
    const found = await pub.searchOffers({ skill: args.skill, maxPriceAtomic: args.maxPriceAtomic, format: args.format });
    const offers = (found.offers || []).slice(0, limit);
    const ranked = [];
    for (const offer of offers) {
      let trust = null;
      try { trust = (await pub.getTrustCard(String(offer.provider))).card; } catch {}
      ranked.push({ ...offer, trust });
    }
    ranked.sort((a, b) => {
      const sa = a.trust?.score == null ? -1 : a.trust.score;
      const sb = b.trust?.score == null ? -1 : b.trust.score;
      return sb - sa || Number(a.priceAtomic) - Number(b.priceAtomic);
    });
    return { count: ranked.length, ranking: 'trust lower bound desc, price asc', offers: ranked };
  }
  const { c, addr } = client(args.address);
  if (name === 'status') return await c.status(addr);
  if (name === 'my_task') return { task: await c.myTask(addr) };
  if (name === 'payments') return await c.payments(addr);
  if (name === 'offers_search') return await c.searchOffers({ skill: args.skill, maxPriceAtomic: args.maxPriceAtomic, format: args.format });

  if (name === 'offers_publish') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.publishOffer(addr, args.offer); }
  if (name === 'orders_create') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.createOrder(addr, String(args.offerId), args.input || {}, String(args.idempotencyKey || '')); }
  if (name === 'orders_submit') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.submitArtifact(addr, String(args.assignmentId), args.artifact, String(args.contentB64)); }
  if (name === 'orders_accept') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.acceptOrder(addr, String(args.assignmentId), String(args.verdict || 'accepted')); }
  if (name === 'events_read') return await c.getEvents({ cursor: String(args.cursor || '0'), limit: Number(args.limit || 20), requester: addr });
  if (name === 'monitors_history') return await c.monitorHistory(String(args.monitorId), addr);
  if (name === 'monitors_create') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.createMonitor(addr, args.monitor); }
  if (name === 'subscription_create') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.createSubscription(addr, args.subscription); }
  if (name === 'monitors_tick') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.tickMonitor(String(args.monitorId), args.nowMs ? Number(args.nowMs) : undefined, args.result || null, addr); }
  if (name === 'monitors_pause') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.pauseMonitor(addr, String(args.monitorId), Boolean(args.paused)); }
  if (name === 'monitors_cancel') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.cancelMonitor(addr, String(args.monitorId)); }
  if (name === 'orders_delegate') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.delegateOrder(addr, String(args.parentId), { offerId: String(args.offerId), offerVersion: args.offerVersion, input: args.input || {}, budgetAtomic: Number(args.budgetAtomic), maxDepth: args.maxDepth ? Number(args.maxDepth) : undefined, idempotencyKey: args.idempotencyKey }); }
  if (name === 'orders_review') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.reviewOrder(addr, String(args.assignmentId), { verdict: String(args.verdict), rationale: args.rationale, evidenceHash: args.evidenceHash }); }
  if (name === 'orders_dispute') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.disputeOrder(addr, String(args.assignmentId), { reason: String(args.reason), evidenceHash: args.evidenceHash }); }
  if (name === 'orders_resolve_dispute') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.resolveDispute(addr, String(args.disputeId), { verdict: String(args.verdict), rationale: args.rationale }); }
  if (name === 'resources_list') return await c.listResources({ kind: args.kind });
  if (name === 'resources_get') return await c.getResource(String(args.resourceId));
  if (name === 'resource_register') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.registerResource(addr, args.resource); }
  if (name === 'resource_lease') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.leaseResource(addr, String(args.resourceId), Number(args.units), { idempotencyKey: args.idempotencyKey, leaseMs: args.leaseMs ? Number(args.leaseMs) : undefined }); }
  if (name === 'resource_consume') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.consumeResource(addr, String(args.leaseId), Number(args.units), String(args.usageId)); }
  if (name === 'resource_close') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.closeLease(addr, String(args.leaseId)); }
  if (name === 'settlements_read') return await c.getSettlement(String(args.assignmentId), addr);
  if (name === 'queue_join') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.join(addr, String(args.handle || '')); }
  if (name === 'jobs_claim') { if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 }); return await c.claim(addr); }
  if (name === 'jobs_submit') {
    if (!WALLET) throw Object.assign(new Error('wallet required for write'), { code: -32000 });
    if (!args.jobId || String(args.summary || '').length < 40) throw Object.assign(new Error('jobId and summary>=40 required'), { code: -32602 });
    return await c.submit(addr, String(args.jobId), String(args.summary));
  }
  throw Object.assign(new Error('unknown tool ' + name), { code: -32601 });
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { err('bad json line'); continue; }
    const reply = (result, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, ...(error ? { error } : { result }) }) + '\n');
    try {
      if (msg.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agentcoin', version: '0.2.0' } });
      else if (msg.method === 'tools/list') reply({ tools: TOOLS });
      else if (msg.method === 'tools/call') {
        try { reply({ content: [{ type: 'text', text: JSON.stringify(await call(msg.params?.name, msg.params?.arguments)) }] }); }
        catch (e) { reply(null, { code: e.code || -32000, message: String(e.message || e).slice(0, 300) }); }
      }
      else reply(null, { code: -32601, message: 'method not found' });
    } catch (e) { reply(null, { code: -32000, message: String(e.message || e).slice(0, 300) }); }
  }
});
process.stdin.on('end', () => process.exit(0));
err('agentcoin-mcp ready');
