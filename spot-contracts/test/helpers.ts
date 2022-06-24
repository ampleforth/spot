import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Signer, Contract, BigNumber, ContractFactory, Transaction } from "ethers";
import * as fs from "fs";
import * as path from "path";

const TOKEN_DECIMALS = 18;
const PRICE_DECIMALS = 8;
const YIELD_DECIMALS = 18;

export const toFixedPtAmt = (a: string): BigNumber => ethers.utils.parseUnits(a, TOKEN_DECIMALS);
export const toPriceFixedPtAmt = (a: string): BigNumber => ethers.utils.parseUnits(a, PRICE_DECIMALS);
export const toYieldFixedPtAmt = (a: string): BigNumber => ethers.utils.parseUnits(a, YIELD_DECIMALS);

const ORACLE_BASE_PRICE = toPriceFixedPtAmt("1");

const EXTERNAL_ARTIFACTS_PATH = path.join(__dirname, "/../external-artifacts");
async function getContractFactoryFromExternalArtifacts(name: string): Promise<ContractFactory> {
  const artifact = JSON.parse(fs.readFileSync(`${EXTERNAL_ARTIFACTS_PATH}/${name}.json`).toString());
  return ethers.getContractFactoryFromArtifact(artifact);
}

export const TimeHelpers = {
  secondsFromNow: async (secondsFromNow: number): Promise<number> => {
    const res = await hre.network.provider.send("eth_getBlockByNumber", ["latest", false]);
    const timestamp = parseInt(res.timestamp, 16);
    return timestamp + secondsFromNow;
  },

  increaseTime: async (seconds: number): Promise<void> => {
    await hre.network.provider.send("evm_increaseTime", [seconds]);
    await hre.network.provider.send("evm_mine");
  },

  setNextBlockTimestamp: async (timestamp: number): Promise<void> => {
    await ethers.provider.send("evm_setNextBlockTimestamp", [timestamp]);
    await hre.network.provider.send("evm_mine");
  },
};

// Rebasing collateral token (button tokens)
interface ButtonTokenContracts {
  underlyingToken: Contract;
  rebaseOracle: Contract;
  collateralToken: Contract;
}
export const setupCollateralToken = async (name: string, symbol: string): Promise<ButtonTokenContracts> => {
  const ERC20 = await ethers.getContractFactory("MockERC20");
  const underlyingToken = await ERC20.deploy();
  await underlyingToken.init(name, symbol);

  const MockOracle = await ethers.getContractFactory("MockOracle");
  const rebaseOracle = await MockOracle.deploy();
  await rebaseOracle.deployed();
  await rebaseOracle.setData(ORACLE_BASE_PRICE, true);

  const ButtonToken = await getContractFactoryFromExternalArtifacts("ButtonToken");
  const collateralToken = await ButtonToken.deploy();
  await collateralToken.initialize(underlyingToken.address, `Button ${name}`, `btn-${symbol}`, rebaseOracle.address);

  return {
    underlyingToken,
    rebaseOracle,
    collateralToken,
  };
};

export const mintCollteralToken = async (collateralToken: Contract, amount: BigNumber, from: Signer) => {
  const fromAddress = await from.getAddress();
  const ERC20 = await ethers.getContractFactory("MockERC20");
  const underlyingToken = await ERC20.attach(await collateralToken.underlying());
  const cAmount = await collateralToken.wrapperToUnderlying(amount);
  await underlyingToken.connect(from).mint(fromAddress, cAmount);
  await underlyingToken.connect(from).approve(collateralToken.address, cAmount);
  await collateralToken.connect(from).mint(amount);
};

export const rebase = async (token: Contract, oracle: Contract, perc: number) => {
  const p = await token.lastPrice();
  const newPrice = p.mul(ORACLE_BASE_PRICE.add(ORACLE_BASE_PRICE.toNumber() * perc)).div(ORACLE_BASE_PRICE);
  await oracle.setData(newPrice, true);
};

