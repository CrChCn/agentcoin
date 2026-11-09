// Локальная тестовая EVM-сеть для цикла wAGT (in-process Hardhat Network).
// Никаких внешних RPC и кранов: детерминированный повтор одной командой.
require("@nomicfoundation/hardhat-ethers");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.24",
  paths: { sources: "./contracts", cache: "./cache", artifacts: "./artifacts" },
  networks: { hardhat: { chainId: 31337 } },
};
