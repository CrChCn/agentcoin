#!/usr/bin/env node
/* gov-passports.mjs — AGIP-10 кампания: перевод паспортов в governed (vat-режим).
 *
 * Империя платит налоги сама: каждый армейский агент получает vat-паспорт
 * со страной AGT (ISO-подобный код империи) и ставкой 100 bps (1%).
 * Фонд: AGT_TAX_AGT — общая казна налоговых поступлений империи.
 *
 * Механика: медленный обход паспорта за паспортом через реальный
 * POST /passport/issue на живой ноде (та же честная обработка, что и у людей;
 * rate-friends не используются). Если паспорт уже есть → 409 (ок, пропускаем).
 *
 * Запуск: node gov-passports.mjs [port=9335] [batch=50]
 */
'use strict';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.argv[2]) || 9335;
const API = `http://127.0.0.1:${PORT}`;
const BATCH = Number(process.argv[3]) || 50;
const ROOT = process.cwd();
const PASSPORTS = path.join(ROOT, 'data-agents', 'passports.json');
const GATE = path.join(ROOT, 'data', 'gate.json');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function log(l) { console.log(`[gov-camp ${new Date().toISOString().slice(11, 19)}] ${l}`); }

async function api(method, p, body = null) {
  try {
    const r = await fetch(API + p, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  } catch (e) { return { status: 0, body: { error: e.message } }; }
}

async function main() {
  const passports = JSON.parse(fs.readFileSync(PASSPORTS, 'utf8'));
  log(`кампания по ${passports.length} паспортам, батч ${BATCH}`);
  let gateApproved = new Set();
  try {
    const g = JSON.parse(fs.readFileSync(GATE, 'utf8'));
    gateApproved = new Set(Object.keys(g.approved || {}));
  } catch { log('gate.json нет — скипаем проверку пропусков (нода сама скажет)'); }

  let ok = 0, exists = 0, gateMiss = 0, err = 0;
  for (let i = 0; i < passports.length; i++) {
    const rec = passports[i];
    if (rec.revoked) continue;
    if (rec.tax && rec.tax.regime === 'vat') { exists++; continue; }
    if (gateApproved.size && !gateApproved.has(String(rec.address).toLowerCase())) { gateMiss++; continue; }

    // 1) POST /passport/issue → 201 (новый паспорт) или 409 (уже есть)
    // 2) 409 → POST /passport/tax → вносим vat-самодекларацию в реестр
    const r = await api('POST', '/passport/issue', {
      address: rec.address,
      handle: rec.handle,
      tax: { regime: 'vat', country: 'AGT', rateBps: 100, fund: 'AGT_TAX_AGT' },
    });
    let RES = r;
    for (let retry = 0; RES.status === 503 && retry < 5; retry++) {
      await sleep(4000 * (retry + 1));
      RES = await api('POST', '/passport/issue', { address: rec.address, handle: rec.handle, tax: { regime: 'vat', country: 'AGT', rateBps: 100, fund: 'AGT_TAX_AGT' } });
    }
    if (RES.status === 201) {
      ok++;
    } else if (RES.status === 409) {
      // паспорт уже есть — вносим tax через /passport/tax
      let RT = await api('POST', '/passport/tax', { address: rec.address, tax: { regime: 'vat', country: 'AGT', rateBps: 100, fund: 'AGT_TAX_AGT' } });
      for (let retry = 0; RT.status === 503 && retry < 5; retry++) {
        await sleep(4000 * (retry + 1));
        RT = await api('POST', '/passport/tax', { address: rec.address, tax: { regime: 'vat', country: 'AGT', rateBps: 100, fund: 'AGT_TAX_AGT' } });
      }
      if (RT.status === 200) ok++; else if (RT.status === 404) exists++; else { err++; if (err <= 5) log(`⚠ tax ${rec.address.slice(0, 12)}: ${RT.status} ${JSON.stringify(RT.body).slice(0, 80)}`); }
    } else if (RES.status === 429) { gateMiss++; }
    else { err++; if (err <= 5) log(`⚠ ${rec.address.slice(0, 12)}: ${RES.status} ${JSON.stringify(RES.body).slice(0, 80)}`); }

    if (i % 20 === 0) log(`прошли ${i}/${passports.length} · ok=${ok} exists=${exists} gateMiss=${gateMiss} err=${err}`);
    await sleep(700); // бережём event-loop ноды (майнер держит сердце)
    if (i >= BATCH) { log(`батч ${BATCH} закончен, стоп (перезапусти для продолжения)`); break; }
  }
  log(`ИТОГ кампании (батч): ok=${ok} already=${exists} gate=${gateMiss} err=${err}`);
}

main().catch(e => { console.error('[gov-camp] FATAL', e); process.exit(1); });
