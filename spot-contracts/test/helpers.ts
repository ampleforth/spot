import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { Signer, Contract, ContractFactory, Transaction } from "ethers";
import * as fs from "fs";
import * as path from "path";

const TOKEN_DECIMALS = 18;
const PRICE_DECIMALS = 8;
const DISCOUNT_DECIMALS = 18;
const PERC_DECIMALS = 8;

const sciParseFloat = (a: string): BigInt => (a.includes("e") ? parseFloat(a).toFixed(18) : a);
export const toFixedPtAmt = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), TOKEN_DECIMALS);
export const toPriceFixedPtAmt = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), PRICE_DECIMALS);
export const toDiscountFixedPtAmt = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), DISCOUNT_DECIMALS);
export const toPercFixedPtAmt = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), PERC_DECIMALS);

const ORACLE_BASE_PRICE = toPriceFixedPtAmt("1");

const EXTERNAL_ARTIFACTS_PATH = path.join(__dirname, "/../external-artifacts");
export const getAbiFromExternalArtifacts = (name: string): Promise<ContractFactory> => {
  const artifact = JSON.parse(fs.readFileSync(`${EXTERNAL_ARTIFACTS_PATH}/${name}.json`).toString());
  return artifact.abi;
};
export const getContractFactoryFromExternalArtifacts = (name: string): Promise<ContractFactory> => {
  const artifact = JSON.parse(fs.readFileSync(`${EXTERNAL_ARTIFACTS_PATH}/${name}.json`).toString());
  return ethers.getContractFactoryFromArtifact(artifact);
};

export const TimeHelpers = {
  secondsFromNow: async (secondsFromNow: number): Promise<number> => {
    return (await TimeHelpers.currentTime()) + secondsFromNow;
  },

  increaseTime: async (seconds: number): Promise<void> => {
    await hre.network.provider.request({ method: "evm_increaseTime", params: [seconds] });
    await hre.network.provider.request({ method: "evm_mine" });
  },

  setNextBlockTimestamp: async (timestamp: number): Promise<void> => {
    await hre.network.provider.request({ method: "evm_setNextBlockTimestamp", params: [timestamp] });
    await hre.network.provider.request({ method: "evm_mine" });
  },

  currentTime: async (): Promise<number> => {
    const res = await hre.network.provider.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
    const timestamp = parseInt(res.timestamp, 16);
    return timestamp;
  },
};

export interface DMockMethod {
  methodName: string;
  parameters: any[];
  returnType: string;
  returnValue: any;
}

export class DMock {
  private refFactory: string;
  private contract: Contract | null = null;
  private target: string | null = null;

  constructor(refFactory: ContractFactory) {
    this.refFactory = refFactory;
  }

  public async deploy(): Promise<void> {
    this.contract = await (await ethers.getContractFactory("DMock")).deploy();
    this.target = this.contract.target;
  }

  public async mockMethod(methodFragment: string, returnValue: any = []): Promise<void> {
    if (!this.contract) {
      await this.deploy();
    }
    const methodFragmentObj = this.refFactory.interface.fragments.filter(
      f => f.type === "function" && f.format("sighash") === methodFragment,
    )[0];
    if (!methodFragmentObj) {
      throw Error(`Unkown function fragment ${methodFragment}, not part of the contract abi`);
    }
    const encodedReturnValue = ethers.AbiCoder.defaultAbiCoder().encode(methodFragmentObj.outputs, returnValue);
    await this.contract.mockMethod(methodFragmentObj.selector, encodedReturnValue);
  }

  public async clearMockMethod(methodFragment: string): Promise<void> {
    if (!this.contract) {
      await this.deploy();
    }
    const methodFragmentObj = this.refFactory.interface.fragments.filter(
      f => f.type === "function" && f.format("sighash") === methodFragment,
    )[0];
    if (!methodFragmentObj) {
      throw Error(`Unkown function fragment ${methodFragment}, not part of the contract abi`);
    }
    await this.contract.clearMockMethodSig(methodFragmentObj.selector);
  }

  public async mockCall(methodFragment: string, parameters: any, returnValue: any = []): Promise<void> {
    if (!this.contract) {
      await this.deploy();
    }
    const methodFragmentObj = this.refFactory.interface.fragments.filter(
      f => f.type === "function" && f.format("sighash") === methodFragment,
    )[0];
    if (!methodFragmentObj) {
      throw Error(`Unkown function fragment ${methodFragment}, not part of the contract abi`);
    }
    const encodedData = this.refFactory.interface.encodeFunctionData(methodFragmentObj, parameters);
    await this.contract.mockCall(
      encodedData,
      ethers.AbiCoder.defaultAbiCoder().encode(methodFragmentObj.outputs, returnValue),
    );
  }

