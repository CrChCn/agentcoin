/* ============================================================
   network-canvas.js — «Живой Организм» (фоновая сеть AGENTCOIN)
   Canvas на весь экран: ноды, золотые связи, зелёные пульсы-«транзакции».
   Только фон: контент страниц не трогает (z-index 0, pointer-events none).
   API: window.NetworkCanvas = { init, start, stop, pulse, isRunning }.
============================================================ */
(function () {
  'use strict';
  if (window.NetworkCanvas) return; // повторное подключение безопасно

  var REDUCED = false;
  try { REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}

  var canvas = null, ctx = null, nodes = [], pulses = [], raf = 0;
  var running = false, DPR = 1, W = 0, H = 0, LINK_DIST = 150, SPAWN_MS = 1400, lastSpawn = 0;
  var GOLD = '212,175,55', GREEN = '57,217,138';

  function nodeCount() {
    var area = window.innerWidth * window.innerHeight;
    if (window.innerWidth < 560) return 24;          // мобильный
    if (window.innerWidth < 1024) return 32;         // планшет
    return Math.min(50, Math.max(45, Math.round(area / 26000)));
  }

  function makeNode() {
    return {
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25,
      r: 1.1 + Math.random() * 1.6,
      a: 0.35 + Math.random() * 0.5,
      t: Math.random() * 6.283,
      tw: 0.4 + Math.random() * 0.8,
    };
  }

  function resize() {
    if (!canvas || !ctx) return;
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, window.innerWidth); H = Math.max(1, window.innerHeight);
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    LINK_DIST = W < 560 ? 110 : 150;
    var target = nodeCount();
    while (nodes.length > target) nodes.pop();
    while (nodes.length < target) nodes.push(makeNode());
  }

  function paint(ts) {
    ctx.clearRect(0, 0, W, H);
    var i, j;
    for (i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      n.x += n.vx; n.y += n.vy; n.t += n.tw * 0.02;
      if (n.x < -20 || n.x > W + 20) n.vx *= -1;
      if (n.y < -20 || n.y > H + 20) n.vy *= -1;
    }
    for (i = 0; i < nodes.length; i++) {
      for (j = i + 1; j < nodes.length; j++) {
        var a = nodes[i], b = nodes[j];
        var dx = a.x - b.x, dy = a.y - b.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d < LINK_DIST) {
          ctx.strokeStyle = 'rgba(' + GOLD + ',' + ((1 - d / LINK_DIST) * 0.28).toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    if (ts - lastSpawn > SPAWN_MS && nodes.length > 2) {
      lastSpawn = ts;
      var p0 = nodes[(Math.random() * nodes.length) | 0];
      var p1 = nodes[(Math.random() * nodes.length) | 0];
      if (p0 !== p1) pulses.push({ from: p0, to: p1, k: 0, speed: 0.006 + Math.random() * 0.005 });
    }
    for (i = pulses.length - 1; i >= 0; i--) {
      var p = pulses[i];
      p.k += p.speed;
      if (p.k >= 1) { pulses.splice(i, 1); continue; }
      var px = p.from.x + (p.to.x - p.from.x) * p.k;
      var py = p.from.y + (p.to.y - p.from.y) * p.k;
      ctx.fillStyle = 'rgba(' + GREEN + ',0.9)';
      ctx.beginPath(); ctx.arc(px, py, 2.1, 0, 6.283); ctx.fill();
      ctx.strokeStyle = 'rgba(' + GREEN + ',0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(p.from.x, p.from.y); ctx.lineTo(px, py); ctx.stroke();
    }
    for (i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      var tw = 0.55 + Math.sin(nd.t) * 0.35;
      ctx.fillStyle = 'rgba(' + GOLD + ',' + (nd.a * tw).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r, 0, 6.283); ctx.fill();
    }
  }

  function frame(ts) {
    if (!running) return;
    paint(ts);
    raf = requestAnimationFrame(frame);
  }

  function init() {
    if (canvas) return canvas;
    canvas = document.createElement('canvas');
    canvas.id = 'network-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.setAttribute('data-agentcoin-network', '1');
    canvas.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;opacity:0.42';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', resize);
    return canvas;
  }

  function start() {
    if (running || REDUCED || !canvas) return;
    running = true;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (ctx) ctx.clearRect(0, 0, W, H);
  }
  function pulse(n) {
    for (var i = 0; i < (n || 3); i++) if (nodes.length > 2)
      pulses.push({ from: nodes[(Math.random() * nodes.length) | 0], to: nodes[(Math.random() * nodes.length) | 0], k: 0, speed: 0.01 });
  }

  window.NetworkCanvas = { init: init, start: start, stop: stop, pulse: pulse, isRunning: function () { return running; }, renderOnce: function () { if (!canvas || !ctx) return false; resizeIfNeeded(); paint(performance.now()); return true; } };

  function resizeIfNeeded() {
    if (canvas.width !== Math.floor(W * Math.min(window.devicePixelRatio || 1, 2)) || W !== window.innerWidth) resize();
  }

  function boot() { init(); if (document.visibilityState !== 'hidden') start(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
  window.addEventListener('focus', start);
  window.addEventListener('blur', stop);
})();
