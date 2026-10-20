#!/usr/bin/env node
// Run after reviewing/approving a website change. --check is read-only CI.
// Hashes are taken from COMMITTED bytes (git blob), not the working tree:
// nodes verify fetched raw.githubusercontent bytes against these hashes, and
// Windows autocrlf checkouts (CRLF) must not poison the manifest —
// otherwise nodes reject the release with release_hash_mismatch.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),check=args.includes('--check');
const releaseIndex=args.indexOf('--release');
const file=path.join(root,'site','release.json');
let previous;try{previous=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
let release=releaseIndex>=0?args[releaseIndex+1]:previous?.release||'agent-cabinet-v1-20261018';
if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(release||''))throw Error('invalid_release_name');
const panel=Buffer.from(['imperial-panel.js','install-ui.js','profile-memory.js','cabinet-helper.js'].map(file=>fs.readFileSync(path.join(root,'tools',file),'utf8').trimEnd()).join('\n')+'\n');
const panelPath=path.join(root,'site','panel.js');
if(check){if(!fs.existsSync(panelPath)||!fs.readFileSync(panelPath).equals(panel))throw Error('site_panel_outdated_run_build_site_release');}
else fs.writeFileSync(panelPath,panel);
const pages=['index.html','imperial.html','terminal.html','dashboard.html','chat.html','jail.html','mbc20.html','cabinet.html','jobs.html','user-wallet-page.html','user-wallet-format-lib.js','panel.js'];
const files={};
for(const page of pages){
  let bytes;
  try{bytes=execFileSync('git',['show','HEAD:site/'+page],{cwd:root,maxBuffer:20*1024*1024});}
  catch{throw new Error(`site_page_not_in_git:${page} (commit site/${page} before building release.json)`);}
  files[page]=crypto.createHash('sha256').update(bytes).digest('hex');
  // честная сверка: рабочий файл (не переходы строк — autocrlf) должен отличаться от фиксации только в одном случае — когда действительно правится сайт и коммит ещё не сделан.
  const disk=fs.readFileSync(path.join(root,'site',page));
  const norm=(b)=>Buffer.from(b.toString('binary').replace(/\r\n/g,'\n'),'binary');
  if(!norm(disk).equals(norm(bytes)))console.error(`[warn] site/${page} differs from HEAD: commit first — manifest keeps COMMITTED bytes`);
}
if (!check && releaseIndex < 0) release = 'site-v2-' + crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0,16);
const manifest={version:1,release,apiVersion:2,files};
if(check){if(JSON.stringify(previous)!==JSON.stringify(manifest))throw Error('site_manifest_outdated_run_build_site_release');}
else fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
console.log(`Site release ${release}: ${pages.length} files ${check?'verified':'prepared'}.`);
