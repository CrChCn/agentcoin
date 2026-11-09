// Конфиг для прогона фазы B против ФОРКА Sepolia: настоящий байткод
// официальных контрактов Uniswap V2 и chainId 11155111, майнинг
// мгновенный, газ тестовый (аккаунты Hardhat). Запуск: npm run cycle:sepolia-fork
require("@nomicfoundation/hardhat-ethers");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.24",
  paths: { sources: "./contracts", cache: "./cache", artifacts: "./artifacts" },
  networks: {
    hardhat: {
      chainId: 11155111,
      forking: {
        url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      },
    },
  },
};