  public async staticCall(methodFragment: string, parameters: any = []): Promise<any> {
    const mock = this.refFactory.attach(this.contract.target);
    return mock[methodFragment].staticCall(...parameters);
  }
}

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

  const rebaseOracle = new DMock(await getContractFactoryFromExternalArtifacts("MedianOracle"));
  await rebaseOracle.deploy();
  await rebaseOracle.mockMethod("getData()", [ORACLE_BASE_PRICE, true]);

  const ButtonToken = await getContractFactoryFromExternalArtifacts("ButtonToken");
  const collateralToken = await ButtonToken.deploy();
  await collateralToken.initialize(underlyingToken.target, `Button ${name}`, `btn-${symbol}`, rebaseOracle.target);

  return {
    underlyingToken,
    rebaseOracle,
    collateralToken,
  };
};

export const mintCollteralToken = async (collateralToken: Contract, amount: BigInt, from: Signer) => {
  const fromAddress = await from.getAddress();
  const ERC20 = await ethers.getContractFactory("MockERC20");
  const underlyingToken = await ERC20.attach(await collateralToken.underlying());
  const cAmount = await collateralToken.wrapperToUnderlying(amount);
  await underlyingToken.connect(from).mint(fromAddress, cAmount);
  await underlyingToken.connect(from).approve(collateralToken.target, cAmount);
  await collateralToken.connect(from).mint(amount);
};

export const rebase = async (token: Contract, oracle: Contract, perc: number) => {
  const p = await token.lastPrice();
  const delta = BigInt(Number(ORACLE_BASE_PRICE) * perc);
  const newPrice = (p * (ORACLE_BASE_PRICE + delta)) / ORACLE_BASE_PRICE;
  await oracle.mockMethod("getData()", [newPrice, true]);
  await token.rebase();
};

// Button tranche
export const setupBondFactory = async (): Promise<Contract> => {
  const BondController = await getContractFactoryFromExternalArtifacts("BondController");
  const bondController = await BondController.deploy();

  const Tranche = await getContractFactoryFromExternalArtifacts("Tranche");
  const tranche = await Tranche.deploy();

  const TrancheFactory = await getContractFactoryFromExternalArtifacts("TrancheFactory");
  const trancheFactory = await TrancheFactory.deploy(tranche.target);

  const BondFactory = await getContractFactoryFromExternalArtifacts("BondFactory");
  const bondFactory = await BondFactory.deploy(bondController.target, trancheFactory.target);
  return bondFactory;
};

export const bondAt = async (bond: string): Promise<Contract> => {
  const BondController = await getContractFactoryFromExternalArtifacts("BondController");
  return BondController.attach(bond);
};

export const trancheAt = async (tranche: string): Promise<Contract> => {
  const Tranche = await getContractFactoryFromExternalArtifacts("Tranche");
  return Tranche.attach(tranche);
};

export const createBondWithFactory = async (
  bondFactory: Contract,
  collateralToken: Contract,
  trancheRatios: number[],
  bondLength: number,
): Promise<Contract> => {
  const timeNow = await TimeHelpers.secondsFromNow(0);
  const maturityDate = timeNow + bondLength;
  const bondAddress = await bondFactory.createBond.staticCall(collateralToken.target, trancheRatios, maturityDate);
  await bondFactory.createBond(collateralToken.target, trancheRatios, maturityDate);
  return bondAt(bondAddress);
};

// Bond interaction helpers
export interface BondDeposit {
  amount: BigInt;
  feeBps: BigInt;
  from: string;
}

