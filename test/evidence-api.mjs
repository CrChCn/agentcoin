import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Jail } from '../jail.mjs';
import { stageIsolatedSource, isolatedEnvironment } from '../tools/isolated-test-node.mjs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
test('unverified security events cannot create quarantine dossiers', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'agt-jail-proof-'));
 try { const file=path.join(root,'jail.json'); const jail=new Jail(file);
 const result=jail.syncFromSecurity({attacks:[{id:'x',address:'AGT'+'a'.repeat(40),rule:'ban',kind:'spoof_signature'}]});
 assert.equal(result.taken,0);assert.equal(result.unverified,1);assert.equal(jail.state().jail.total,0);
 } finally { await rm(root,{recursive:true,force:true}); }
});
test('real isolated HTTP API reports unknown provenance without changing legacy passports', async () => {
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
 const p=await (await fetch(base+'/passport/count')).json();assert.equal(p.count,1);assert.equal(p.audit.independentExternalAgents,null);assert.ok(!JSON.stringify(p).includes('private-'));
 const a=await (await fetch(base+'/security/attacks')).json();assert.equal(a.evidenceSummary.confirmedAttackCount,0);
 const j=await (await fetch(base+'/jail/state')).json();assert.equal(j.semantics,'local_case_records_not_verified_attackers');
 assert.equal(await readFile(file,'utf8'),original);
 } finally {if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}await rm(root,{recursive:true,force:true});}
});
