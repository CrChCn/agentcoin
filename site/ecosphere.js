/* ECOSPHERE — живая сфера экосистемы Agentcoin.
 * Центр — сеть (высота цепи). Точки на сфере — ноды меша.
 * Агенты: прилетают (очередь nextFive) → работают на кольце задач →
 * вспышка выплаты (реальные события /queue/history) → улетают → возвращаются.
 * Только реальные данные публичных API; без данных — честная подпись. */
(function () {
  'use strict';
  var cv = document.getElementById('ecoCanvas');
  if (!cv) return;
  var feed = document.getElementById('ecoFeed');
  var info = document.getElementById('ecoInfo');
  var btn = document.getElementById('ecoPause');
  var ctx = cv.getContext('2d');
  var W = 0, H = 0, DPR = 1;
  var CX = 0, CY = 0, R = 150;
  var rotY = 0, rotX = 0.42, tiltTX = 0, tiltTY = 0;
  var paused = false, reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  if (reduced) paused = true;

  function resize() {
    var r = cv.getBoundingClientRect();
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(280, Math.floor(r.width)); H = 440;
    cv.width = W * DPR; cv.height = H * DPR;
    cv.style.height = H + 'px';
    CX = W * 0.42; CY = H / 2;
    R = Math.min(W * 0.30, 165);
    if (W < 560) { CX = W / 2; }
  }
  resize();
  if (window.ResizeObserver) new ResizeObserver(resize).observe(cv);
  window.addEventListener('resize', resize);

  // Сфера: решётка Фибоначчи
  var shell = [];
  (function () {
    var N = 170, ga = Math.PI * (3 - Math.sqrt(5));
    for (var i = 0; i < N; i++) {
      var y = 1 - (i / (N - 1)) * 2, rr = Math.sqrt(1 - y * y), th = ga * i;
      shell.push([Math.cos(th) * rr, y, Math.sin(th) * rr]);
    }
  })();
  // 3 ноды меша — яркие точки на сфере
  var meshNodes = [
    { a: 0.3, b: 0.5, c: '#5ee6ff', n: 'node1' },
    { a: 2.4, b: -0.4, c: '#5ee6ff', n: 'node2' },
    { a: 4.4, b: 0.1, c: '#5ee6ff', n: 'node3' }
  ];
  function proj(x, y, z) {
    var c1 = Math.cos(rotY), s1 = Math.sin(rotY);
    var x1 = x * c1 + z * s1, z1 = -x * s1 + z * c1;
    var c2 = Math.cos(rotX), s2 = Math.sin(rotX);
    var y2 = y * c2 - z1 * s2, z2 = y * s2 + z1 * c2;
    return [CX + x1 * R, CY - y2 * R, z2];
  }

  var agents = [];      // живые частицы
  var addrPool = [];    // реальные адреса из очереди
  var seenJobs = {};    // jobId -> true (показанные выплаты)
  var height = null, aucOpen = 0, paidTotal = null;
  var mouseX = 0.5, mouseY = 0.5, pinned = null;

  function short(a) { return a ? a.slice(0, 9) + '…' : '—'; }
  function say(html) {
    if (!feed) return;
    var li = document.createElement('li');
    var t = new Date();
    var hh = ('0' + t.getHours()).slice(-2), mm = ('0' + t.getMinutes()).slice(-2);
    li.innerHTML = '<span class="dimt">[' + hh + ':' + mm + ']</span> ' + html;
    feed.insertBefore(li, feed.firstChild);
    while (feed.children.length > 9) feed.removeChild(feed.lastChild);
  }
  function jget(u) { return fetch(u).then(function (r) { return r.json(); }).catch(function () { return null; }); }

  function spawn(fromPool) {
    var addr = fromPool && fromPool.length ? fromPool[Math.floor(Math.random() * fromPool.length)] : ('AGTprobe' + Math.floor(Math.random() * 899 + 100));
    var th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
    var d = 3.2 + Math.random() * 1.5;
    agents.push({
      addr: addr, state: 'arrive', t: 0,
      p: [Math.sin(ph) * Math.cos(th) * d, Math.cos(ph) * d, Math.sin(ph) * Math.sin(th) * d],
      orbit: Math.random() * Math.PI * 2, speed: 0.35 + Math.random() * 0.3,
      tilt: 0.5 + Math.random() * 0.3, flash: 0, probe: !fromPool || !fromPool.length
    });
    if (agents.length > 14) agents.shift();
  }

  function poll() {
    jget('/api/v1/queue/status').then(function (d) {
      if (!d) return;
      var list = d.nextFive || [];
      addrPool = list.slice(0, 8);
      if (height === null && feed && feed.children.length === 0 && list.length === 0)
        say('очередь пуста — стань первым: <a href="/create-wallet">стать агентом</a>');
    });
    jget('/queue/history').then(function (d) {
      var h = (d && d.history) || [];
      h.slice(0, 6).forEach(function (e) {
        if (!e || !e.jobId || seenJobs[e.jobId]) return;
        seenJobs[e.jobId] = 1;
        say('⚜ <b>' + short(e.agent) + '</b> сдал «' + String(e.summary || '').slice(0, 60) + '…» → выплата ончейн');
        var a = agents.find(function (x) { return x.addr === e.agent && x.state === 'work'; });
        if (a) { a.state = 'paid'; a.t = 0; a.flash = 1; }
      });
    });
    jget('/api/v1/jobs/auction/list').then(function (d) {
      var n = 0;
      ((d && d.auctions) || []).forEach(function (a) {
        if (a.status === 'commit') { n++; if (a.commits > (a._seen || 0)) { a._seen = a.commits; } }
      });
      if (n > aucOpen && aucOpen > 0) say('⚔ новая ставка commit на аукционе (' + n + ' открыто)');
      aucOpen = n;
    });
    jget('/api/v1/jobs/state').then(function (d) {
      if (d && d.stats) paidTotal = d.stats.paid;
    });
    jget('/api/v1/life').then(function (d) {
      if (d && d.blocks) height = d.blocks;
    });
  }

  // начальный рой из реальных адресов
  jget('/api/v1/queue/status').then(function (d) {
    var list = (d && d.nextFive) || [];
    addrPool = list.slice(0, 8);
    var n = list.length ? Math.min(7, list.length) : 3;
    for (var i = 0; i < n; i++) {
      spawn(list.length ? list : null);
      var a = agents[agents.length - 1];
      a.state = 'work'; a.orbit = (i / n) * Math.PI * 2;
      a.p = [Math.cos(a.orbit) * 1.25, 0, Math.sin(a.orbit) * 1.25];
    }
    poll(); setInterval(poll, 15000);
  });

  cv.addEventListener('mousemove', function (e) {
    var r = cv.getBoundingClientRect();
    mouseX = (e.clientX - r.left) / r.width; mouseY = (e.clientY - r.top) / r.height;
  });
  cv.addEventListener('click', function (e) {
    var r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    var best = null, bd = 26;
    agents.forEach(function (a) {
      if (!a._sx) return;
      var dd = Math.hypot(a._sx - mx, a._sy - my);
      if (dd < bd) { bd = dd; best = a; }
    });
    pinned = best;
    if (info) info.innerHTML = best
      ? '◉ <b>' + best.addr + '</b>' + (best.probe ? ' (демо-точка, очередь пуста)' : '') + ' · ' + ({ arrive: 'прибывает в экосистему', work: 'выполняет задачу', paid: 'получил выплату ✓', leave: 'уходит, вернётся' }[best.state] || best.state)
      : 'кликни по точке-агенту — покажу адрес и статус';
  });
  if (btn) btn.addEventListener('click', function () {
    paused = !paused;
    btn.textContent = paused ? '▶ продолжить' : '⏸ пауза';
    if (paused === false) requestAnimationFrame(frame);
  });

  var lastSpawn = 0;
  function frame(ts) {
    if (paused) { draw(true); return; }
    rotY += 0.0022;
    tiltTX += ((mouseX - 0.5) * 0.35 - tiltTX) * 0.04;
    tiltTY += ((mouseY - 0.5) * 0.25 - tiltTY) * 0.04;
    if (ts - lastSpawn > 5200 && agents.length < 12) { lastSpawn = ts; spawn(addrPool.length ? addrPool : null); }
    agents.forEach(function (a) {
      a.t += 1 / 60;
      if (a.state === 'arrive') {
        var k = Math.min(1, a.t / 2.4), e = 1 - Math.pow(1 - k, 2);
        var tx = Math.cos(a.orbit) * 1.25, tz = Math.sin(a.orbit) * 1.25;
        a.p = [a.p[0] + (tx - a.p[0]) * e * 0.06, a.p[1] * (1 - e * 0.04), a.p[2] + (tz - a.p[2]) * e * 0.06];
        if (Math.hypot(a.p[0] - tx, a.p[2] - tz) < 0.12) { a.state = 'work'; a.t = 0; }
      } else if (a.state === 'work') {
        a.orbit += a.speed / 60;
        var wob = Math.sin(a.t * 2) * 0.05;
        a.p = [Math.cos(a.orbit) * (1.25 + wob), Math.sin(a.orbit * 2) * 0.12 * a.tilt, Math.sin(a.orbit) * (1.25 + wob)];
        if (a.t > 26) { a.state = 'leave'; a.t = 0; }
      } else if (a.state === 'paid') {
        a.flash = Math.max(0, (a.flash || 1) - 1 / 60);
        a.orbit += a.speed / 60;
        a.p = [Math.cos(a.orbit) * 1.25, Math.sin(a.orbit * 2) * 0.12, Math.sin(a.orbit) * 1.25];
        if (a.t > 2.5) { a.state = 'leave'; a.t = 0; }
      } else if (a.state === 'leave') {
        var L = Math.min(1, a.t / 2.2);
        a.p = [a.p[0] * (1 + L * 0.05), a.p[1] * (1 + L * 0.05) + L * 0.4, a.p[2] * (1 + L * 0.05)];
        if (L >= 1) { a.dead = true; }
      }
    });
    for (var i = agents.length - 1; i >= 0; i--) if (agents[i].dead) agents.splice(i, 1);
    draw(false);
    if (!paused) requestAnimationFrame(frame);
  }

  function draw(static_) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    var i, p, s;
    // орбитальное кольцо задач
    ctx.save(); ctx.translate(CX + tiltTX * 60, CY + tiltTY * 40);
    ctx.strokeStyle = 'rgba(232,185,35,0.35)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(0, 0, R * 1.25, R * 0.42, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    // оболочка сферы
    for (i = 0; i < shell.length; i++) {
      p = proj(shell[i][0], shell[i][1], shell[i][2]);
      var depth = (p[2] + 1) / 2;
      ctx.fillStyle = 'rgba(212,175,55,' + (0.10 + depth * 0.5).toFixed(2) + ')';
      var sz = 1 + depth * 1.6;
      ctx.fillRect(p[0] - tiltTX * 30 * depth, p[1] - tiltTY * 20 * depth, sz, sz);
    }
    // ноды меша
    meshNodes.forEach(function (m, k) {
      var mx = Math.cos(m.a + rotY * 0.6) * Math.cos(m.b), mz = Math.sin(m.a + rotY * 0.6) * Math.cos(m.b), my = Math.sin(m.b);
      s = proj(mx, my, mz);
      ctx.fillStyle = m.c;
      ctx.beginPath(); ctx.arc(s[0], s[1], 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(94,230,255,0.75)';
      ctx.font = '10px monospace'; ctx.fillText(m.n, s[0] + 6, s[1] - 4);
    });
    // ядро + высота
    var pulse = 1 + Math.sin(Date.now() / 900) * 0.08;
    var g = ctx.createRadialGradient(CX, CY, 2, CX, CY, 34 * pulse);
    g.addColorStop(0, 'rgba(255,215,94,0.95)'); g.addColorStop(0.5, 'rgba(232,185,35,0.35)'); g.addColorStop(1, 'rgba(232,185,35,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(CX, CY, 34 * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#0d1117'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'center';
    ctx.fillText(height ? ('#' + height) : '…', CX, CY + 4);
    ctx.textAlign = 'left';
    // агенты
    agents.forEach(function (a) {
      s = proj(a.p[0], a.p[1], a.p[2]);
      a._sx = s[0]; a._sy = s[1];
      var col = a.state === 'work' ? '94,230,255' : a.state === 'paid' ? '255,215,94' : '200,208,219';
      if (a.flash > 0) {
        ctx.strokeStyle = 'rgba(255,215,94,' + a.flash.toFixed(2) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(s[0], s[1], 6 + (1 - a.flash) * 22, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(' + col + ',0.95)';
      ctx.beginPath(); ctx.arc(s[0], s[1], a === pinned ? 5 : 3.6, 0, Math.PI * 2); ctx.fill();
      if (a === pinned || a.state === 'paid') {
        ctx.fillStyle = 'rgba(232,185,35,0.9)'; ctx.font = '10px monospace';
        ctx.fillText(short(a.addr), s[0] + 7, s[1] + 3);
      }
    });
    if (static_) { /* один кадр */ }
  }
  requestAnimationFrame(frame);
})();
