import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { generateKeyPairSync, webcrypto } from 'node:crypto';
import { addressFromPub, signTransaction, txDigest } from '../core.mjs';
const html=await fs.readFile(new URL('../site/cabinet.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter(m=>!m[1].includes('src=')).map(m=>m[2]);
const pair=generateKeyPairSync('ed25519');
const pub=pair.publicKey.export({type:'spki',format:'pem'}),from=addressFromPub(pub),to='AGT'+'b'.repeat(40),genesisHash='1'.repeat(64);
function fixture(){
 const intent={schema:'agentcoin.wallet.intent.v1',network:'AGENTCOIN',genesisHash,from,to,amount:'1.25',memo:'synthetic test',createdAt:123,nonce:42};
 const tx={from,to,amount:1.25,nonce:42,ts:123,memo:intent.memo,fromPub:pub};tx.signature=signTransaction(tx,pair.privateKey);tx.txid=txDigest(tx);
 return{schema:'agentcoin.wallet.signed.v1',network:'AGENTCOIN',genesisHash,intent,tx};
}
function pure(){const ctx=vm.createContext({window:{},crypto:webcrypto,TextEncoder,atob,structuredClone});vm.runInContext(scripts[0],ctx);return{ctx,async verify(manifest,expected=manifest.intent){ctx.manifestJSON=JSON.stringify(manifest);ctx.intentJSON=JSON.stringify(expected);return vm.runInContext('window.AgentcoinWalletFormat.signed(JSON.parse(manifestJSON),JSON.parse(intentJSON))',ctx);}};}
test('browser accepts locally signed AGT envelope with real signature and exact decimal',async()=>{const p=pure(),m=fixture();assert.equal((await p.verify(m)).txid,m.tx.txid);for(const [input,expected]of[['1.2500','1.25'],['0.000000001','0.000000001']]){p.ctx.input=input;assert.equal(vm.runInContext('window.AgentcoinWalletFormat.decimal(input)',p.ctx),expected);}for(const input of ['0','1e-9','-1','1,2','01','0.0000000001','9007199.254740992']){p.ctx.input=input;assert.throws(()=>vm.runInContext('window.AgentcoinWalletFormat.decimal(input)',p.ctx));}});
test('wrong network, extra secret fields, changed intent and cryptographic mutations reject',async()=>{
 const p=pure(),base=fixture();
 for(const mutate of [m=>m.network='OTHER',m=>m.genesisHash='2'.repeat(64),m=>m.privKey='secret',m=>m.tx.password='secret',m=>m.intent.to=from,m=>m.tx.to=from,m=>m.tx.amount=2,m=>m.tx.nonce++,m=>m.tx.memo='<img onerror=evil()>',m=>m.tx.signature='00'.repeat(64),m=>m.tx.fromPub=pub+'\n',m=>m.tx.txid='f'.repeat(64)]){const bad=structuredClone(base);mutate(bad);await assert.rejects(p.verify(bad,base.intent));}
 const other=generateKeyPairSync('ed25519'),bad=structuredClone(base);bad.tx.signature=signTransaction(bad.tx,other.privateKey);await assert.rejects(p.verify(bad),/Подпись/);
});
function ui(){
 const elements=new Map(),requests=[],downloads=[],blobs=new Map();
 function element(id=''){if(elements.has(id))return elements.get(id);const classes=new Set();const e={value:'',checked:false,disabled:false,files:[],textContent:'',children:[],className:'',classList:{add:v=>classes.add(v),remove:v=>classes.delete(v),contains:v=>classes.has(v)},append(...values){this.children.push(...values);},replaceChildren(...values){this.children=values;},click(){if(this.download)downloads.push({name:this.download,blob:blobs.get(this.href)});}};if(id)elements.set(id,e);return e;}
 class UIURL extends URL{static createObjectURL(blob){const id='blob:'+blobs.size;blobs.set(id,blob);return id;}static revokeObjectURL(){}}
 let blocks=[];
 const ctx=vm.createContext({window:{},crypto:webcrypto,TextEncoder,TextDecoder,AbortSignal,atob,structuredClone,Uint32Array,Blob,URL:UIURL,Date,setTimeout(){},navigator:{clipboard:{async writeText(){}}},document:{getElementById:element,createElement:()=>element(),createTextNode:text=>({textContent:text})},async fetch(route,options={}){const body=options.body?JSON.parse(options.body):undefined;requests.push({route,body});let data;
 if(route==='/identity/meta')data={network:'AGENTCOIN',role:'replica',passportIssuerFingerprint:'public',audience:'test'};
 else if(route==='/site/release')data={release:'test'};
 else if(route==='/info')data={chainId:'AGENTCOIN',genesisHash};
 else if(route==='/cabinet/challenge')data={challenge:{address:body.address,challengeId:'test-challenge',message:'test'}};
 else if(route==='/cabinet/login')data={token:'memory-only-session'};
 else if(route==='/cabinet/state')data={address:from,passport:{handle:'synthetic-agent'},wallet:{baoAGT:100}};
 else if(route==='/blocks?n=100')data={blocks};
 else if(route==='/tx')data={ok:true};
 else if(route==='/cabinet/logout')data={ok:true};
 else throw Error('unexpected_route:'+route);
 return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 }});for(const source of scripts)vm.runInContext(source,ctx);
 return{ctx,element,requests,downloads,setBlocks:value=>{blocks=value;},async login(){element('adr').value=from;await element('challenge').onclick();element('signature').value='0'.repeat(128);await element('login').onclick();}};
}
test('wallet UI keeps login; handoff requires exact local signature plus separate confirmation and never broadcasts',async()=>{
 const u=ui(),e=u.element;await u.login();assert.equal(e('receiveAddress').textContent,from);
 e('sendTo').value=to;e('sendAmount').value='1.25';e('sendMemo').value='UI test';await e('prepareTransfer').onclick();await e('downloadIntent').onclick();
 const request=JSON.parse(await u.downloads.at(-1).blob.text());assert.equal(request.from,from);assert.equal(request.amount,'1.25');assert.equal(Number.isSafeInteger(request.nonce),true);
 const tx={from,to,amount:1.25,nonce:request.nonce,ts:request.createdAt,memo:request.memo,fromPub:pub};tx.signature=signTransaction(tx,pair.privateKey);tx.txid=txDigest(tx);
 const signed={schema:'agentcoin.wallet.signed.v1',network:'AGENTCOIN',genesisHash,intent:request,tx};const file=JSON.stringify(signed);e('signedTransferFile').files=[{size:Buffer.byteLength(file),async text(){return file;}}];
 await e('importSigned').onclick();assert.match(e('message').textContent,/проверены/);assert.equal(e('broadcastTransfer').disabled,true);assert.equal(u.requests.filter(r=>r.route==='/tx').length,0);
 await e('broadcastTransfer').onclick();assert.equal(u.requests.filter(r=>r.route==='/tx').length,0);
 e('confirmTransfer').checked=true;e('confirmTransfer').onchange();await e('broadcastTransfer').onclick();assert.equal(u.requests.filter(r=>r.route==='/tx').length,0);const handoff=JSON.parse(await u.downloads.at(-1).blob.text());assert.deepEqual(handoff,signed);assert.equal(e('broadcastTransfer').disabled,true);
 assert.match(e('walletHistory').children[0].children[1].textContent,/Ожидает локального Skill/);
 u.setBlocks([{height:99,txs:[tx]}]);await e('refreshWallet').onclick();assert.match(e('walletHistory').children[0].children[1].textContent,/Подтверждён этой нодой/);
 await e('logout').onclick();assert.equal(e('receiveAddress').textContent,'');assert.equal(e('walletHistory').children.length,0);
});
test('editing invalidates signed intent; public history uses textContent; no secret persistence or admin signing',async()=>{
 assert.doesNotMatch(html,/localStorage|sessionStorage|indexedDB|innerHTML|\/tx\/sign|\/wallet\//);
 const u=ui(),e=u.element;await u.login();e('sendTo').value=to;e('sendAmount').value='1';await e('prepareTransfer').onclick();assert.equal(e('downloadIntent').disabled,false);e('sendAmount').value='2';e('sendAmount').oninput();assert.equal(e('downloadIntent').disabled,true);assert.equal(e('broadcastTransfer').disabled,true);
 const payload='<img src=x onerror=alert(1)>';u.setBlocks([{height:5,txs:[{from:to,to:from,amount:1,txid:'f'.repeat(64),memo:payload}]}]);await e('refreshWallet').onclick();assert.equal(e('walletHistory').children[0].children.at(-1).textContent,'Назначение: '+payload);
});
