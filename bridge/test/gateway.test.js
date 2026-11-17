// gateway.test.js — приёмка EVM-стороны (§10 ТЗ, EVM-часть). npx hardhat test.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const WEI_PER_MAGNET = 10n ** 9n;

async function signers() {
  const [admin, pauser, user, ...rest] = await ethers.getSigners();
  return { admin, pauser, user, rest };
}

async function deploy(threshold = 3, n = 5) {
  const { admin, pauser, user, rest } = await signers();
  const keys = rest.slice(0, n);
  const W = await ethers.getContractFactory("WrappedAGT");
  const w = await W.deploy(admin.address);
  const G = await ethers.getContractFactory("BridgeGateway");
  const g = await G.deploy(
    admin.address, pauser.address, await w.getAddress(),
    77, // agentcoinChainId-якорь стенда
    keys.map((k) => k.address), threshold,
    ethers.parseEther("100"), // maxMintPerOp
    ethers.parseEther("1000"), // window cap
    ethers.parseEther("10000") // net cap
  );
  await w.connect(admin).grantRole(await w.GATEWAY_ROLE(), await g.getAddress());
  return { admin, pauser, user, keys, w, g };
}

function attestation(gAddr, keys, eventId, to, amount) {
  return (async () => {
    const d = await gAddr.attestationInner(eventId, to, amount);
    const sigs = [];
    for (const k of keys) sigs.push(await k.signMessage(ethers.getBytes(d)));
    return sigs;
  })();
}

describe("WrappedAGT", function () {
  it("mint только через gateway, owner-mint отсутствует", async function () {
    const { admin, user, w } = await deploy();
    await expect(w.connect(user).mint(user.address, 1n)).to.be.reverted;
    await expect(w.connect(admin).mint(user.address, 1n)).to.be.reverted;
  });

  it("burn некратной суммы revert; кратная — событие с получателем", async function () {
    const { user, keys, w, g } = await deploy();
    const eid = ethers.keccak256(ethers.toUtf8Bytes("e1"));
    const sigs = await attestation(g, keys.slice(0, 3), eid, user.address, WEI_PER_MAGNET * 2n);
    await g.mintAttested(eid, user.address, WEI_PER_MAGNET * 2n, sigs);
    await expect(
      w.connect(user).burnWithRecipient(WEI_PER_MAGNET + 1n, "AGT" + "1".repeat(40))
    ).to.be.revertedWithCustomError(w, "BurnAmountNotMagentExact");
    await expect(w.connect(user).burnWithRecipient(WEI_PER_MAGNET, "short")).to.be.revertedWithCustomError(
      w, "BadRecipient"
    );
    await expect(w.connect(user).burnWithRecipient(WEI_PER_MAGNET, "AGT" + "1".repeat(40)))
      .to.emit(w, "BurnRegistered")
      .withArgs(user.address, WEI_PER_MAGNET, "AGT" + "1".repeat(40));
    expect(await w.balanceOf(user.address)).to.equal(WEI_PER_MAGNET);
  });
});

