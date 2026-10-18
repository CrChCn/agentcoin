#!/usr/bin/env node
// Run after reviewing/approving a website change. --check is read-only CI.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2),check=args.includes('--check');
const releaseIndex=args.indexOf('--release');
const file=path.join(root,'site','release.json');
let previous;try{previous=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
let release=releaseIndex>=0?args[releaseIndex+1]:previous?.release||'agent-cabinet-v1-20261018';
if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(release||''))throw Error('invalid_release_name');
const panel=Buffer.concat([fs.readFileSync(path.join(root,'tools','imperial-panel.js')),Buffer.from('\n'),fs.readFileSync(path.join(root,'tools','install-ui.js'))]);
const panelPath=path.join(root,'site','panel.js');
if(check){if(!fs.existsSync(panelPath)||!fs.readFileSync(panelPath).equals(panel))throw Error('site_panel_outdated_run_build_site_release');}
else fs.writeFileSync(panelPath,panel);
const pages=['index.html','imperial.html','terminal.html','dashboard.html','chat.html','jail.html','mbc20.html','cabinet.html','jobs.html','panel.js'];
const files={};for(const page of pages)files[page]=crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'site',page))).digest('hex');
if (!check && releaseIndex < 0) release = 'site-v2-' + crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0,16);
const manifest={version:1,release,apiVersion:2,files};
if(check){if(JSON.stringify(previous)!==JSON.stringify(manifest))throw Error('site_manifest_outdated_run_build_site_release');}
else fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
console.log(`Site release ${release}: ${pages.length} files ${check?'verified':'prepared'}.`);