export const depositIntoBond = async (bond: Contract, amount: BigInt, from: Signer): Promise<BondDeposit> => {
  const ButtonToken = await getContractFactoryFromExternalArtifacts("ButtonToken");
  const collateralToken = await ButtonToken.attach(await bond.collateralToken());

  await mintCollteralToken(collateralToken, amount, from);

  await collateralToken.connect(from).approve(bond.target, amount);
  const tx = await bond.connect(from).deposit(amount);
  const txR = await tx.wait();

  const depositEvent = txR.logs[txR.logs.length - 1].args;
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

export const getTrancheBalances = async (bond: Contract, user: string): Promise<BigInt[]> => {
  const tranches = await getTranches(bond);
  const balances: BigInt[] = [];
  for (let i = 0; i < tranches.length; i++) {
    balances.push(await tranches[i].balanceOf(user));
  }
  return balances;
};

export const timeToMaturity = async (bond: Contract): Promise<number> => {
  return Number(await bond.maturityDate()) - (await TimeHelpers.currentTime());
};

export const getDepositBond = async (perp: Contract): Contract => {
  return bondAt(await perp.getDepositBond.staticCall());
};

export const advanceTime = async (time: number): Promise<Transaction> => {
  return TimeHelpers.increaseTime(time);
};

export const advancePerpQueue = async (perp: Contract, time: number): Promise<Transaction> => {
  await TimeHelpers.increaseTime(time);
  return perp.updateState();
};

export const advancePerpQueueUpToBondMaturity = async (perp: Contract, bond: Contract): Promise<Transaction> => {
  await perp.updateState();
  const matuirtyDate = await bond.maturityDate();
  await TimeHelpers.setNextBlockTimestamp(Number(matuirtyDate));
};

export const advancePerpQueueToBondMaturity = async (perp: Contract, bond: Contract): Promise<Transaction> => {
  await advancePerpQueueUpToBondMaturity(perp, bond);
  await TimeHelpers.increaseTime(1);
  return perp.updateState();
};

export const advancePerpQueueToRollover = async (perp: Contract, bond: Contract): Promise<Transaction> => {
  await perp.updateState();
  const bufferSec = await perp.minTrancheMaturitySec();
  const matuirtyDate = await bond.maturityDate();
  await TimeHelpers.setNextBlockTimestamp(Number(matuirtyDate - bufferSec));
  await perp.updateState();
  await TimeHelpers.increaseTime(1);
  return perp.updateState();
};

export const logPerpAssets = async (perp: Contract) => {
  const ERC20 = await ethers.getContractFactory("MockERC20");
  const count = await perp.getReserveCount.staticCall();
  console.log("Perp assets", count);
  for (let i = 0; i < count; i++) {
    const token = await ERC20.attach(await perp.getReserveAt.staticCall(i));
    const ONE = ethers.parseUnits("1", await perp.decimals());
    const tokenVal = await perp.getReserveTokenValue.staticCall(token.target);
    const tokenBal = await perp.getReserveTokenBalance.staticCall(token.target);
    const tokenPrice = tokenBal > 0n ? (tokenVal * ONE) / tokenBal : 0n;
    console.log(
      i,
      token.target,
      ethers.formatUnits(await token.balanceOf(perp.target), await perp.decimals()),
      ethers.formatUnits(tokenPrice, await perp.decimals()),
    );
  }
};

export const checkPerpComposition = async (perp: Contract, tokens: Contract[], balances: BigInt[] = []) => {
  const checkBalances = balances.length > 0;
  expect(await perp.getReserveCount.staticCall()).to.eq(tokens.length);

  const tokenMap = {};
  const tokenBalanceMap = {};
  for (const i in tokens) {
    tokenMap[tokens[i].target] = true;
    if (checkBalances) {
      tokenBalanceMap[tokens[i].target] = balances[i];
    }
  }

  const ERC20 = await ethers.getContractFactory("MockERC20");
  for (let j = 0; j < tokens.length; j++) {
    const reserveToken = ERC20.attach(await perp.getReserveAt.staticCall(j));
    expect(tokenMap[reserveToken.target]).to.eq(true);
    if (checkBalances) {
      expect(await reserveToken.balanceOf(perp.target)).to.eq(tokenBalanceMap[reserveToken.target]);
    }
  }
  await expect(perp.getReserveAt.staticCall(tokens.length)).to.be.reverted;
};

export const getReserveTokens = async (perp: Contract) => {
  const ERC20 = await ethers.getContractFactory("MockERC20");
  const reserves: Contract[] = [];
  for (let i = 0; i < (await perp.getReserveCount()); i++) {
    reserves.push(await ERC20.attach(await perp.getReserveAt.staticCall(i)));
  }
  return reserves;
};

export const logVaultAssets = async (vault: Contract) => {
  const ERC20 = await ethers.getContractFactory("MockERC20");
  const count = await vault.assetCount();
  const assetCount = await vault.assetCount();
  console.log("Vault assets", count);

  const underlying = await ERC20.attach(await vault.underlying());
  console.log(
    0,
    underlying.target,
    ethers.formatUnits(await vault.vaultAssetBalance(underlying.target), await underlying.decimals()),
  );
  for (let i = 1; i < assetCount; i++) {
    const token = await ERC20.attach(await vault.assetAt(i));
    console.log(
      i + 1,
      token.target,
      ethers.formatUnits(await vault.vaultAssetBalance(token.target), await token.decimals()),
    );
  }
};

export const checkVaultComposition = async (vault: Contract, tokens: Contract[], balances: BigInt[] = []) => {
  expect(await vault.assetCount()).to.eq(tokens.length);
  for (const i in tokens) {
    expect(await vault.vaultAssetBalance(tokens[i].target)).to.eq(balances[i]);
  }
};

export const getVaultAssets = async (vault: Contract) => {
  const ERC20 = await ethers.getContractFactory("MockERC20");
  const assets: Contract[] = [];
  for (let i = 0; i < (await vault.assetCount()); i++) {
    assets.push(await ERC20.attach(await vault.assetAt(i)));
  }
  return assets;
};
