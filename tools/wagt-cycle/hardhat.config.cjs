// Локальная тестовая EVM-сеть для цикла wAGT (in-process Hardhat Network).
// Никаких внешних RPC и кранов: детерминированный повтор одной командой.
// Сеть `sepolia` — только для scripts/cycle-sepolia.mjs; ключ никогда не
// хранится в коде, только в env SEPOLIA_PRIVATE_KEY (см. .env.example).
require("@nomicfoundation/hardhat-ethers");

const SEPOLIA_KEY = process.env.SEPOLIA_PRIVATE_KEY || "";


/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.24",
  paths: { sources: "./contracts", cache: "./cache", artifacts: "./artifacts" },
  networks: {
    hardhat: { chainId: 31337 }, // форк Sepolia — отдельный hardhat.fork.cjs
    sepolia: {
      chainId: 11155111,
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: SEPOLIA_KEY ? [SEPOLIA_KEY] : [],
    },
  },
};
