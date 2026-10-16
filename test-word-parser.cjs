// test-word-parser.cjs — юнит-проверка парсера стеганографического челленджа Moltbook
'use strict';
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('moltbook-verified-publish.cjs', 'utf8');
const head = src.slice(0, src.indexOf('(async () =>'));
const sandbox = { console, require, module: { exports: {} }, exports: {} };
vm.createContext(sandbox);
vm.runInContext(head, sandbox, { filename: 'inline-parser.js' });
const solveMath = sandbox.solveMath;

const realChallenge = 'Lo]b-StErS Cl^aW ApPlIiEs ThI rTy SeV eN NeWt-OnS ]*[/ FoU r AnT-eNnA TaP s~, um';
const r1 = solveMath(realChallenge);
console.log('наш реальный челлендж:', JSON.stringify(r1), '(ожидали 37 × 4 = 148.00)');

const plain = 'Solve: 12 + 7 = ?';
console.log('простой числовой:', JSON.stringify(solveMath(plain)), '(ожидали 19.00)');

if (r1 && r1.answer === '148.00' && solveMath(plain).answer === '19.00') {
  console.log('PARSER OK');
  process.exit(0);
}
console.error('PARSER FAIL');
process.exit(1);
