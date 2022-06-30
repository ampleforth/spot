import * as fs from "fs";
import * as path from "path";
import { ContractFactory } from "ethers";

const EXTERNAL_ARTIFACTS_PATH = path.join(__dirname, "/../external-artifacts");
export async function getContractFactoryFromExternalArtifacts(ethers: any, name: string): Promise<ContractFactory> {
  const artifact = JSON.parse(fs.readFileSync(`${EXTERNAL_ARTIFACTS_PATH}/${name}.json`).toString());
  return ethers.getContractFactoryFromArtifact(artifact);
}
