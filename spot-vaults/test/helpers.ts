import { ethers } from "hardhat";
import { Contract, ContractFactory } from "ethers";

export const sciParseFloat = (a: string): BigInt =>
  a.includes("e") ? parseFloat(a).toFixed(18) : a;
export const percFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);
export const priceFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);

export const usdFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 6);
export const perpFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 9);
export const lpAmtFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 24);
export const amplFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 9);
export const wamplFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);
export const wethFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);
export const usdOracleFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 8);
export const ethOracleFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);
export const amplOracleFP = (a: string): BigInt =>
  ethers.parseUnits(sciParseFloat(a), 18);
export const drFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 8);

export class DMock {
  private refArtifact: string;
  private refFactory: ContractFactory;
  private contract: Contract | null = null;
  private target: string | null = null;

  constructor(refArtifact: string) {
    this.refArtifact = refArtifact;
  }

  public async deploy(): Promise<void> {
    this.contract = await (await ethers.getContractFactory("DMock")).deploy();
    this.target = this.contract.target;
    this.refFactory = await ethers.getContractAt(this.refArtifact, this.target);
  }

  public async mockMethod(methodFragment: string, returnValue: any = []): Promise<void> {
    if (!this.contract) {
      await this.deploy();
    }
    const methodFragmentObj = this.refFactory.interface.fragments.filter(
      f => f.type === "function" && f.format("sighash") === methodFragment,
    )[0];
    if (!methodFragmentObj) {
      throw Error(
        `Unkown function fragment ${methodFragment}, not part of the contract abi`,
      );
    }
    const encodedReturnValue = ethers.AbiCoder.defaultAbiCoder().encode(
      methodFragmentObj.outputs,
      returnValue,
    );
    await this.contract.mockMethod(methodFragmentObj.selector, encodedReturnValue);
  }

  public async mockCall(
    methodFragment: string,
    parameters: any,
    returnValue: any = [],
  ): Promise<void> {
    if (!this.contract) {
      await this.deploy();
    }
    const methodFragmentObj = this.refFactory.interface.fragments.filter(
      f => f.type === "function" && f.format("sighash") === methodFragment,
    )[0];
    if (!methodFragmentObj) {
      throw Error(
        `Unkown function fragment ${methodFragment}, not part of the contract abi`,
      );
    }
    const encodedData = this.refFactory.interface.encodeFunctionData(
      methodFragmentObj,
      parameters,
    );
    await this.contract.mockCall(
      encodedData,
      ethers.AbiCoder.defaultAbiCoder().encode(methodFragmentObj.outputs, returnValue),
    );
  }

  public async clearMockMethod(methodFragment: string): Promise<void> {
    if (!this.contract) {
      await this.deploy();
    }
    const methodFragmentObj = this.refFactory.interface.fragments.filter(
      f => f.type === "function" && f.format("sighash") === methodFragment,
    )[0];
    if (!methodFragmentObj) {
      throw Error(
        `Unkown function fragment ${methodFragment}, not part of the contract abi`,
      );
    }
    await this.contract.clearMockMethodSig(methodFragmentObj.selector);
  }

  public async clearMockCall(methodFragment: string, parameters: any): Promise<void> {
    if (!this.contract) {
      await this.deploy();
    }
    const methodFragmentObj = this.refFactory.interface.fragments.filter(
      f => f.type === "function" && f.format("sighash") === methodFragment,
    )[0];
    if (!methodFragmentObj) {
      throw Error(
        `Unkown function fragment ${methodFragment}, not part of the contract abi`,
      );
    }
    const encodedData = this.refFactory.interface.encodeFunctionData(
      methodFragmentObj,
      parameters,
    );
    await this.contract.clearMockCall(encodedData);
  }

  public async staticCall(methodFragment: string, parameters: any = []): Promise<any> {
    const mock = this.refFactory.attach(this.contract.target);
    return mock[methodFragment].staticCall(...parameters);
  }
}

export function univ3PositionKey(owner, tickLower, tickUpper): string {
  const checksummedAddress = ethers.getAddress(owner);
  const encodedData = ethers.solidityPacked(
    ["address", "int24", "int24"],
    [checksummedAddress, tickLower, tickUpper],
  );
  return ethers.keccak256(encodedData);
}
