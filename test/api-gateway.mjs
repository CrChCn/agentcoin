import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ApiGatewayPilot } from '../api-gateway.mjs';
const tx = 'a'.repeat(64), block = 'b'.repeat(64);
const request = { model: 'fixture', prompt: 'A synthetic test only', maxTokens: 20 };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-api-pilot-'));
  let now = 10000, calls = 0, mode = 'ok';
  const config = { file: path.join(root, 'journal.json'), network: 'TEST_ONLY', genesisHash: '0'.repeat(64), recipient: 'AGT'+'c'.repeat(40), service: 'fixture-text', priceUnits: '1000000000', budgetMinor: 100, now: () => now,
    verifyPayment: async ({txid, orderId, quote}) => ({ verified: mode !== 'reorg', canonical: mode !== 'reorg', confirmations: 2, txid, orderId, network: quote.network, genesisHash: quote.genesisHash, recipient: quote.recipient, amountUnits: quote.priceUnits, blockHash: block }),
    provider: async () => { calls++; if(mode==='timeout') throw Error('timeout'); return {text:'Synthetic response',currency:'USD',actualCostMinor:3}; }
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
