#!/usr/bin/env node
// R-03 TESTNET/REGTEST: изолированная тестовая сеть AGT.
// Развязки от main: свой networkId (AGT_CHAIN_ID=AGT_TESTNET → свой генезис-хеш),
// свой DATA_DIR, свои порты, свой bootstrap; тестовые peers/tx/blocks main-сетью
// не принимаются (network/genesis checks), main-пиры тестнетом отфильтруются.
// Никаких обращений к operator wallets/env/data: всё внутри testnet/data.
// Запуск: node tools/testnet.mjs [порт=19933] [--reset]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const wantReset = args.includes('--reset');
const port = Number(args.find(a => /^\d+$/.test(a)) || 19933);

const dataDir = path.join(ROOT, 'testnet', 'data');
const bootFile = path.join(ROOT, 'testnet', 'bootstrap.json');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.dirname(bootFile), { recursive: true });
if (wantReset && fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(bootFile)) fs.writeFileSync(bootFile, JSON.stringify({ bootstrap: [] }, null, 2) + '\n');

const env = {
  ...process.env,
  AGT_CHAIN_ID: 'AGT_TESTNET',           // отдельная сеть → отдельный genesisHash
  AGT_DATA_DIR: dataDir,
  AGT_BOOTSTRAP_FILE: bootFile,
  AGT_BIND: '127.0.0.1',
  AGT_ADMIN_MODE: 'local',
  AGT_SPORE: '0',
  AGT_SITE_SYNC: '0',
  AGT_PEER_DISCOVERY: '0',
};
for (const k of ['AGT_CORE_P0_HEIGHT', 'AGT_TX_DIGEST_V2_HEIGHT', 'AGT_MGNT_HEIGHT', 'AGT_TRUSTED_ISSUERS_FILE', 'AGT_PASSPORT_ISSUER_FINGERPRINT']) delete env[k];

console.log(`[testnet] network=AGT_TESTNET port=${port} data=${dataDir}`);
console.log('[testnet] изоляция: main/тестовые пира фильтруются network/genesis-проверкой; операторские кошельки/данные не используются');
const child = spawn(process.execPath, [path.join(ROOT, 'node.mjs'), String(port)], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exitCode = code);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { child.kill(sig); } catch { process.exit(0); } });
