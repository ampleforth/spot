import { getImplementationAddress } from "@openzeppelin/upgrades-core";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { sleep } from "../helpers";

task("upgrade:rolloverVault:testnet")
  .addPositionalParam("vaultAddress", "the address of the rollover vault contract", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress } = args;

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Current implementation", await getImplementationAddress(hre.ethers.provider, vaultAddress));

    const RolloverVault = await hre.ethers.getContractFactory("RolloverVault");
    const vault = await hre.upgrades.upgradeProxy(vaultAddress, RolloverVault);
    await vault.deployed();

    const newImpl = await getImplementationAddress(hre.ethers.provider, vaultAddress);
    console.log("Updated implementation", newImpl);

    await sleep(15);
    await hre.run("verify:contract", {
      address: newImpl,
    });
  });
