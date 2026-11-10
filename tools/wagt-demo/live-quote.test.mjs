// Декодер живой котировки на записанном ответе RPC: node tools/wagt-demo/live-quote.test.mjs (exit 0).
import assert from 'node:assert/strict';
import { decodeAmountsOut, SNAPSHOT } from './live.js';
import { formatWei } from './math.js';

// Записанный ответ getAmountsOut(2 wAGT) в блоке 12103142 (offset, len, in, out).
const RECORDED = '0x' +
  '0000000000000000000000000000000000000000000000000000000000000020' +
  '0000000000000000000000000000000000000000000000000000000000000002' +
  '0000000000000000000000000000000000000000000000001bc16d674ec80000' +
  '000000000000000000000000000000000000000000000000efa76ca70651a8b4';

const [amountIn, amountOut] = decodeAmountsOut(RECORDED);
assert.equal(amountIn, 2000000000000000000n, 'вход — ровно 2 wAGT');
assert.equal(amountOut, SNAPSHOT.outWei, 'выход совпадает со снимком');
assert.equal(amountOut, 17268890760796809396n, 'точное значение wei');
assert.equal(formatWei(amountOut), '17.268890760796809396', 'человекочитаемая сумма');
assert.equal(SNAPSHOT.block, 12103142, 'номер блока снимка');
assert.throws(() => decodeAmountsOut('0x1234'), Error, 'короткий ответ');
assert.throws(() => decodeAmountsOut('not-hex'), Error, 'мусор');

console.log('live-quote.test.mjs: OK — блок 12103142, 2 wAGT -> 17.268890760796809396 tAGT.');
