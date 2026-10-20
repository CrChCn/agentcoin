import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWallet } from '../core.mjs';
import { stageIsolatedSource, isolatedEnvironment } from '../tools/isolated-test-node.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
test('assistant HTTP requires signed cabinet session and never invents a configured model', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'agt-proof-api-'));let child;
 try {
 const source=await stageIsolatedSource(path.resolve(import.meta.dirname,'..'),path.join(root,'source'));
 const {mkdir}=await import('node:fs/promises');await mkdir(path.join(source,'data-agents'));
 const file=path.join(source,'data-agents','passports.json');const original=JSON.stringify([{address:'AGT'+'a'.repeat(40),seqStr:'private-sequence',handle:'private-handle'}]);await writeFile(file,original);
 const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));
 await writeFile(path.join(root,'bootstrap.json'),'{"bootstrap":[]}');
 child=spawn(process.execPath,[path.join(source,'node.mjs'),String(port)],{cwd:root,env:{...isolatedEnvironment(),AGT_DATA_DIR:path.join(root,'data'),AGT_BIND:'127.0.0.1',AGT_BOOTSTRAP_FILE:path.join(root,'bootstrap.json'),AGT_ADMIN_MODE:'local',AGT_SPORE:'0',AGT_SITE_SYNC:'0',AGT_PEER_DISCOVERY:'0'},stdio:'ignore'});
 const base=`http://127.0.0.1:${port}`;let ready=false;
 for(let i=0;i<100;i++){try {const r=await fetch(base+'/health');if(r.ok){ready=true;break;}}catch{} await new Promise(r=>setTimeout(r,100));}
 assert.ok(ready,'isolated node starts');
 const post=(route,input)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
 assert.equal((await post('/assistant/message',{address:'AGT'+'a'.repeat(40),token:'fake',prompt:'help'})).status,401);
 const w=createWallet();
 const c=await (await post('/identity/challenge',{address:w.address,pub:w.pub,handle:'helper-test'})).json();
 assert.ok(c.ok);
 const registration=await post('/identity/register',{challengeId:c.challengeId,signature:crypto.sign(null,Buffer.from(c.message),w.privKey).toString('hex')});assert.equal(registration.status,201);
 const challengeReply=await (await post('/cabinet/challenge',{address:w.address})).json();const loginChallenge=challengeReply.challenge;
 const login=await (await post('/cabinet/login',{mode:'challenge',address:w.address,nonce:loginChallenge.message,challengeId:loginChallenge.challengeId,signature:crypto.sign(null,Buffer.from(loginChallenge.message),w.privKey).toString('hex')})).json();assert.ok(login.token);
 const answer=await post('/assistant/message',{address:w.address,token:login.token,prompt:'Объясни паспорт'});assert.equal(answer.status,503);assert.equal((await answer.json()).error,'assistant_unavailable');
 assert.equal((await post('/assistant/message',{address:w.address,token:login.token,prompt:'Ещё вопрос'})).status,429);
 assert.equal((await post('/assistant/message',{address:w.address,token:login.token,prompt:'x',privateKey:'must-not-pass'})).status,400);
 assert.equal(await readFile(file,'utf8'),original);
 } finally {if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}await rm(root,{recursive:true,force:true});}
});
