// Only operator-configured targets are probed. Visitors cannot supply URLs.
export function createNodeMonitor({targets = [], selfHealth, fetchFn = fetch, now = Date.now, ttlMs = 10_000}) {
  if (!Array.isArray(targets) || targets.length > 16) throw new Error('invalid_monitor_targets');
  const configured = targets.map(t => {
    if (!t || typeof t.name !== 'string' || t.name.length > 64 || typeof t.url !== 'string') throw new Error('invalid_monitor_target');
    const u = new URL(t.url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('invalid_monitor_url');
    return {name:t.name,url:u.origin};
  });
  let cached, pending;
  async function probe() {
    const nodes = [{name:'Эта нода', ...selfHealth(), reachable:true}];
    const remote = await Promise.all(configured.map(async t => {
      try {
        const r = await fetchFn(t.url + '/health', {signal:AbortSignal.timeout(2500), redirect:'error'});
        if (!r.ok) throw new Error('http_' + r.status);
        const chunks = []; let size = 0;
        const reader = r.body?.getReader(); if (!reader) throw new Error('missing_body');
        try {
          while (true) {
            const part = await reader.read(); if (part.done) break;
            size += part.value.byteLength;
            if (size > 16384) { await reader.cancel(); throw new Error('body_too_large'); }
            chunks.push(Buffer.from(part.value));
          }
        } finally { reader.releaseLock(); }
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v.ok !== true || v.service !== 'agt-node' || !Number.isSafeInteger(v.blocks) || v.blocks < 0) throw new Error('invalid_health');
        return {name:t.name,reachable:true,blocks:v.blocks,tipHash:typeof v.tipHash === 'string'?v.tipHash:null,
          tipAgeSec:Number.isFinite(v.tipAgeSec)?v.tipAgeSec:null,overloaded:v.overloaded === true,
          chainValid:typeof v.chainValid === 'boolean'?v.chainValid:null};
      } catch { return {name:t.name,reachable:false,status:'unreachable'}; }
    }));
    nodes.push(...remote);
    const maxObservedBlocks = Math.max(...nodes.filter(n=>n.reachable).map(n=>n.blocks));
    for (const n of nodes) if (n.reachable) {
      n.behindObserved = maxObservedBlocks - n.blocks;
      n.status = n.chainValid === false ? 'invalid_chain' : n.overloaded ? 'overloaded' : n.behindObserved > 0 ? 'lower_observed_height' : n.tipAgeSec > 300 ? 'stale_tip' : 'responding';
      n.fresh = Number.isFinite(n.tipAgeSec) && n.tipAgeSec < 300;
    }
    return {ok:true,nodes,maxObservedBlocks,checkedAt:new Date(now()).toISOString(),
      note:'Высота сравнивается только с настроенными узлами. Это не доказательство каноничности цепи или независимости операторов.'};
  }
  return async () => {
    if(cached && now()-cached.at < ttlMs) return structuredClone(cached.value);
    if (!pending) pending = probe().then(value => {cached={at:now(),value};return value;}).finally(()=>{pending=null;});
    return structuredClone(await pending);
  };
}