describe("BridgeGateway mint", function () {
  it("порог 3/5: 2 подписей мало, 3 хватает; повторная доставка безопасна", async function () {
    const { user, keys, g } = await deploy(3, 5);
    const eid = ethers.keccak256(ethers.toUtf8Bytes("lock-1"));
    const two = await attestation(g, keys.slice(0, 2), eid, user.address, WEI_PER_MAGNET);
    await expect(g.mintAttested(eid, user.address, WEI_PER_MAGNET, two)).to.be.revertedWithCustomError(
      g, "ThresholdNotMet"
    );
    const three = await attestation(g, keys.slice(0, 3), eid, user.address, WEI_PER_MAGNET);
    await expect(g.mintAttested(eid, user.address, WEI_PER_MAGNET, three)).to.emit(g, "MintAttested");
    await expect(g.mintAttested(eid, user.address, WEI_PER_MAGNET, three)).to.be.revertedWithCustomError(
      g, "AlreadyExecuted"
    );
  });

  it("дубликат подписанта, чужой подписант, подмена суммы/получателя/контракта", async function () {
    const { user, keys, g } = await deploy(3, 5);
    const eid = ethers.keccak256(ethers.toUtf8Bytes("lock-2"));
    const d = await g.attestationInner(eid, user.address, WEI_PER_MAGNET);
    const s0 = await keys[0].signMessage(ethers.getBytes(d));
    const outsider = (await signers()).user;
    const sX = await outsider.signMessage(ethers.getBytes(d));
    await expect(g.mintAttested(eid, user.address, WEI_PER_MAGNET, [s0, s0, s0])).to.be.reverted; // дубликат
    await expect(
      g.mintAttested(eid, user.address, WEI_PER_MAGNET, [s0, await keys[1].signMessage(ethers.getBytes(d)), sX])
    ).to.be.revertedWithCustomError(g, "NotSigner");
    // подмена суммы: подписи под другой суммой
    const d2 = await g.attestationInner(eid, user.address, WEI_PER_MAGNET * 2n);
    const sigs2 = [];
    for (const k of keys.slice(0, 3)) sigs2.push(await k.signMessage(ethers.getBytes(d2)));
    await expect(g.mintAttested(eid, user.address, WEI_PER_MAGNET, sigs2)).to.be.reverted;
    // подмена получателя
    const other = (await signers()).pauser;
    const d3 = await g.attestationInner(eid, other.address, WEI_PER_MAGNET);
    const sigs3 = [];
    for (const k of keys.slice(0, 3)) sigs3.push(await k.signMessage(ethers.getBytes(d3)));
    await expect(g.mintAttested(eid, user.address, WEI_PER_MAGNET, sigs3)).to.be.reverted;
  });

  it("лимиты и пауза: per-op, окно, потолок, стоп выпуска", async function () {
    const { pauser, user, keys, g } = await deploy(3, 5);
    const big = ethers.parseEther("101");
    const eid = ethers.keccak256(ethers.toUtf8Bytes("big"));
    const sigs = await attestation(g, keys.slice(0, 3), eid, user.address, big);
    await expect(g.mintAttested(eid, user.address, big, sigs)).to.be.revertedWithCustomError(g, "OverPerOpLimit");
    await g.connect(pauser).setMintPaused(true);
    const eid2 = ethers.keccak256(ethers.toUtf8Bytes("p"));
    const sigs2 = await attestation(g, keys.slice(0, 3), eid2, user.address, WEI_PER_MAGNET);
    await expect(g.mintAttested(eid2, user.address, WEI_PER_MAGNET, sigs2)).to.be.revertedWithCustomError(
      g, "MintPaused"
    );
    await g.connect(pauser).setMintPaused(false);
    await expect(g.mintAttested(eid2, user.address, WEI_PER_MAGNET, sigs2)).to.emit(g, "MintAttested");
  });

  it("подмена шлюза: подписи под другой контракт недействительны", async function () {
    const { user, keys } = await deploy(3, 5);
    const { admin, pauser } = await signers();
    const W2 = await ethers.getContractFactory("WrappedAGT");
    const w2 = await W2.deploy(admin.address);
    const G2 = await ethers.getContractFactory("BridgeGateway");
    const g2 = await G2.deploy(admin.address, pauser.address, await w2.getAddress(), 77, keys.map((k) => k.address), 3, 10n ** 30n, 10n ** 31n, 10n ** 32n);
    const { g } = await deploy(3, 5);
    const eid = ethers.keccak256(ethers.toUtf8Bytes("x-gw"));
    const inner = await g2.attestationInner(eid, user.address, WEI_PER_MAGNET);
    const sigs = [];
    for (const k of keys.slice(0, 3)) sigs.push(await k.signMessage(ethers.getBytes(inner)));
    await expect(g.mintAttested(eid, user.address, WEI_PER_MAGNET, sigs)).to.be.reverted;
    const inner1 = await g.attestationInner(eid, user.address, WEI_PER_MAGNET);
    expect(inner1).to.not.equal(inner);
  });

  it("после ротации старые подписанты недействительны", async function () {
    const { admin, user, keys, g } = await deploy(2, 3);
    const eid = ethers.keccak256(ethers.toUtf8Bytes("old-signer"));
    const inner = await g.attestationInner(eid, user.address, WEI_PER_MAGNET);
    const oldSigs = [];
    for (const k of keys.slice(0, 2)) oldSigs.push(await k.signMessage(ethers.getBytes(inner)));
    await g.connect(admin).proposeSigners([user.address, keys[0].address], 2);
    await ethers.provider.send("evm_increaseTime", [2 * 24 * 3600 + 1]);
    await ethers.provider.send("evm_mine");
    await g.connect(admin).applySigners();
    await expect(g.mintAttested(eid, user.address, WEI_PER_MAGNET, oldSigs)).to.be.revertedWithCustomError(g, "NotSigner");
  });

  it("ротация подписантов — двухшагово с задержкой; раннее применение revert", async function () {
    const { admin, keys, g } = await deploy(3, 5);
    const fresh = keys.slice(0, 3).map((k) => k.address);
    await g.connect(admin).proposeSigners(fresh, 2);
    await expect(g.connect(admin).applySigners()).to.be.revertedWithCustomError(g, "DelayNotPassed");
    await ethers.provider.send("evm_increaseTime", [2 * 24 * 3600 + 1]);
    await ethers.provider.send("evm_mine");
    await expect(g.connect(admin).applySigners()).to.emit(g, "SignersApplied");
    expect(await g.threshold()).to.equal(2);
  });
});
