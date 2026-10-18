import test from 'node:test';
import assert from 'node:assert/strict';
import {createNodeMonitor} from '../node-monitor.mjs';
const self=()=>({ok:true,service:'agt-node',blocks:100,tipHash:'a',tipAgeSec:999,chainValid:null});
test('remote dashboard includes its responding node; stale tip is not a crash',async()=>{
 const monitor=createNodeMonitor({selfHealth:self}); const r=await monitor();
 assert.equal(r.nodes.length,1);assert.equal(r.nodes[0].reachable,true);assert.equal(r.nodes[0].status,'stale_tip');assert.equal(r.nodes[0].chainValid,null);
});
test('fixed targets, real observed height difference, single flight and cache',async()=>{
 let calls=0,clock=0;let resolve;const gate=new Promise(r=>resolve=r);
 const monitor=createNodeMonitor({targets:[{name:'B',url:'http://127.0.0.1:9999'}],selfHealth:self,now:()=>clock,fetchFn:async(url,opts)=>{
  calls++;assert.equal(url,'http://127.0.0.1:9999/health');assert.equal(opts.redirect,'error');await gate;return new Response(JSON.stringify({ok:true,service:'agt-node',blocks:102,tipAgeSec:12}));}});
 const a=monitor(),b=monitor();resolve();const [x,y]=await Promise.all([a,b]);assert.equal(calls,1);assert.deepEqual(x,y);assert.equal(x.nodes[0].behindObserved,2);assert.equal(x.nodes[0].status,'lower_observed_height');
 x.nodes[0].blocks=0;assert.equal((await monitor()).nodes[0].blocks,100);assert.equal(calls,1);clock=10001;await monitor();assert.equal(calls,2);
});
test('bad HTTP200 service stays unreachable; probe does not publish target URL',async()=>{
 const r=await createNodeMonitor({targets:[{name:'B',url:'http://localhost:9999'}],selfHealth:self,fetchFn:async()=>new Response('{}')})();
 assert.equal(r.nodes[1].reachable,false);assert.equal(JSON.stringify(r).includes('localhost'),false);
 assert.throws(()=>createNodeMonitor({selfHealth:self,targets:[{name:'B',url:'file:///etc/passwd'}]}));
});
test('oversized streamed peer health is cancelled before the full body is buffered',async()=>{
 let cancelled=false,pulls=0;
 const body=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(8192));},cancel(){cancelled=true;}});
 const r=await createNodeMonitor({targets:[{name:'large-peer',url:'http://127.0.0.1:9999'}],selfHealth:self,
  fetchFn:async()=>new Response(body)})();
 assert.equal(r.nodes[1].reachable,false);assert.equal(r.nodes[1].status,'unreachable');
 assert.equal(cancelled,true);assert.ok(pulls<=5,'reader must stop near 16KiB, not consume an unbounded stream');
 assert.equal(r.nodes[0].reachable,true);assert.equal(JSON.stringify(r).includes('127.0.0.1'),false);
});
