#!/usr/bin/env node
/* демо: полный цикл AGT */
'use strict';
import { Blockchain, createWallet, signTransaction, verifyTransaction, blockReward } from './core.mjs';

const bc = new Blockchain('./data');
console.log('[' + bc.blockCount() + ' блоков на старте, genesisHash', bc.info().genesisHash.slice(0, 16) + ']');

// 1) кошельки агентов
const a1 = createWallet('agent-1');
const a2 = createWallet('agent-2');
console.log('agent-1:', a1.address);
console.log('agent-2:', a2.address);

// 2) майним блок1 — награда agent-1
let t0 = Date.now();
let b1 = bc.mineOnce(a1.address);
console.log(`block ${b1.height}: ${b1.hash.slice(0, 16)}… nonce=${b1.header.nonce} ${Date.now() - t0}ms reward=${blockReward(b1.height)} AGT`);

// 3) agent-1 платит agent-2 10 AGT
const tx = { from: a1.address, fromPub: a1.pub, to: a2.address, amount: 10, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: 'доставка услуги' };
tx.signature = signTransaction(tx, a1.privKey);
console.log('tx подписана, verify:', verifyTransaction(tx));
const r = bc.addTransaction(tx);
console.log('tx в mempool:', r.ok);

// 4) майним блок2 с транзакцией
t0 = Date.now();
const b2 = bc.mineOnce(a1.address);
console.log(`block ${b2.height}: ${b2.hash.slice(0, 16)}… ${Date.now() - t0}ms txs=${b2.txs.length}`);

// 5) балансы
const bal = bc.balances();
console.log('agent-1:', bal[a1.address] ?? 0, 'AGT (50 награда + 50 за блок2 - 10 отправлено)');
console.log('agent-2:', bal[a2.address] ?? 0, 'AGT (получено 10)');

// 6) валидация цепи
const v = bc.validate();
console.log('валидация:', JSON.stringify(v));

// 7) попытка подделки: потратить чужие
const fake = { from: a2.address, fromPub: a1.pub, to: a1.address, amount: 999, nonce: 1, ts: Math.floor(Date.now() / 1000), memo: 'fraud' };
fake.signature = signTransaction(fake, a1.privKey); // подпись чужим ключом
const fr = bc.addTransaction(fake);
console.log('подделка отклонена:', !fr.ok, '(' + fr.reason + ')');
