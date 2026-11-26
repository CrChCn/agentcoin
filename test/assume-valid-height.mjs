// AGT_ASSUME_VALID_HEIGHT=N — opt-in доверие к легаси-истории: тела блоков ниже N не
// перепроверяются (у ранних блоков merkle/txid посчитаны старыми правилами и
// невосстанавливаемы), но заголовок проверяется всегда (prevHash, hash, PoW), а с высоты
// N валидация снова полная. Тест изолированный: одноразовый data-dir, без сети и портов.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '../core.mjs';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agt-assume-valid-'));
  const bc = new core.Blockchain(dir);
  const miner = core.createWallet('assume-valid');
  for (let i = 0; i < 2; i++) bc.mineOnce(miner.address);
  return { dir, bc, miner, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Честный блок на вершину цепи; overrides меняют поля заголовка (и, при необходимости,
// хеш пересчитывается майнингом — чтобы проверки до merkle проходили).
function craft(bc, miner, overrides = {}) {
  const height = bc.blockCount();
  const cb = { from: 'COINBASE', to: miner.address, amount: core.blockReward(height), nonce: height, ts: Math.floor(Date.now() / 1000), memo: 'assume-valid ' + height };
  cb.txid = core.txDigest(cb);
  const txs = [cb];
  const header = {
    version: 1,
    prevHash: bc.tip().hash,
    merkleRoot: core.merkleRoot(txs),
    timestamp: Math.floor(Date.now() / 1000),
    difficultyBits: bc.nextDifficulty(),
    nonce: 0,
    chainId: core.CHAIN_ID,
    ...overrides,
  };
  for (;;) {
    const hash = core.computeBlockHash(header);
    if (core.hashMeetsDifficulty(hash, header.difficultyBits)) return { height, hash, header, txs, miner: miner.address };
    header.nonce++;
  }
}

const badMerkle = (bc, miner) => craft(bc, miner, { merkleRoot: 'f'.repeat(64) });

test('без порога блок с неверным merkle отклоняется — поведение по умолчанию не изменилось', () => {
  delete process.env.AGT_ASSUME_VALID_HEIGHT;
  const f = fixture();
  try {
    assert.equal(core.assumeValidHeight(), Infinity);
    assert.equal(core.validateBlockAgainstChain(badMerkle(f.bc, f.miner), f.bc.chain), 'merkle_mismatch');
  } finally {
    f.cleanup();
  }
});

test('порог включается только выше высоты блока: block.height === N всё ещё валидируется', () => {
  const f = fixture();
  try {
    const block = badMerkle(f.bc, f.miner);
    assert.equal(core.validateBlockAgainstChain(block, f.bc.chain, { assumeValidHeight: block.height }), 'merkle_mismatch');
    assert.equal(core.validateBlockAgainstChain(block, f.bc.chain, { assumeValidHeight: block.height + 1 }), null);
  } finally {
    f.cleanup();
  }
});

test('порог из env принимается, env невалиден — fail-closed', () => {
  const f = fixture();
  try {
    const block = badMerkle(f.bc, f.miner);
    process.env.AGT_ASSUME_VALID_HEIGHT = String(block.height + 1);
    assert.equal(core.validateBlockAgainstChain(block, f.bc.chain), null);
    process.env.AGT_ASSUME_VALID_HEIGHT = String(block.height);
    assert.equal(core.validateBlockAgainstChain(block, f.bc.chain), 'merkle_mismatch');
    for (const bad of ['abc', '0', '-1', '1.5', ' 2x']) {
      process.env.AGT_ASSUME_VALID_HEIGHT = bad;
      assert.throws(() => core.assumeValidHeight(), /AGT_ASSUME_VALID_HEIGHT_invalid/);
    }
  } finally {
    delete process.env.AGT_ASSUME_VALID_HEIGHT;
    f.cleanup();
  }
});

test('ниже порога заголовок всё равно проверяется: prevHash, hash, PoW', () => {
  const f = fixture();
  try {
    const assume = { assumeValidHeight: f.bc.blockCount() + 1 };
    const wrongPrev = craft(f.bc, f.miner, { prevHash: '0'.repeat(64) });
    assert.equal(core.validateBlockAgainstChain(wrongPrev, f.bc.chain, assume), 'prevHash_mismatch');

    const block = badMerkle(f.bc, f.miner);
    const forged = { ...block, hash: 'f'.repeat(64) };
    assert.equal(core.validateBlockAgainstChain(forged, f.bc.chain, assume), 'hash_mismatch');

    // ищем nonce, при котором hash НЕ проходит сложность: PoW не должен проскакивать
    const weak = badMerkle(f.bc, f.miner);
    let nonce = weak.header.nonce;
    let hash;
    do { nonce++; hash = core.computeBlockHash({ ...weak.header, nonce }); } while (core.hashMeetsDifficulty(hash, weak.header.difficultyBits));
    assert.equal(core.validateBlockAgainstChain({ ...weak, header: { ...weak.header, nonce }, hash }, f.bc.chain, assume), 'pow_fail');
  } finally {
    f.cleanup();
  }
});
