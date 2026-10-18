#!/usr/bin/env node
// User-owned installation only. No OS elevation, payments or operator keys.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {configureAgentNode, startAgentNode, statusAgentNode, CHECKOUT_ROOT, checkoutGenesisHash} from './agent-node-setup.mjs';
import {issuerFingerprint} from '../agent-identity.mjs';
import {createProfile, readPublicProfile, inspectProfile, createEncryptedBackup} from '../agt-skill/agent-profile.mjs';
import {connectCabinet, enrollAgent, loginAgent, cabinetState} from '../agt-skill/cabinet-client.mjs';

export const DEFAULT_INSTALL_ROOT = path.join(os.homedir(), '.agentcoin', 'agent');
export const NETWORK_FILE = fileURLToPath(new URL('../install/network.json', import.meta.url));
const fail = code => {throw new Error(code);};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
async function privateDir(dir) {
  for (let p = path.resolve(dir);; p = path.dirname(p)) {
    try {const s = await fs.lstat(p); if (!s.isDirectory() || s.isSymbolicLink()) fail('install_path_must_not_use_symlinks');}
    catch (e) {if (e.code !== 'ENOENT') throw e;}
    if (path.dirname(p) === p) break;
  }
  await fs.mkdir(dir, {recursive:true, mode:0o700});
  const s = await fs.lstat(dir);
  if (process.platform !== 'win32' && (s.mode & 0o077)) fail('install_directory_must_be_private');
}
async function writeNew(file, value) {
  await privateDir(path.dirname(file));
  const h = await fs.open(file, 'wx', 0o600);
  try {await h.writeFile(typeof value === 'string' ? value : JSON.stringify(value, null, 2)+'\n'); await h.sync();}
  finally {await h.close();}
}
async function readPrivate(file) {
  const s = await fs.lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.size > 131072 || (process.platform !== 'win32' && (s.mode & 0o077))) fail('invalid_install_state');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export function validateInstallNetwork(n) {
  if (!object(n) || n.version !== 1 || n.network !== 'AGENTCOIN' || !/^[a-f0-9]{64}$/.test(n.genesisHash) ||
      n.genesisHash !== checkoutGenesisHash() || issuerFingerprint(n.issuerPub) !== n.issuerFingerprint) fail('invalid_pinned_install_network');
  return n;
}
async function exists(file) {try {await fs.lstat(file);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
async function writeSame(file,value) {
  const text=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';
  if(await exists(file)){
    const s=await fs.lstat(file);
    if(!s.isFile()||s.isSymbolicLink()||s.size>131072||(process.platform!=='win32'&&(s.mode&0o077)))fail('invalid_install_state');
    if(await fs.readFile(file,'utf8')!==text)fail('existing_install_configuration_not_overwritten');return;
  }
  await writeNew(file,text);
}
export function installationOrigin(value) {
  let u; try {u = new URL(value);} catch {fail('peer_url_required');}
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash ||
      (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(u.hostname)))) fail('https_peer_origin_required');
  return u.origin;
}
async function publicJSON(url) {
  const r = await fetch(url, {redirect:'error', credentials:'omit', signal:AbortSignal.timeout(10000)});
  if (!r.ok) fail('install_peer_unavailable');
  let size = 0; const chunks = [];
  for await (const c of r.body || []) {size += c.length; if (size > 131072) fail('install_peer_response_too_large'); chunks.push(c);}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!object(value)) fail('install_peer_response_invalid'); return value;
}
function under(parent, file) {const r=path.relative(parent,file); return r && !r.startsWith('..'+path.sep) && r !== '..' && !path.isAbsolute(r);}
function verifyReceipt(r, root) {
  if (!object(r) || r.version !== 1 || r.rootDir !== root || r.remoteConfig !== path.join(root,'remote-node.json') ||
      r.profilePath !== path.join(root,'identity','profile.json') || r.setupPath !== path.join(root,'node','setup.json') ||
      r.skillPath !== path.join(root,'skill','SKILL.md') || !['client','node'].includes(r.mode)) fail('invalid_install_receipt');
  return r;
}
export async function installAgent({rootDir=DEFAULT_INSTALL_ROOT, peerUrl, clientOnly=false, start=true,
  profile, networkConfig, sourceRef=process.env.AGENTCOIN_SOURCE_REF || null, siteSync=true, startNodeFn=startAgentNode}={}) {
  if (Number(process.versions.node.split('.')[0]) < 24) fail('node_24_required');
  const root = path.resolve(rootDir);
  if (under(CHECKOUT_ROOT,root) || root === path.resolve(CHECKOUT_ROOT)) fail('install_state_must_be_outside_source');
  const origin = installationOrigin(peerUrl);
  const network = validateInstallNetwork(networkConfig || JSON.parse(await fs.readFile(NETWORK_FILE,'utf8')));
  if(profile!==undefined&&(!object(profile)||typeof profile.password!=='string'||profile.password.length<12))fail('private_profile_password_min_12_characters');
  await privateDir(root);
  const receiptFile=path.join(root,'installation.json');
  let previousReceipt;
  try {
    const old = verifyReceipt(await readPrivate(receiptFile),root);
    if (old.peerUrl !== origin || old.mode !== (clientOnly?'client':'node')) fail('existing_installation_not_overwritten');
    if(profile===undefined||old.enrolled)return {...old,ok:true,alreadyInstalled:true,processStatus:'not_rechecked',next:'Use your existing start launcher; existing keys and configuration were preserved.'};
    previousReceipt=old;
  } catch(e) {if(e.code !== 'ENOENT') throw e;}
  await writeSame(path.join(root,'installation-intent.json'),{version:1,peerUrl:origin,mode:clientOnly?'client':'node',
    checkoutDir:path.resolve(CHECKOUT_ROOT),genesisHash:network.genesisHash,issuerFingerprint:network.issuerFingerprint});
  const remoteConfig=path.join(root,'remote-node.json');
  // connect verifies genesis and both issuer roles before a wallet is created.
  const connection = await connectCabinet({configPath:remoteConfig,nodeUrl:origin,
    expectedNetwork:network.network,expectedGenesisHash:network.genesisHash,expectedIssuerFingerprint:network.issuerFingerprint});
  const meta=await publicJSON(origin+'/identity/meta');
  if (meta.issuerFingerprint !== connection.nodeIssuerFingerprint) fail('install_peer_changed');
  const profilePath=path.join(root,'identity','profile.json'), setupPath=path.join(root,'node','setup.json');
  const skillPath=path.join(root,'skill','SKILL.md');
  await writeSame(skillPath,`---\nname: agentcoin-connect\ndescription: Connect this agent to Agentcoin using its own encrypted profile, passport and optional local node. Use for Agentcoin setup, login, state and node recovery.\n---\n\nRead the installed instructions at ${JSON.stringify(path.join(CHECKOUT_ROOT,'agt-skill','SKILL.md'))}.\nUse ${JSON.stringify(remoteConfig)} for the selected issuer/remote node.\nUse ${JSON.stringify(profilePath)} for the local encrypted profile; create it through a private stdin secret channel if missing. Never send passwords, seed, private keys or admin tokens to HTTP or chat.\nThe optional local node is configured at ${JSON.stringify(setupPath)}; use its cabinet-node.json for local login/state.\nA passport grants no operator/admin rights or permission to spend funds.\n`);
  let publicIdentity=null, enrolled=false, profileStatus='needs_private_password';
  if (profile !== undefined) {
    if(await exists(profilePath))await inspectProfile({profilePath,password:profile.password});
    else await createProfile({profilePath,password:profile.password,network:network.network,label:profile.label || 'agent'});
    publicIdentity=await readPublicProfile(profilePath);
    if(!await exists(path.join(root,'backup','profile.enc.json')))await createEncryptedBackup({profilePath,password:profile.password,backupPath:path.join(root,'backup','profile.enc.json')});
    profileStatus='encrypted_profile_and_local_backup_created';
    if (connection.enrollmentEnabled) {
      if(!await exists(profilePath+'.passport.json'))await enrollAgent({configPath:remoteConfig,profilePath,password:profile.password,handle:profile.handle || 'agent-'+publicIdentity.address.slice(-12)});
      await loginAgent({configPath:remoteConfig,profilePath,password:profile.password}); enrolled=true;
    }
  }
  let node=null;
  if (!clientOnly) {
    const trust=path.join(root,'operator-public-keys.json'); await writeSame(trust,[network.issuerPub]);
    if(!await exists(setupPath))await configureAgentNode({configPath:setupPath,role:'replica',trustFile:trust,operatorIssuerFingerprint:network.issuerFingerprint,
      peerUrl:origin,expectedGenesisHash:network.genesisHash,siteSync});
    if (start) {
      node=(await startNodeFn({configPath:setupPath,detached:true})).report;
      if (enrolled) await loginAgent({configPath:node.preferredCabinetConfig,profilePath,password:profile.password});
    }
  }
  const receipt={version:1,rootDir:root,mode:clientOnly?'client':'node',peerUrl:origin,sourceRef:/^[a-f0-9]{40}$/.test(sourceRef||'')?sourceRef:null,
    checkoutDir:path.resolve(CHECKOUT_ROOT),remoteConfig,profilePath,setupPath,skillPath,profileStatus,enrolled,
    address:publicIdentity?.address || null,nodeUrl:node?.nodeUrl || null,cabinetUrl:node?.nodeUrl?node.nodeUrl+'/cabinet':origin+'/cabinet',
    network:network.network,genesisHash:network.genesisHash,issuerFingerprint:network.issuerFingerprint};
  if(previousReceipt){const temp=receiptFile+'.'+process.pid+'.tmp';await writeNew(temp,receipt);await fs.rename(temp,receiptFile);}
  else await writeNew(receiptFile,receipt);
  return {...receipt,ok:true,running:node?.running || false,syncStatus:node?'synchronizing_from_configured_peer':'not_started',
    next:enrolled?'Profile and passport ready. Keep the encrypted backup on another device.':profile?'Profile ready; obtain your passport from the pinned issuer.':'Node/Skill ready; provide a private password to create your agent profile.'};
}
async function secretInput() {
  let size=0; const chunks=[];
  for await(const chunk of process.stdin){size+=chunk.length;if(size>16384)fail('private_profile_input_too_large');chunks.push(chunk);}
  const v=JSON.parse(Buffer.concat(chunks).toString('utf8')); if(!object(v))fail('profile_json_object_required');return v;
}
async function passwordPrompt(label) {
  if(!process.stdin.isTTY || !process.stdin.setRawMode) fail('private_stdin_or_terminal_required');
  process.stderr.write(label);process.stdin.setRawMode(true);process.stdin.resume();
  return new Promise((resolve,reject)=>{
    let value='';const finish=(error)=>{process.stdin.off('data',receive);process.stdin.setRawMode(false);process.stdin.pause();process.stderr.write('\n');error?reject(error):resolve(value);};
    const receive=(data)=>{for(const c of data.toString('utf8')){if(c==='\u0003')return finish(new Error('cancelled'));if(c==='\r'||c==='\n')return finish();if(c==='\u007f'||c==='\b'){value=value.slice(0,-1);continue;}if(c>=' '&&value.length<1024)value+=c;}};
    process.stdin.on('data',receive);
  });
}
export async function runEasyInstall(args=process.argv.slice(2)) {
  const command=args.shift() || 'install';
  let rootDir=process.env.AGENTCOIN_INSTALL_ROOT || DEFAULT_INSTALL_ROOT,peerUrl=process.env.AGENTCOIN_PEER_URL;
  let clientOnly=false,start=true,profileStdin=false,nonInteractive=false;
  while(args.length){const a=args.shift();if(a==='--peer-url')peerUrl=args.shift();else if(a==='--root')rootDir=args.shift();else if(a==='--client-only')clientOnly=true;else if(a==='--no-start')start=false;else if(a==='--profile-stdin')profileStdin=true;else if(a==='--non-interactive')nonInteractive=true;else fail('unknown_install_option');}
  const root=path.resolve(rootDir);
  if(command!=='install'){
    const receipt=verifyReceipt(await readPrivate(path.join(root,'installation.json')),root);
    if(command==='status')return receipt.mode==='node'?await statusAgentNode({configPath:receipt.setupPath}):{ok:true,mode:'client',cabinetUrl:receipt.cabinetUrl};
    if(command==='start'&&receipt.mode==='node')return(await startAgentNode({configPath:receipt.setupPath,detached:true})).report;
    if(command==='state')return cabinetState({configPath:receipt.nodeUrl?path.join(root,'node','cabinet-node.json'):receipt.remoteConfig,profilePath:receipt.profilePath});
    fail('usage_install_start_status_state');
  }
  let profile;
  if(profileStdin)profile=await secretInput();
  else if(!nonInteractive&&process.stdin.isTTY){
    process.stderr.write('Agentcoin: create your own encrypted agent profile. No seed or password is sent to the node.\n');
    const first=await passwordPrompt('New vault password (12+ characters; blank = install node/Skill only): ');
    if(first){const second=await passwordPrompt('Repeat password: ');if(first!==second)fail('passwords_do_not_match');profile={password:first};}
  }
  return installAgent({rootDir,peerUrl,clientOnly,start,profile});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  runEasyInstall().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{
    const message=/^[a-z][a-z0-9_]{1,120}$/.test(error.message||'')?error.message:'agent_installation_failed';
    process.stderr.write(message+'\n');process.exitCode=1;
  });
}
