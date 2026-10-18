import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {Cabinet} from '../cabinet.mjs';
import {createWallet} from '../core.mjs';
import {issuerFingerprint} from '../agent-identity.mjs';
function fixture() {
 const a=createWallet('a'),b=createWallet('b'),issuer=createWallet('issuer');let now=100000,active=true;
 const cabinet=new Cabinet({walletsLoader:()=>{throw Error('private wallet loader must not run');},
  passportFile:'/nonexistent-test-passports',balancesFn:()=>({[a.address]:7}),now:()=>now,
  identityRegistry:{findByAddress:address=>active&&address===a.address?{address,pub:a.pub,handle:'a',agentId:'stable'}:null,
   meta:()=>({network:'AGENTCOIN',audience:'test-node',issuerFingerprint:issuerFingerprint(issuer.pub)})}});
 const signature=(c,key=a.privKey)=>crypto.sign(null,Buffer.from(c.challenge.message),key).toString('hex');
 return {a,b,cabinet,signature,advance:n=>now+=n,revoke:()=>active=false};
}
test('public-only identity authenticates; failed foreign proof cannot consume owner challenge',()=>{
 const {a,b,cabinet:c,signature}=fixture(),q=c.challenge(a.address);
 assert.equal(q.ok,true);assert.equal(c.loginChallenge(a.address,q.nonce,signature(q,b.privKey),q.challengeId).ok,false);
 const r=c.loginChallenge(a.address,q.nonce,signature(q),q.challengeId);assert.equal(r.ok,true);
 assert.equal(c.loginChallenge(a.address,q.nonce,signature(q),q.challengeId).error,'challenge_not_issued');
 assert.equal(c.session(a.address,r.token).address,a.address);assert.equal(c.session(b.address,r.token),null);
 assert.equal(c.state(a.address,'challenge-signature').wallet.baoAGT,7);
});
test('expired proofs and absolute sessions fail; revocation ends existing session',()=>{
 let f=fixture(),q=f.cabinet.challenge(f.a.address);f.advance(300001);
 assert.equal(f.cabinet.loginChallenge(f.a.address,q.nonce,f.signature(q),q.challengeId).error,'challenge_expired');
 f=fixture();q=f.cabinet.challenge(f.a.address);const r=f.cabinet.loginChallenge(f.a.address,q.nonce,f.signature(q),q.challengeId);
 f.advance(8*3600000);assert.equal(f.cabinet.session(f.a.address,r.token),null);
 f=fixture();q=f.cabinet.challenge(f.a.address);const s=f.cabinet.loginChallenge(f.a.address,q.nonce,f.signature(q),q.challengeId);
 f.revoke();assert.equal(f.cabinet.session(f.a.address,s.token),null);
});
test('new anonymous requests cannot exhaust a known address-specific quota; seq number is not login',()=>{
 const {a,cabinet}=fixture();for(let i=0;i<5;i++)assert.equal(cabinet.challenge(a.address).ok,true);
 assert.equal(cabinet.loginSeqStr(a.address,'000000000000000000001').error,'signature_required');
 assert.equal(cabinet.challenge({address:a.address}).error,'invalid_address');
});
