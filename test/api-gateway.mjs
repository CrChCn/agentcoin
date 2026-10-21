import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiGatewayPilot } from '../api-gateway.mjs';
const tx = 'a'.repeat(64), block = 'b'.repeat(64);
const request = { model: 'fixture', prompt: 'A synthetic test only', maxTokens: 20 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-api-pilot-'));
  let now = 10000, calls = 0, mode = 'ok';
  const config = { file: path.join(root, 'journal.json'), network: 'TEST_ONLY', genesisHash: '0'.repeat(64), recipient: 'AGT'+'c'.repeat(40), service: 'fixture-text', priceUnits: '1000000000', budgetMinor: 100, now: () => now,
    verifyPayment: async ({txid, orderId, quote}) => ({ verified: mode !== 'reorg', canonical: mode !== 'reorg', confirmations: 2, txid, orderId, network: quote.network, genesisHash: quote.genesisHash, recipient: quote.recipient, amountUnits: quote.priceUnits, blockHash: block }),
    provider: async () => { calls++; if(mode==='timeout') throw Error('timeout'); if(overrides.holdMs) await sleep(overrides.holdMs); return {text:'Synthetic response',currency:'USD',actualCostMinor:3}; }
  };
  let g = new ApiGatewayPilot(config);
  return { root, config, get g(){return g;}, calls:()=>calls, mode:v=>mode=v, advance:()=>now+=100000, restart:()=>{g.close();g=new ApiGatewayPilot(config);}, close:()=>{g.close();fs.rmSync(root,{recursive:true,force:true});}, quote:()=>g.quote({...request,maxCostMinor:5,currency:'USD'}) };
}
test('quote -> verified test payment -> provider -> durable receipt, no duplicate call',async()=>{
 const f=fixture();try{const q=f.quote(),o=f.g.order(q.quoteId);assert.equal(f.g.order(q.quoteId).orderId,o.orderId);
 await f.g.confirm(o.orderId,tx);const r=await f.g.execute(o.orderId,request);assert.equal(r.chargedUnits,'1000000000');assert.equal(r.actualCostMinor,3);assert.equal(f.calls(),1);
 f.restart();const again=await f.g.execute(o.orderId,request);assert.equal(again.resultHash,r.resultHash);assert.equal(f.calls(),1);
 assert.ok(!fs.readFileSync(f.config.file,'utf8').includes(request.prompt));
 }finally{f.close();}
});
test('unpaid, expired quotes, incorrect request and wrong currency never invoke provider',async()=>{
 const f=fixture();try{const q=f.quote(),o=f.g.order(q.quoteId);await assert.rejects(f.g.execute(o.orderId,request),/not_executable/);
 assert.throws(()=>f.g.quote({...request,maxCostMinor:1,currency:'EUR'}),/limits/);await f.g.confirm(o.orderId,tx);await assert.rejects(f.g.execute(o.orderId,{...request,prompt:'changed'}),/mismatch/);
 const expired=f.quote();f.advance();assert.throws(()=>f.g.order(expired.quoteId),/expired/);assert.equal(f.calls(),0);
 }finally{f.close();}
});
test('reorg before execution blocks provider',async()=>{
 const f=fixture();try{const o=f.g.order(f.quote().quoteId);await f.g.confirm(o.orderId,tx);f.mode('reorg');await assert.rejects(f.g.execute(o.orderId,request),/recheck/);assert.equal(f.calls(),0);}finally{f.close();}
});
test('same transaction cannot fund two orders including a parallel race',async()=>{
 const f=fixture();try{const a=f.g.order(f.quote().quoteId),b=f.g.order(f.quote().quoteId);const r=await Promise.allSettled([f.g.confirm(a.orderId,tx),f.g.confirm(b.orderId,tx)]);assert.equal(r.filter(v=>v.status==='fulfilled').length,1);}finally{f.close();}
});
test('provider timeout stays unknown across restart and never blindly calls again',async()=>{
 const f=fixture();try{const o=f.g.order(f.quote().quoteId);await f.g.confirm(o.orderId,tx);f.mode('timeout');await assert.rejects(f.g.execute(o.orderId,request),/unknown/);f.restart();assert.equal(f.g.inspect(o.orderId).refundReview,true);await assert.rejects(f.g.execute(o.orderId,request),/not_executable/);assert.equal(f.calls(),1);}finally{f.close();}
});
test('single journal owner, persisted budget and config pin survive restart',()=>{
 const f=fixture();try{assert.throws(()=>new ApiGatewayPilot(f.config),/EEXIST/);for(let i=0;i<20;i++)f.g.order(f.quote().quoteId);f.restart();assert.throws(()=>f.g.order(f.quote().quoteId),/budget_exhausted/);}finally{f.close();}
});
test('crash marker executing recovers unknown without invoking provider',async()=>{
 const f=fixture();try{const o=f.g.order(f.quote().quoteId);await f.g.confirm(o.orderId,tx);f.g.close();const data=JSON.parse(fs.readFileSync(f.config.file));data.orders[o.orderId].status='executing';fs.writeFileSync(f.config.file,JSON.stringify(data));f.restart();assert.equal(f.g.inspect(o.orderId).status,'execution_unknown');await assert.rejects(f.g.execute(o.orderId,request),/not_executable/);assert.equal(f.calls(),0);}finally{f.close();}
});
// --- EMPIRE-PILOT-01 review closeout (CLOUD-API-02): the five flagged gaps ---
test('economic units cap and new option validation reject bad configs',()=>{ // units beyond planned supply; quoteLimit/resultTtl bounds
 const f=fixture();try{
  assert.throws(()=>new ApiGatewayPilot({...f.config,priceUnits:(21_000_000n*1_000_000_000n+1n).toString()}),/price_units_beyond_supply/);
  assert.throws(()=>new ApiGatewayPilot({...f.config,quoteLimit:5}),/quote_limit/);
  assert.throws(()=>new ApiGatewayPilot({...f.config,quoteLimit:10001}),/quote_limit/);
  assert.throws(()=>new ApiGatewayPilot({...f.config,resultTtlMs:-1}),/result_ttl/);
  f.close(); // free the lock before the valid-config probes open their own files
  const cap='21000000000000000'; assert.doesNotThrow(()=>{const x=new ApiGatewayPilot({...f.config,file:f.config.file.replace('journal.json','cap-ok.json'),priceUnits:cap});x.close();});
  assert.doesNotThrow(()=>{const x=new ApiGatewayPilot({...f.config,file:f.config.file.replace('journal.json','ttl-ok.json'),resultTtlMs:0});x.close();});
 }finally{f.close();}
});
test('journal stays bounded: quotes pruned to quoteLimit, orders and payments never evicted',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'agt-api-bounds-'));
 let g=null;try{const cfg={file:path.join(root,'journal.json'),network:'TEST_ONLY',genesisHash:'0'.repeat(64),recipient:'AGT'+'c'.repeat(40),service:'fixture-text',priceUnits:'1000000000',budgetMinor:100,now:()=>10000,
  verifyPayment:async({txid:txid2,orderId,quote})=>({verified:true,canonical:true,confirmations:2,txid:txid2,orderId,network:quote.network,genesisHash:quote.genesisHash,recipient:quote.recipient,amountUnits:quote.priceUnits,blockHash:block}),
  provider:async()=>({text:'x',currency:'USD',actualCostMinor:1}),quoteLimit:10};
  g=new ApiGatewayPilot(cfg);
  const q0=g.quote({...request,maxCostMinor:5,currency:'USD'});const o=g.order(q0.quoteId);
  for(let i=0;i<15;i++)g.quote({...request,maxCostMinor:5,currency:'USD'});
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(cfg.file,'utf8')).quotes).length,10);
  assert.throws(()=>g.order(q0.quoteId),/quote_not_found/); // evicted quote cannot mint new orders
  assert.ok(JSON.parse(fs.readFileSync(cfg.file,'utf8')).orders[o.orderId], 'order survives quote eviction');
  const qLast=Object.values(JSON.parse(fs.readFileSync(cfg.file,'utf8')).quotes)[9];
  assert.doesNotThrow(()=>g.order(qLast.quoteId)); // freshest quotes still orderable
 }finally{if(g)g.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('parallel execute of the same order runs provider exactly once, loser rejects',async()=>{
 const f=fixture({holdMs:40});try{const q=f.quote(),o=f.g.order(q.quoteId);await f.g.confirm(o.orderId,tx);
 const r=await Promise.allSettled([f.g.execute(o.orderId,request),f.g.execute(o.orderId,request)]);
 assert.equal(r.filter(v=>v.status==='fulfilled').length,1);
 const rej=r.find(v=>v.status==='rejected').reason;assert.match(String(rej&&rej.message||rej),/execution_race/);
 assert.equal(f.calls(),1); // idempotency key: one provider call, one charge
 }finally{f.close();}
});
test('result after settled survives restart: retrieval without a new purchase, tamper is rejected',async()=>{
 const f=fixture();try{const q=f.quote(),o=f.g.order(q.quoteId);await f.g.confirm(o.orderId,tx);const r=await f.g.execute(o.orderId,request);assert.equal(f.calls(),1);
 assert.ok(!fs.readFileSync(f.config.file,'utf8').includes('Synthetic response') || 'journal may not embed result text');
 f.restart();
 const again=await f.g.execute(o.orderId,request);assert.equal(again.text,'Synthetic response');assert.equal(again.resultHash,r.resultHash);assert.equal(f.calls(),1);
 const got=f.g.retrieveResult(o.orderId);assert.equal(got.text,'Synthetic response');assert.equal(got.actualCostMinor,3);
 // tamper the side file: hash-integrity check must refuse it after a reload
 const rf=f.config.file+'.results.json';const data=JSON.parse(fs.readFileSync(rf,'utf8'));data[o.orderId].text='tampered';fs.writeFileSync(rf,JSON.stringify(data));
 f.restart();
 assert.throws(()=>f.g.retrieveResult(o.orderId),/integrity/);
 }finally{f.close();}
});
test('result TTL expires without a new purchase and without provider reuse',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'agt-api-ttl-'));
 try{const cfg={file:path.join(root,'journal.json'),network:'TEST_ONLY',genesisHash:'0'.repeat(64),recipient:'AGT'+'c'.repeat(40),service:'fixture-text',priceUnits:'1000000000',budgetMinor:100,now:()=>10000,
  verifyPayment:async({txid:txid2,orderId,quote})=>({verified:true,canonical:true,confirmations:2,txid:txid2,orderId,network:quote.network,genesisHash:quote.genesisHash,recipient:quote.recipient,amountUnits:quote.priceUnits,blockHash:block}),
  provider:async()=>({text:'Synthetic response',currency:'USD',actualCostMinor:3}),resultTtlMs:5000};
  const g=new ApiGatewayPilot(cfg);
  const q=g.quote({...request,maxCostMinor:5,currency:'USD'});const o=g.order(q.quoteId);await g.confirm(o.orderId,tx);
  await g.execute(o.orderId,request); // result stored with storedAt=10000
  g.close(); // releases lock; result side-file persists
  const late=new ApiGatewayPilot({...cfg,now:()=>110000});
  await assert.rejects(late.execute(o.orderId,request),/result_expired/);
  late.close();
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
