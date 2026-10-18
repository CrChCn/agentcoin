import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {configureAgentNode,startAgentNode,checkoutGenesisHash} from '../tools/agent-node-setup.mjs';
import {installAgent,installationOrigin,validateInstallNetwork} from '../tools/easy-install.mjs';
import {cabinetState} from '../agt-skill/cabinet-client.mjs';

async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;const ended=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),2500);try{await ended;}finally{clearTimeout(timer);}}
async function fixture(t){
  const dir=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'agt-easy-install-'));const children=[];
  t.after(async()=>{for(const c of children.reverse())await stop(c);await fs.rm(dir,{recursive:true,force:true});});
  const configPath=path.join(dir,'issuer','setup.json');
  await configureAgentNode({configPath,role:'issuer',siteSync:false});
  const node=await startAgentNode({configPath});children.push(node.child);
  const meta=await fetch(node.report.nodeUrl+'/identity/meta').then(r=>r.json());
  const network={version:1,network:'AGENTCOIN',genesisHash:checkoutGenesisHash(),issuerPub:meta.issuerPub,issuerFingerprint:meta.issuerFingerprint};
  return {dir,peerUrl:node.report.nodeUrl,network,startNodeFn:async options=>{const started=await startAgentNode({...options,detached:false});children.push(started.child);return started;}};
}

test('one entry point creates an isolated replica, encrypted profile, passport and usable local SDK', {timeout:45000},async t=>{
  const f=await fixture(t),rootDir=path.join(f.dir,'agent');
  const password='synthetic-easy-install-password';
  const result=await installAgent({rootDir,peerUrl:f.peerUrl,networkConfig:f.network,siteSync:false,startNodeFn:f.startNodeFn,profile:{password,handle:'installer-test-agent'}});
  assert.equal(result.ok,true);assert.equal(result.running,true);assert.equal(result.enrolled,true);
  assert.match(result.address,/^AGT/);assert.match(result.nodeUrl,/^http:\/\/127\.0\.0\.1:\d+$/);assert.notEqual(result.nodeUrl,f.peerUrl);
  const meta=await fetch(result.nodeUrl+'/identity/meta').then(r=>r.json());
  assert.equal(meta.role,'replica');assert.equal(meta.enrollmentEnabled,false);assert.equal(meta.passportIssuerFingerprint,f.network.issuerFingerprint);
  const state=await cabinetState({configPath:path.join(rootDir,'node','cabinet-node.json'),profilePath:result.profilePath});
  assert.equal(state.ok,true);
  const operator=await fetch(result.nodeUrl+'/operator/cabinet');assert.equal(operator.status,403);
  const manifest=await fetch(result.nodeUrl+'/app.webmanifest');assert.equal(manifest.status,200);assert.equal((await manifest.json()).start_url,'/imperial');
  assert.equal((await fetch(result.nodeUrl+'/app-icon-192.png',{method:'HEAD'})).status,200);
  for(const miner of ['undefined','dummy-miner','AGT11a01a612a422dff68f758eefbd9ab3a991439a']){
    const invalid=await fetch(result.nodeUrl+'/blocktemplate',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({miner})});
    assert.equal(invalid.status,400);assert.equal((await invalid.json()).error,'canonical_miner_address_required');
  }
  const config=JSON.parse(await fs.readFile(result.setupPath,'utf8'));
  assert.equal(config.bind,'127.0.0.1');assert.deepEqual(config.peers,[f.peerUrl]);
  const identityBefore=await fs.readFile(result.profilePath,'utf8');
  assert.equal(identityBefore.includes(password),false);assert.equal(JSON.stringify(result).includes(password),false);
  assert.equal((await fs.readFile(path.join(rootDir,'backup','profile.enc.json'),'utf8')).includes(password),false);
  const second=await installAgent({rootDir,peerUrl:f.peerUrl,networkConfig:f.network});
  assert.equal(second.alreadyInstalled,true);assert.equal(await fs.readFile(result.profilePath,'utf8'),identityBefore);
  await assert.rejects(installAgent({rootDir,peerUrl:'https://different-node.example',networkConfig:f.network}),/not_overwritten/);
});

test('client-only install can later create a profile without recreating software or replacing a key', {timeout:30000},async t=>{
  const f=await fixture(t),rootDir=path.join(f.dir,'client');
  const first=await installAgent({rootDir,peerUrl:f.peerUrl,networkConfig:f.network,clientOnly:true});
  assert.equal(first.mode,'client');assert.equal(first.enrolled,false);assert.equal(first.nodeUrl,null);
  const second=await installAgent({rootDir,peerUrl:f.peerUrl,networkConfig:f.network,clientOnly:true,profile:{password:'synthetic-client-profile-password',handle:'client-install-agent'}});
  assert.equal(second.enrolled,true);assert.match(second.address,/^AGT/);
  await assert.rejects(fs.stat(path.join(rootDir,'node','setup.json')),{code:'ENOENT'});
});

test('untrusted origin/pins and short passwords fail before creating agent secrets',async t=>{
  const f=await fixture(t),rootDir=path.join(f.dir,'rejected');
  for(const value of ['http://remote.example','https://user:secret@node.example','https://node.example/path','https://node.example?x=1','file:///tmp/source'])assert.throws(()=>installationOrigin(value));
  assert.throws(()=>validateInstallNetwork({...f.network,issuerFingerprint:'sha256:'+'0'.repeat(64)}));
  await assert.rejects(installAgent({rootDir,peerUrl:f.peerUrl,networkConfig:f.network,profile:{password:'short'}}),/min_12/);
  await assert.rejects(fs.stat(path.join(rootDir,'identity','profile.json')),{code:'ENOENT'});
  await assert.rejects(installAgent({rootDir,peerUrl:f.peerUrl,networkConfig:{...f.network,genesisHash:'f'.repeat(64)}}),/pinned/);
});

test('published runtime hashes and shell bootstrap agree across six desktop targets',async()=>{
  const runtime=JSON.parse(await fs.readFile(new URL('../install/runtime.json',import.meta.url),'utf8'));
  const sums=await fs.readFile(new URL('../install/runtime-shasums.txt',import.meta.url),'utf8');
  assert.equal(Object.keys(runtime.files).length,6);assert.match(runtime.version,/^v24\.\d+\.\d+$/);
  for(const entry of Object.values(runtime.files)){assert.match(entry.sha256,/^[a-f0-9]{64}$/);assert.ok(sums.includes(entry.sha256+'  '+entry.file+'\n'));}
});
