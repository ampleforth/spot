import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { sleep } from "./helpers";

task("accounts", "Prints the list of accounts", async (_taskArgs, hre) => {
  const accounts = await hre.ethers.getSigners();
  for (const account of accounts) {
    console.log(await account.getAddress());
  }
});

task("verify:contract", "Verifies on etherscan")
  .addParam("address", "the contract address", undefined, types.string, false)
  .addParam("constructorArguments", "the list of constructor arguments", [], types.json, true)
  .addParam("sleepSec", "sleep time before verification", 15, types.int, true)
  .setAction(async function (args: TaskArguments, hre) {
    try {
      await sleep(args.sleepSec);
      await hre.run("verify:verify", {
        address: args.address,
        constructorArguments: args.constructorArguments,
      });
    } catch (e) {
      console.log("Unable to verify on etherscan");
      // console.warn(e)
      console.log(
        `yarn hardhat verify:contract --network ${hre.network.name} --address ${
          args.address
        } --constructor-arguments "${JSON.stringify(args.constructorArguments).replace(/"/g, '\\"')}"`,
      );
    }
  });

task("transferOwnership", "Transfers ownership of contract to new owner")
  .addPositionalParam("address", "the contract address", undefined, types.string, false)
  .addParam("newOwnerAddress", "the new owner address", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { address, newOwnerAddress } = args;
    const contract = await hre.ethers.getContractAt("OwnableUpgradeable", address);

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log(`Transferring ownership of ${address} to ${newOwnerAddress}`);
    await sleep(10);
    const tx = await contract.transferOwnership(newOwnerAddress);
    console.log(tx.hash);
    await tx.wait();
  });
