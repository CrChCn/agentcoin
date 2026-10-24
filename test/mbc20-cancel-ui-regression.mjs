import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createWallet, txDigest } from '../core.mjs';

// Runs the actual inline cancellation handler with a minimal DOM and real
// Ed25519/SHA-256. This is a unit regression, not a browser acceptance test.
const html=fs.readFileSync(new URL('../site/mbc20.html',import.meta.url),'utf8');
const script=[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].at(-1)[1];
const maker=createWallet('synthetic-cancel-ui');
const refs=['Order001','Order002'];
const orders=refs.map(ref=>({ref,from:maker.address,status:'open',item:'mbc20:TEST',side:'s',qty:2,price:1,filled:0}));
const pendingKey='agentcoin.mbc20.cancel.pending';
function harness(pending=null){
 const elements=new Map(), downloads=[], submitted=[], storage=new Map(pending?[[pendingKey,JSON.stringify(pending)]]:[]);
 class Element {
  constructor(id=''){this.id=id;this.value='';this.hidden=['cancelFlow','cancelSigningInstructions','checkCancelStatus'].includes(id);this.disabled=id==='sendCancel';this.children=[];this.dataset={};this.listeners={};this.textContent='';}
  addEventListener(event,fn){this.listeners[event]=fn;}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;}
  scrollIntoView(){}
  click(){return this.listeners.click?.({target:this});}
  get innerHTML(){return this.textContent.replaceAll('&','&amp;').replaceAll('<','&lt;');}
 }
 const el=id=>{if(!elements.has(id))elements.set(id,new Element(id));return elements.get(id);};
 let verifyGate=null;
 const subtle={digest:(...a)=>crypto.webcrypto.subtle.digest(...a),importKey:(...a)=>crypto.webcrypto.subtle.importKey(...a),verify:async(...a)=>{const valid=await crypto.webcrypto.subtle.verify(...a);if(verifyGate)await verifyGate();return valid;}};
 const context=vm.createContext({document:{getElementById:el,createElement:()=>new Element()},window:{},sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},location:{origin:'https://synthetic.example.test'},crypto:{subtle,getRandomValues:a=>crypto.webcrypto.getRandomValues(a)},URL:{createObjectURL:b=>{downloads.push(b);return 'blob:synthetic';},revokeObjectURL(){}},TextEncoder,Uint8Array,Uint32Array,Blob,AbortSignal,atob,setTimeout:(fn,ms)=>ms>=30000?0:setTimeout(fn,ms),fetch:async(route,options)=>{
  if(route.startsWith('/dxe/orders'))return {status:200,json:async()=>({orders})};
  if(route==='/info')return {status:200,json:async()=>({chainId:'AGENTCOIN',genesisHash:'a'.repeat(64)})};
  if(route==='/tx/preflight')return {status:200,json:async()=>({verdict:'preflight_pass',signature:{ok:true},network_ok:true,balance:{ok:true},nonce:{ok:true},fee:{amount:0}})};
  if(route==='/tx'){submitted.push(JSON.parse(options.body));throw Error('synthetic response loss after capture');}
  if(route.startsWith('/txproof/'))return {status:404,json:async()=>({})};
  throw Error('unexpected route '+route);
 }});
 vm.runInContext(script,context,{filename:'mbc20-cancellation-inline.js'});
 el('cancelAddress').value=maker.address;el('addrInput').value=maker.address;
 return {el,downloads,submitted,context,setVerifyGate:fn=>{verifyGate=fn;}};
}
async function waitFor(predicate){for(let i=0;i<1000;i++){if(predicate())return;await new Promise(r=>setImmediate(r));}throw Error('synthetic stage did not complete');}
async function prepare(h,ref){h.context.window.selectMbc20CancellationOrder(ref);await waitFor(()=>h.el('cancelOrderDetails').textContent.includes(ref));await h.el('prepareCancelRequest').click();return JSON.parse(await h.downloads.at(-1).text());}
function answer(request){const tx={...request.tx,fromPub:maker.pub};assert.equal(tx.txid,txDigest(tx));tx.signature=crypto.sign(null,Buffer.from(tx.txid,'hex'),maker.privKey).toString('hex');return {schema:'agt-dxe-cancel-response-v1',nodeUrl:request.nodeUrl,network:request.network,genesisHash:request.genesisHash,ref:request.ref,tx};}
function upload(h,response){const content=JSON.stringify(response);const file={size:Buffer.byteLength(content),text:async()=>content};return h.el('cancelResponseFile').listeners.change({target:{files:[file]}});}

test('pending cancellation remains visible and status can be checked after reload',async()=>{
 const h=harness({address:maker.address,ref:refs[0],txid:'b'.repeat(64),at:Date.now()});
 await h.el('loadMyOrders').click();
 assert.equal(h.el('cancelFlow').hidden,false,'pending status controls must not be inside a hidden section');
 assert.equal(h.el('checkCancelStatus').hidden,false);
});

test('a delayed signature verification cannot enable or submit a different selected order',async()=>{
 const h=harness();const requestA=await prepare(h,refs[0]);
 let release,entered;const paused=new Promise(r=>release=r),verificationEntered=new Promise(r=>entered=r);
 h.setVerifyGate(async()=>{entered();await paused;});
 const oldUpload=upload(h,answer(requestA));await verificationEntered;
 await prepare(h,refs[1]);
 release();await oldUpload;
 const disabled=h.el('sendCancel').disabled;
 await h.el('sendCancel').click();
 assert.equal(h.submitted.length,0,'no stale cancellation may be posted after selecting B');
 assert.equal(disabled,true,'verification for order A must not enable submit after selecting B');
});

test('a valid response still enables exactly one submission for its unchanged request',async()=>{
 const h=harness();const request=await prepare(h,refs[0]);await upload(h,answer(request));
 assert.equal(h.el('sendCancel').disabled,false);
 await h.el('sendCancel').click();await h.el('sendCancel').click();
 assert.equal(h.submitted.length,1);
 assert.equal(h.submitted[0].memo,'dxe|C|'+refs[0]);
});

test('pending status is available immediately on reload without entering an address again',()=>{
 const h=harness({address:maker.address,ref:refs[0],txid:'b'.repeat(64),at:Date.now()});
 assert.equal(h.el('cancelAddress').value,maker.address);
 assert.equal(h.el('cancelFlow').hidden,false);
 assert.equal(h.el('checkCancelStatus').hidden,false);
 assert.equal(h.el('sendCancel').disabled,true);
});

test('an old failed file read cannot clear a newer valid signature',async()=>{
 const h=harness();const request=await prepare(h,refs[0]);
 let rejectRead;const pendingRead=new Promise((_,reject)=>rejectRead=reject);
 const oldRead=h.el('cancelResponseFile').listeners.change({target:{files:[{size:20,text:()=>pendingRead}]}});
 await upload(h,answer(request));assert.equal(h.el('sendCancel').disabled,false);
 rejectRead(Error('synthetic read error'));await oldRead;
 assert.equal(h.el('sendCancel').disabled,false,'stale failure must not clear the newer valid answer');
});

test('editing the address invalidates an already verified response',async()=>{
 const h=harness();const request=await prepare(h,refs[0]);await upload(h,answer(request));
 assert.equal(h.el('sendCancel').disabled,false);
 h.el('cancelAddress').value='AGT'+'b'.repeat(40);
 await h.el('cancelAddress').listeners.input?.({target:h.el('cancelAddress')});
 assert.equal(h.el('sendCancel').disabled,true);
 await h.el('sendCancel').click();assert.equal(h.submitted.length,0);
});
