import { getAdminAddress, getImplementationAddress } from "@openzeppelin/upgrades-core";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { sleep } from "./tools";

task("validate_upgrade")
  .addPositionalParam(
    "factory",
    "the name of the factory",
    undefined,
    types.string,
    false,
  )
  .addPositionalParam(
    "address",
    "the address of the deployed proxy contract",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const { factory, address } = args;
    const Factory = await hre.ethers.getContractFactory(factory);
    console.log("Trying strict validation");
    try {
      await hre.upgrades.validateUpgrade(address, Factory);
    } catch (e) {
      console.log("Strict validation failed. ", e);
      console.log("Retrying but allowing variable renames.");
      await hre.upgrades.validateUpgrade(address, Factory, {
        unsafeAllowRenames: true,
      });
    }
    console.log("Success");
  });

task("prepare_upgrade")
  .addPositionalParam(
    "factory",
    "the name of the factory",
    undefined,
    types.string,
    false,
  )
  .addPositionalParam(
    "address",
    "the address of the deployed proxy contract",
    undefined,
    types.string,
    false,
  )
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { factory, address } = args;

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Proxy Admin", await getAdminAddress(hre.ethers.provider, address));

    const Factory = await hre.ethers.getContractFactory(factory);
    const newImpl = await hre.upgrades.prepareUpgrade(address, Factory, {
      unsafeAllowRenames: true,
    });
    console.log("Deploying using", factory);
    console.log("New implementation at:", newImpl);

    console.log("Update implementation by running the following:");
    console.log(`proxyAdmin.upgrade(${address}, ${newImpl})`);

    await sleep(15);
    await hre.run("verify:contract", {
      address: newImpl,
    });
  });

task("upgrade:testnet")
  .addPositionalParam(
    "factory",
    "the name of the factory",
    undefined,
    types.string,
    false,
  )
  .addPositionalParam(
    "address",
    "the address of the deployed proxy contract",
    undefined,
    types.string,
    false,
  )
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    const { factory, address } = args;
    const Factory = await hre.ethers.getContractFactory(factory);

    console.log("Proxy", address);
    console.log(
      "Current implementation",
      await getImplementationAddress(hre.ethers.provider, address),
    );

    await hre.upgrades.upgradeProxy(address, Factory, {
      unsafeAllowRenames: true,
    });
    await sleep(30);
    const newImpl = await getImplementationAddress(hre.ethers.provider, address);
    console.log("Updated implementation", newImpl);

    await sleep(15);
    await hre.run("verify:contract", {
      address: newImpl,
    });
  });