// Button tranche
export const setupBondFactory = async (): Promise<Contract> => {
  const BondController = await getContractFactoryFromExternalArtifacts("BondController");
  const bondController = await BondController.deploy();
  await bondController.deployed();

  const Tranche = await getContractFactoryFromExternalArtifacts("Tranche");
  const tranche = await Tranche.deploy();
  await tranche.deployed();

  const TrancheFactory = await getContractFactoryFromExternalArtifacts("TrancheFactory");
  const trancheFactory = await TrancheFactory.deploy(tranche.address);
  await trancheFactory.deployed();

  const BondFactory = await getContractFactoryFromExternalArtifacts("BondFactory");
  const bondFactory = await BondFactory.deploy(bondController.address, trancheFactory.address);
  await bondFactory.deployed();

  return bondFactory;
};

export const bondAt = async (bond: string): Promise<Contract> => {
  const BondController = await getContractFactoryFromExternalArtifacts("BondController");
  return BondController.attach(bond);
};

export const createBondWithFactory = async (
  bondFactory: Contract,
  collateralToken: Contract,
  trancheRatios: number[],
  bondLength: number,
): Promise<Contract> => {
  const timeNow = await TimeHelpers.secondsFromNow(0);
  const maturityDate = timeNow + bondLength;

  const bondAddress = await bondFactory.callStatic.createBond(collateralToken.address, trancheRatios, maturityDate);
  await bondFactory.createBond(collateralToken.address, trancheRatios, maturityDate);

  return bondAt(bondAddress);
};

// Bond interaction helpers
export interface BondDeposit {
  amount: BigNumber;
  feeBps: BigNumber;
  from: string;
}
export const depositIntoBond = async (bond: Contract, amount: BigNumber, from: Signer): Promise<BondDeposit> => {
  const ButtonToken = await getContractFactoryFromExternalArtifacts("ButtonToken");
  const collateralToken = await ButtonToken.attach(await bond.collateralToken());

  await mintCollteralToken(collateralToken, amount, from);

  await collateralToken.connect(from).approve(bond.address, amount);
  const tx = await bond.connect(from).deposit(amount);
  const txR = await tx.wait();

  const depositEvent = txR.events[txR.events.length - 1].args;
  return depositEvent;
};

export const getTranches = async (bond: Contract): Promise<Contract[]> => {
  const count = await bond.trancheCount();
  const tranches: Contract[] = [];
  for (let i = 0; i < count; i++) {
    const Tranche = await getContractFactoryFromExternalArtifacts("Tranche");
    const t = await bond.tranches(i);
    tranches.push(await Tranche.attach(t[0]));
  }
  return tranches;
};

export const getStdTrancheBalances = async (bond: Contract, user: string): Promise<BigNumber[]> => {
  const tranches = await getTranches(bond);
  const balances: BigNumber[] = [];
  for (let i = 0; i < tranches.length; i++) {
    balances.push(await tranches[i].balanceOf(user));
  }
  return balances;
};

export const advancePerpQueue = async (perp: Contract, time: number): Promise<Transaction> => {
  await TimeHelpers.increaseTime(time);
  return perp.updateState();
};

export const advancePerpQueueToBondMaturity = async (perp: Contract, bond: Contract): Promise<Transaction> => {
  const bufferSec = await perp.minTrancheMaturiySec();
  const matuirtyDate = await bond.maturityDate();
  await TimeHelpers.setNextBlockTimestamp(matuirtyDate.sub(bufferSec).toNumber() + 1);
  return perp.updateState();
};

export const logReserveComposition = async (perp: Contract) => {
  const count = await perp.reserveCount();
  console.log("Reserve count", count);
  for (let i = 0; i < count; i++) {
    const token = await perp.reserveAt(i);
    console.log(i, token, await perp.reserveBalance(token));
  }
};

export const checkReserveComposition = async (perp: Contract, tokens: Contract[], balances: BigNumber[] = []) => {
  const checkBalances = balances.length > 0;
  expect(await perp.reserveCount()).to.eq(tokens.length);
  for (const i in tokens) {
    expect(await perp.isReserveToken(tokens[i].address)).to.eq(true);
    if (parseInt(i) > 0) {
      expect(await perp.isReserveTranche(tokens[i].address)).to.eq(true);
    }
    expect(await perp.reserveAt(i)).to.eq(tokens[i].address);
    if (checkBalances) {
      expect(await perp.reserveBalance(tokens[i].address)).to.eq(balances[i]);
    }
  }
  await expect(perp.reserveAt(tokens.length)).to.be.reverted;
};
