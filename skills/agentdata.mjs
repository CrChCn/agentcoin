#!/usr/bin/env node
/* ============================================================
   agentdata.mjs — СКИЛЛ ОБМЕНА ДАННЫМИ ЗА МИНИ-КОИН (AGT/MAGT)
   Единица: 1 MAGT = 0.000001 AGT. Один файл — одна зависимость:
   Node ≥ 18. Участник копирует файл к себе и работает.

   Роли:
     ПРОВАЙДЕР — публикует item с ценой (или serve-режим):
       node agentdata.mjs offer  <node> <wallet.json> <item> <priceM> [answerFile]
       node agentdata.mjs serve  <node> <wallet.json>            # живой автоответчик
     ПОКУПАТЕЛЬ — запрос → микро-оплата → ответ:
       node agentdata.mjs list   <node>
       node agentdata.mjs ask    <node> <item> <wallet.json>
   Кошелёк-файл: {"address":"…","pub":"…","privKey":"…"} (см. /wallet/create).
   С каждой сделки сеть берёт fee 0.5% (min 1 MAGT) → облачный фонд.
   ============================================================ */
'use strict';
import fs from 'node:fs';

const [, , cmd, ...a] = process.argv;
const loadWallet = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
async function api(base, method = 'GET', p = '/', body = null) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function main() {
  const [NODE, WALLET_FILE, ITEM, PRICE, ANSWER_FILE] = a;
  if (cmd === 'offer') {
    const w = loadWallet(WALLET_FILE);
    const answer = ANSWER_FILE ? fs.readFileSync(ANSWER_FILE, 'utf8').slice(0, 20000) : null;
    const r = await api(NODE, 'POST', '/data/register', { provider: w.address, item: ITEM, priceM: Number(PRICE) || 50, answer });
    console.log(JSON.stringify(r.body, null, 2));
  } else if (cmd === 'list') {
    const r = await api(NODE, 'GET', '/data/catalog');
    for (const it of r.body.items || []) console.log(`${it.item} — ${it.priceM} MAGT — provider ${it.provider?.slice(0, 14)}…`);
    if (!r.body.items?.length) console.log('(пусто)');
  } else if (cmd === 'ask') {
    const [node, itemStr, walletFile] = a; // порядок: node item wallet
    const w = loadWallet(walletFile);
    const c = await api(node, 'GET', '/data/catalog');
    const it = (c.body.items || []).find(x => x.item === itemStr);
    if (!it) return console.log('нет такого item в каталоге');
    const ask = await api(node, 'POST', '/data/ask', { item: itemStr, buyer: w.address });
    if (ask.status !== 201) return console.log('ask FAIL', ask.body);
    const pay = await api(node, 'POST', '/data/pay-ask', { askId: ask.body.askId, buyerAddress: w.address });
    if (pay.status !== 200) return console.log('pay FAIL', pay.body);
    console.log(`оплачено ${it.priceM} MAGT (fee ${pay.body.feeM} M сети), txid=${pay.body.txid}`);
    for (let i = 0; i < 20; i++) {
      await new Promise(re => setTimeout(re, 3000));
      const f = await api(node, 'GET', `/data/fetch?askId=${ask.body.askId}`);
      if (f.status === 200) { console.log('--- answer ---'); console.log(f.body.answer); console.log(`digest=${f.body.answerDigest}`); return; }
    }
    console.log('answer ещё не отдан (провайдер в serve-режиме отвечает позже)');
  } else if (cmd === 'serve') {
    const w = loadWallet(WALLET_FILE);
    console.log(`serve: ${w.address.slice(0, 14)}… ждём оплаченные asks…`);
    for (;;) {
      const q = await api(NODE, 'GET', `/data/asks?provider=${w.address}`);
      for (const ask of q.body.asks || []) {
        if (ask.status === 'paid') {
          const item = (await api(NODE, 'GET', '/data/catalog')).body.items.find(x => x.item === ask.item);
          const answer = item?.answer || `пыж: ${ask.item} @ ${new Date().toISOString()} — ответ провайдера ${w.address.slice(0, 10)}`;
          await api(NODE, 'POST', '/data/answer', { provider: w.address, askId: ask.askId, answer });
          console.log(`answered ${ask.askId} (${ask.item}, ${ask.priceM} M)`);
        }
      }
      await new Promise(re => setTimeout(re, 5000));
    }
  } else {
    console.log('cmds: offer | serve | list | ask');
  }
}
main().catch(e => { console.error('ERR', e.message); process.exit(1); });
