import { HardhatUserConfig } from "hardhat/config";
import { Wallet } from "ethers";

import "@nomiclabs/hardhat-ethers";
import "@nomiclabs/hardhat-waffle";
import "@openzeppelin/hardhat-upgrades";
import "@nomiclabs/hardhat-etherscan";
import "solidity-coverage";
import "hardhat-gas-reporter";

// Loads custom tasks
// import "./scripts/tools/verify";
// import "./scripts/accounts";
// import "./scripts/deploy";
// import "./scripts/ops";

// Loads env variables from .env file
import * as dotenv from "dotenv";
dotenv.config();

export default {
  networks: {
    hardhat: {
      initialBaseFeePerGas: 0,
      accounts: {
        mnemonic: process.env.DEV_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
      },
    },
    kovan: {
      url: `https://kovan.infura.io/v3/${process.env.INFURA_SECRET}`,
      accounts: {
        mnemonic: process.env.DEV_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
      },
    },
    mainnet: {
      url: `https://mainnet.infura.io/v3/${process.env.INFURA_SECRET}`,
      accounts: {
        mnemonic: process.env.PROD_MNEMONIC || Wallet.createRandom().mnemonic.phrase,
      },
    },
  },
  solidity: {
    compilers: [
      {
        version: "0.8.3",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      {
        version: "0.8.4",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
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
    bail: true,
  },
} as HardhatUserConfig;
