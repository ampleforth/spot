import * as fs from "fs";
import * as path from "path";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { ContractFactory, Contract, utils } from "ethers";

const EXTERNAL_ARTIFACTS_PATH = path.join(__dirname, "/../external-artifacts");
export async function getContractFactoryFromExternalArtifacts(ethers: any, name: string): Promise<ContractFactory> {
  const artifact = JSON.parse(fs.readFileSync(`${EXTERNAL_ARTIFACTS_PATH}/${name}.json`).toString());
  return ethers.getContractFactoryFromArtifact(artifact);
}

export const sleep = seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000));

interface ContractInput {
  internalType: string;
  name: string;
  type: string;
  components?: ContractInput[];
}

interface ContractMethod {
  inputs: ContractInput[];
  name: string;
  payable: boolean;
}

interface BatchFileMeta {
  txBuilderVersion?: string;
  name: string;
  description?: string;
}

interface BatchTransaction {
  to: string;
  value: string;
  data?: string;
  contractMethod?: ContractMethod;
  contractInputsValues?: { [key: string]: string };
}

interface BatchFile {
  version: string;
  chainId: string;
  createdAt: number;
  meta: BatchFileMeta;
  transactions: BatchTransaction[];
}

export interface ProposedTransaction {
  contract: Contract;
  method: string;
  args: any[];
}

function encodeContractTx(p: ProposedTransaction): BatchTransaction {
  const methodFragment = JSON.parse(p.contract.interface.getFunction(p.method).format(utils.FormatTypes.json));
  return {
    to: p.contract.address,
    value: "0",
    data: "",
    contractMethod: methodFragment,
    contractInputsValues: methodFragment.inputs
      .map((m: ContractInput) => m.name)
      .reduce((m: { [key: string]: string }, e: string, i: number) => {
        m[e] = p.args[i];
        return m;
      }, {}),
  };
}

export async function generateGnosisSafeBatchFile(
  hre: HardhatRuntimeEnvironment,
  transactions: ProposedTransaction[],
): Promise<BatchFile> {
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  return {
    version: "1.0",
    chainId: `${chainId}`,
    createdAt: Date.now(),
    meta: {
      name: "Transaction Batch",
      description: "Script generated transaction batch. Verify manually before execution!",
      txBuilderVersion: "1.11.1",
    },
    transactions: transactions.map(encodeContractTx),
  };
}
