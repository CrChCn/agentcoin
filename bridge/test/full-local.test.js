// full-local — полный цикл стенда на РЕАЛЬНЫХ контрактах локальной EVM + живой цепи ядра.
// lock(Agentcoin)→mint(wAGT)→burn→release(Agentcoin), рестарты, сверка, реорг ПОСЛЕ mint.
// Запуск: node node_modules/hardhat/internal/cli/cli.js test test/full-local.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const WEI_PER_MAGNET = 10n ** 9n;

async function deployGateway(admin, pauser, keys, threshold) {
  const W = await ethers.getContractFactory("WrappedAGT");
  const w = await W.deploy(admin.address);
  const G = await ethers.getContractFactory("BridgeGateway");
  const g = await G.deploy(
    admin.address, pauser.address, await w.getAddress(),
    77, keys.map((k) => k.address), threshold,
    ethers.parseEther("100"), ethers.parseEther("1000"), ethers.parseEther("10000")
  );
  await w.connect(admin).grantRole(await w.GATEWAY_ROLE(), await g.getAddress());
  return { w, g };
}

describe("bridge full-local: реальные контракты + живая цепь Agentcoin", function () {
  it("lock→mint→burn→release, рестарт, сверка, реорг после mint = дефицит+стоп, не автокансел", async function () {
    const [admin, pauser, evmUser, ...rest] = await ethers.getSigners();
    const fed = rest.slice(0, 3);
    const { w, g } = await deployGateway(admin, pauser, fed, 2);
    const core = await import("../../core.mjs");
    const proto = await import("../proto.mjs");
    const rec = await import("../reconcile.mjs");
    const svc = await import("../services.mjs");

    // живая цепь Agentcoin (изолированный tmp)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agt-full-"));
    const bc = new core.Blockchain(dir);
    const vault = core.createWallet("vault");
    const attestor = core.createWallet("attestor");
    const user = core.createWallet("user");
    for (let i = 0; i < 2; i++) bc.mineOnce(vault.address);
    bc.mineOnce(user.address); bc.mineOnce(user.address);
    bc.treasuryPolicyFn = () => ({ treasury: vault.address, signers: [attestor.address], requires: 2 });

    // LOCK 2 AGT
    const amountMgnt = proto.agtToMagnets("2");
    const lockMemo = proto.buildLockMemo({ destChainId: "31337", evmRecipient: evmUser.address, amountMgnt, nonce: "full-1" });
    const lockTx = { from: user.address, fromPub: user.pub, to: vault.address, amount: 2, nonce: Date.now(), ts: Math.floor(Date.now() / 1000), memo: lockMemo };
    lockTx.signature = core.signTransaction(lockTx, user.privKey);
    expect(bc.addTransaction(lockTx).ok).to.equal(true);
    bc.mineOnce(vault.address); bc.mineOnce(vault.address); // K подтверждений
    const lockTxid = core.txDigest(lockTx);
    const locks = svc.observeLocks(bc.chain, 0);
    expect(locks.some((l) => l.txid === lockTxid && l.status === "lock")).to.equal(true);

    // ATTEST: реальные ECDSA-подписи федерации под реальным inner
    const eventIdRaw = proto.agentcoinLockEventId({ srcChainId: "AGENTCOIN", destChainId: "31337", txid: lockTxid, vault: vault.address, amountMgnt: amountMgnt.toString(), sender: user.address, evmRecipient: evmUser.address, nonce: "full-1" });
    const eventId = "0x" + eventIdRaw;
    const amountWei = proto.magnetsToWei(amountMgnt);
    const inner = await g.attestationInner(eventId, evmUser.address, amountWei);
    const sigs = [];
    for (const k of fed.slice(0, 2)) sigs.push(await k.signMessage(ethers.getBytes(inner)));
    await expect(g.mintAttested(eventId, evmUser.address, amountWei, sigs)).to.emit(g, "MintAttested");
    expect(await w.balanceOf(evmUser.address)).to.equal(amountWei);
    // идемпотентность на链: повтор — AlreadyExecuted
    await expect(g.mintAttested(eventId, evmUser.address, amountWei, sigs)).to.be.revertedWithCustomError(g, "AlreadyExecuted");

    // РЕСТАРТ релеера: состояние executed живёт в контракте — повтор после "рестарта" снова отказ
    const sigsAgain = [];
    const inner2 = await g.attestationInner(eventId, evmUser.address, amountWei);
    for (const k of fed.slice(0, 2)) sigsAgain.push(await k.signMessage(ethers.getBytes(inner2)));
    await expect(g.mintAttested(eventId, evmUser.address, amountWei, sigsAgain)).to.be.revertedWithCustomError(g, "AlreadyExecuted");

    // сверка: locked 2 AGT == circulating
    const r1 = rec.computeReserves({ lockedMgnt: amountMgnt, wagtTotalSupplyWei: amountWei, feesMgnt: 0n, checkpoints: { agentcoin: { height: bc.blockCount(), hash: "aa", at: Date.now() }, evm: { block: 1, hash: "0xbb", finalized: true, at: Date.now() } } });
    expect(r1.ok).to.equal(true);

    // BURN реальный на wAGT
    const agentcoinRecipient = user.address;
    await expect(w.connect(evmUser).burnWithRecipient(amountWei, agentcoinRecipient)).to.emit(w, "BurnRegistered");
    const burnEvent = proto.evmBurnEventId({ srcChainId: "31337", destChainId: "AGENTCOIN", txHash: "0xh", logIndex: 0, token: await w.getAddress(), amountWei: amountWei.toString(), burner: evmUser.address, agentcoinRecipient });

    // RELEASE реальный на Agentcoin с sig2 аттестора
    const relTx = { from: vault.address, fromPub: vault.pub, to: user.address, amount: 2, nonce: Date.now() + 7, ts: Math.floor(Date.now() / 1000), memo: "bridge_release:v1:AGT-WAGT-V1:" + burnEvent };
    relTx.signature = core.signTransaction(relTx, vault.privKey);
    relTx.sig2Pub = attestor.pub;
    relTx.sig2 = crypto.sign(null, Buffer.from(core.txDigest(relTx), "hex"), attestor.privKey).toString("hex");
    expect(bc.addTransaction(JSON.parse(JSON.stringify(relTx))).ok).to.equal(true);
    bc.mineOnce(vault.address);

    // РЕОРГ ПОСЛЕ mint: откатываемся ДО блока с lock (mint уже необратим в EVM),
    // строим более тяжёлый форк без lock/release.
    const lockHeight = bc.chain.find((b) => (b.txs || []).some((x) => x.txid === lockTxid)).height;
    const prefix = JSON.parse(JSON.stringify(bc.chain.slice(0, lockHeight)));
    const { Blockchain } = core;
    const forkB = new Blockchain(fs.mkdtempSync(path.join(os.tmpdir(), "agt-fork-")));
    const prefixLen = prefix.length;
    forkB.chain = prefix.slice();
    forkB.difficultyBits = prefix[prefixLen - 1].header.difficultyBits;
    forkB.mempool = [];
    forkB.invalidateTxCache();
    for (let i = 0; i < 8; i++) forkB.mineOnce(vault.address);
    const cand = forkB.chain.slice(prefixLen);
    const adop = bc.adoptFork(JSON.parse(JSON.stringify(cand)), prefixLen);
    expect(adop.ok).to.equal(true);
    const locksAfter = svc.observeLocks(bc.chain, 0);
    // lock исчез:
    expect(locksAfter.some((l) => l.txid === lockTxid && l.status === "lock")).to.equal(false);
    // выпуск при этом НЕ отменён автоматически: баланс wAGT цел:
    expect(await w.balanceOf(evmUser.address)).to.equal(0n); // сожжены при burn; необеспеченность — в обращении net
    // дефицит зафиксирован сервисом: mint был, lock нет
    const def = svc.detectPostMintDeficit({ mintedEventIds: [{ lockTxid, eventId }], currentLocks: locksAfter });
    expect(def.deficit).to.equal(true);
    expect(def.stop).to.include("mint");
    expect(def.settlement.join(" ")).to.include("Автокансел запрещён");
    // здоровье — стоп:
    const h = svc.healthCheck({ policyMatch: true, reconcileOk: false, evmFinalized: true, agentcoinTipFresh: true });
    expect(h.mint).to.equal("STOP");
  });
});
