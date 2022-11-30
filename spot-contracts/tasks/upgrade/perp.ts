import { getAdminAddress, getImplementationAddress } from "@openzeppelin/upgrades-core";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { sleep } from "../helpers";

task("upgrade:perp:testnet")
  .addPositionalParam("perpAddress", "the address of the perp contract", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { perpAddress } = args;

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Current implementation", await getImplementationAddress(hre.ethers.provider, perpAddress));

    const PerpetualTranche = await hre.ethers.getContractFactory("PerpetualTranche");
    const perp = await hre.upgrades.upgradeProxy(perpAddress, PerpetualTranche);
    await perp.deployed();

    const newImpl = await getImplementationAddress(hre.ethers.provider, perpAddress);
    console.log("Updated implementation", newImpl);

    await sleep(15);
    await hre.run("verify:contract", {
      address: newImpl,
    });
  });

task("prepare_upgrade:perp:mainnet")
  .addPositionalParam("perpAddress", "the address of the perp contract", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { perpAddress } = args;

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Proxy Admin", await getAdminAddress(hre.ethers.provider, perpAddress));

    const PerpetualTranche = await hre.ethers.getContractFactory("PerpetualTranche");
    const newImpl = await hre.upgrades.prepareUpgrade(perpAddress, PerpetualTranche);
    console.log("New implementation at:", newImpl);

    console.log("Update implementation through the multisig");
    console.log(`proxyAdmin.upgrade(${perpAddress}, ${newImpl})`);

    await sleep(15);
    await hre.run("verify:contract", {
      address: newImpl,
    });
  });
