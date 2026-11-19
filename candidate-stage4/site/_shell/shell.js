/* Agentcoin shared shell v1 (stage4 candidate). Same file on /, /agent-room, /settlement. */
(function () {
  'use strict';
  function setState(state, text) {
    var pill = document.getElementById('agentcoin-pill');
    var out = document.getElementById('agentcoin-netout');
    if (pill) { pill.className = 'pill ' + state; pill.textContent = text; }
    if (out && state !== 'ok') { out.textContent = text; }
  }
  async function check() {
    setState('idle', 'проверка…');
    try {
      var r = await fetch('/info', { redirect: 'error' });
      var ct = (r.headers.get('content-type') || '').toLowerCase();
      if (!r.ok) throw new Error('unavailable (' + r.status + ')');
      if (ct.indexOf('application/json') === -1) throw new Error('unavailable (не-JSON)');
      var j = await r.json();
      var chain = String(j.chainId || j.network || '');
      var gen = String(j.genesisHash || j.genesis || '');
      var el1 = document.getElementById('agentcoin-chain');
      var el2 = document.getElementById('agentcoin-genesis');
      if (el1) el1.textContent = chain || '—';
      if (el2) el2.textContent = gen ? gen.slice(0, 18) + '…' : '—';
      if (el2 && gen) el2.title = gen;
      setState('ok', '● сеть ok');
      var out = document.getElementById('agentcoin-netout');
      if (out) out.textContent = 'chain=' + chain + ' genesis=' + (gen ? gen.slice(0, 18) + '…' : '?');
    } catch (e) {
      setState('bad', '● недоступно — ' + String((e && e.message) || e));
    }
  }
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.getElementById('agentcoin-retry');
    if (b) b.addEventListener('click', check);
    check();
  });
})();
