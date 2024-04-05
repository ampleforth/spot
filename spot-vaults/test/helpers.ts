import { ethers } from "hardhat";
import { Contract, ContractFactory } from "ethers";

const sciParseFloat = (a: string): BigInt =>
  a.includes("e") ? parseFloat(a).toFixed(18) : a;
export const usdFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 6);
export const perpFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 9);
export const percentageFP = (a: string): BigInt =>
  ethers.parseUnits(sciParseFloat(a), 18);
export const priceFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);
export const lpAmtFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);
export const oracleAnsFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 8);

export class DMock {
  private refArtifact: string;
  private refFactory: ContractFactory;
  private contract: Contract | null = null;
  private target: string | null = null;

  constructor(refArtifact: string) {
    this.refArtifact = refArtifact;
  }

  public async deploy(): Promise<void> {
    this.refFactory = await ethers.getContractFactory(this.refArtifact);
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

  public async staticCall(methodFragment: string, parameters: any = []): Promise<any> {
    const mock = this.refFactory.attach(this.contract.target);
    return mock[methodFragment].staticCall(...parameters);
  }
}
