import { HardhatUserConfig } from "hardhat/config";
import { Wallet } from "ethers";

import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-verify";
import "@openzeppelin/hardhat-upgrades";
import "solidity-coverage";
import "hardhat-gas-reporter";

// Loads custom tasks
import "./tasks/tools";
import "./tasks/deploy";
import "./tasks/upgrade";
import "./tasks/ops";

// Loads env variables from .env file
import * as dotenv from "dotenv";
dotenv.config();

export default {
  networks: {
    hardhat: {
      initialBaseFeePerGas: 0,
      accounts: {
        mnemonic: Wallet.createRandom().mnemonic.phrase,
      },
    },
    ganache: {
      url: "http://127.0.0.1:8545",
      chainId: 1337,
    },
    sepolia: {
      // url: `https://sepolia.infura.io/v3/${process.env.INFURA_SECRET}`,
      url: `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_SECRET}`,
      accounts: {
        mnemonic: process.env.PROD_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
      },
    },
    mainnet: {
      url: `https://mainnet.infura.io/v3/${process.env.INFURA_SECRET}`,
      // url: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_SECRET}`,
      // url: `https://virtual.mainnet.rpc.tenderly.co/f468fb75-ada0-4833-9f64-f71d51b71190`,
      accounts: {
        mnemonic: process.env.PROD_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
      },
      gasMultiplier: 1.005,
    },
  },
  solidity: {
    compilers: [
      {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 50,
          },
        },
      },
    ],
  },
  gasReporter: {
    currency: "USD",
    enabled: !!process.env.REPORT_GAS,
    excludeContracts: ["mocks/"],
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
  mocha: {
    bail: false,
    timeout: 100000000,
  },
} as HardhatUserConfig;
