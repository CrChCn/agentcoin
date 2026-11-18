/* Agentcoin browser core — общее клиентское ядро для site/ecosphere/.
 * Zero-deps, без node:fs, без keystore. Чтение — fetch. Запись — только через
 * явный локальный подписант (window.AgentcoinSigner) и только если сервер
 * заявил signed в GET /queue/auth-capabilities. Авто-fallback signed→legacy
 * запрещён. Неподдерживаемая подпись блокирует действие с объяснением. */
export const BROWSER_CORE_VERSION = '0.1.0';
export const QUEUE_CHAIN = 'AGENTCOIN';

export function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export function shortAddr(a) { return a ? String(a).slice(0, 10) + '…' : '—'; }

export function canon(v) {
  const sort = (x) => Array.isArray(x) ? x.map(sort) : (x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
  return JSON.stringify(sort(v));
}

export function makeBrowserClient({ apiBase = '', fetchImpl = fetch, signer = null, address = '', timeoutMs = 15000 } = {}) {
  const base = String(apiBase || '').replace(/\/$/, '');
  const doFetch = fetchImpl;
  async function http(method, p, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await doFetch(base + p, {
        method, headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, redirect: 'error',
      });
      const data = await r.json().catch(() => ({}));
      return { status: r.status, data };
    } catch (e) {
      return { status: 0, data: {}, netError: String((e && e.message) || e).slice(0, 200) };
    } finally { clearTimeout(t); }
  }
  const get = (p) => http('GET', p);
  const post = (p, body) => http('POST', p, body);
  let capCache = null;

  async function capabilities() {
    if (capCache) return capCache;
    const r = await get('/queue/auth-capabilities');
    if (r.status === 200 && r.data) capCache = { signed: r.data.signed === true, chain: r.data.chain || QUEUE_CHAIN, genesis: r.data.genesis || 'unknown', raw: r.data };
    else capCache = { signed: false, chain: QUEUE_CHAIN, genesis: 'unknown', unsupported: true };
    return capCache;
  }
  async function netInfo() {
    const cap = await capabilities().catch(() => ({ genesis: 'unknown' }));
    let genesis = cap.genesis || 'unknown';
    let chain = cap.chain || QUEUE_CHAIN;
    try { const i = await get('/info'); genesis = i.data?.genesisHash || i.data?.genesis || genesis; } catch {}
    return { apiBase: base || '(same-origin)', genesis: String(genesis), chain };
  }
  // Блокировка мутаций при чужой сети: вызывающий передаёт ожидаемый genesis.
  function checkNetwork(expectedGenesis, actualGenesis) {
    if (!expectedGenesis || expectedGenesis === 'unknown') return null;
    if (String(actualGenesis) !== String(expectedGenesis)) return { blocked: true, reason: 'wrong_network', hint: 'Сеть не совпала: мутации заблокированы. Проверьте адрес API и genesis.' };
    return null;
  }
  async function status(addr) {
    const [info, q, bal, jobs] = await Promise.all([
      get('/info'), get('/queue/status'),
      get(`/balances?addresses=${encodeURIComponent(addr)}`), get('/jobs/state'),
    ]);
    const at = Date.now();
    return { node: base, at, info: info.data, queue: q.data, balance: bal.data, jobs: jobs.data?.stats || null, stale: info.status !== 200 || q.status !== 200 };
  }
  async function myTask(addr) {
    const ex = await get('/queue/assignments').catch(() => null);
    if (ex && ex.status === 200 && ex.data?.onDuty) {
      for (const [jobId, agent] of Object.entries(ex.data.onDuty)) if (String(agent) === String(addr)) return { jobId, agent, via: 'assignments', at: Date.now() };
      return null;
    }
    const q = await get('/queue/status');
    if (q.status === 200 && q.data?.onDuty && typeof q.data.onDuty === 'object') {
      for (const [jobId, agent] of Object.entries(q.data.onDuty)) if (String(agent) === String(addr)) return { jobId, agent, via: 'status', at: Date.now() };
      return null;
    }
    return { unknown: true, hint: 'назначение не установлено по доступным источникам' };
  }
  async function searchOffers({ skill, maxPriceAtomic, format } = {}) {
    const q = new URLSearchParams();
    if (skill) q.set('skill', skill);
    if (maxPriceAtomic !== undefined) q.set('maxPriceAtomic', String(maxPriceAtomic));
    if (format) q.set('format', format);
    const r = await get('/catalog/offers?' + q.toString());
    return { ...r.data, _status: r.status, at: Date.now(), stale: r.status !== 200 };
  }
  async function getOrder(assignmentId, requester) {
    const r = await get(`/orders/${assignmentId}${requester ? '?requester=' + encodeURIComponent(requester) : ''}`);
    return { ...r.data, _status: r.status, at: Date.now(), stale: r.status !== 200 && r.status !== 404 };
  }
  // Мутация: только signed через явный signer. Без signer или без capabilities.signed — явный отказ.
  async function mutate({ action, endpoint, body, expectedGenesis }) {
    const cap = await capabilities();
    if (!cap.signed) return { ok: false, error: 'signed_unsupported', hint: 'Сервер не поддерживает подпись (нет /queue/auth-capabilities signed:true). Legacy в браузере запрещён.' };
    const net = await netInfo();
    const blocked = expectedGenesis ? checkNetwork(expectedGenesis, net.genesis) : null;
    if (blocked) return { ok: false, ...blocked };
    if (!signer || typeof signer.sign !== 'function') {
      return { ok: false, error: 'signer_unavailable', hint: 'Подписант не подключён: укажите локальный ключ в явном интерфейсе. Просмотр доступен без ключа.' };
    }
    const nonce = String(Date.now()) + '-' + Math.random().toString(16).slice(2, 10);
    const expiry = Date.now() + 5 * 60_000;
    let sig;
    try { sig = await signer.sign({ action, body, nonce, expiry, chain: QUEUE_CHAIN }); }
    catch (e) { return { ok: false, error: 'sign_failed', hint: String((e && e.message) || e).slice(0, 200) }; }
    const r = await post(endpoint, { ...sig.envelope, action, body, nonce, expiry, chain: QUEUE_CHAIN });
    if (r.netError) return { ok: false, error: 'net_error', reconcile: 'needs_reconcile', hint: 'Ответ потерян: восстановите состояние чтением (заказ/очередь), повтор — тем же idempotencyKey.' };
    if (r.status === 200) return { ok: true, result: r.data };
    return { ok: false, status: r.status, error: r.data?.error || action + '_failed', detail: r.data };
  }
  async function getEvents({ cursor = '0', limit = 20, requester = '' } = {}) {
    const q = new URLSearchParams({ cursor: String(cursor), limit: String(limit) });
    if (requester) q.set('requester', requester);
    const r = await get('/events?' + q.toString());
    return { ...r.data, _status: r.status, at: Date.now() };
  }
  async function monitorHistory(monitorId, requester) {
    const r = await get(`/monitors/${encodeURIComponent(monitorId)}/history${requester ? '?requester=' + encodeURIComponent(requester) : ''}`);
    return { ...r.data, _status: r.status, at: Date.now() };
  }
  const publishOffer = (addr, offer, extra) => mutate({ action: 'publish', endpoint: '/catalog/publish', body: { offer }, ...(extra || {}) });
  const createOrder = (addr, offerId, input, idempotencyKey, offerVersion, extra) => mutate({ action: 'order', endpoint: '/orders/create', body: { offerId, offerVersion, input, idempotencyKey }, ...(extra || {}) });
  const submitArtifact = (addr, assignmentId, artifact, contentB64, extra) => mutate({ action: 'artifact', endpoint: '/orders/submit-artifact', body: { assignmentId, artifact, content: contentB64 }, ...(extra || {}) });
  const acceptOrder = (addr, assignmentId, verdict, extra) => mutate({ action: 'accept', endpoint: '/orders/accept', body: { assignmentId, verdict }, ...(extra || {}) });

  const createMonitor = (monitor, extra) => mutate({ action: 'monitor', endpoint: '/monitors/create', body: { monitor }, ...(extra || {}) });
  async function getSettlement(assignmentId, requester) {
    const r = await get(`/settlements/${assignmentId}${requester ? '?requester=' + encodeURIComponent(requester) : ''}`);
    return { ...r.data, _status: r.status, at: Date.now() };
  }
  async function opsMetrics() {
    const r = await get('/ops/metrics');
    return { ...r.data, _status: r.status, at: Date.now() };
  }
  async function testBalance(addr) {
    const r = await get(`/settlements/balances?address=${encodeURIComponent(addr)}`);
    return { ...r.data, _status: r.status, at: Date.now() };
  }
  const createSettlement = (assignmentId, extra) => mutate({ action: 'settle', endpoint: '/settlements/create', body: { assignmentId }, ...(extra || {}) });
  return { capabilities, netInfo, checkNetwork, status, myTask, searchOffers, getOrder, getEvents, monitorHistory, getSettlement, testBalance, opsMetrics, mutate, publishOffer, createOrder, submitArtifact, acceptOrder, createMonitor, createSettlement };
}
