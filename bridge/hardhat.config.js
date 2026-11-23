require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: {},
    // Sepolia — тестнет, стендовый ключ. Без переменных в .env сеть просто
    // определена, но деплой с неё упадёт на старте — ключей в репозитории нет.
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || '',
      accounts: process.env.SEPOLIA_DEPLOYER_KEY ? [process.env.SEPOLIA_DEPLOYER_KEY] : [],
      chainId: 11155111,
    },
  },
};
