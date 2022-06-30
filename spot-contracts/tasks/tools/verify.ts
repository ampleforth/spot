import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";

task("verify:contract", "Verifies on etherscan")
  .addParam("address", "the contract address", undefined, types.string, false)
  .addParam("constructorArguments", "the list of constructor arguments", [], types.json, true)
  .addParam("sleepSec", "sleep time before verification", 15, types.int, true)
  .setAction(async function (args: TaskArguments, hre) {
    try {
      await new Promise(resolve => setTimeout(resolve, args.sleepSec));
      await hre.run("verify:verify", {
        address: args.address,
        constructorArguments: args.constructorArguments,
      });
    } catch (e) {
      console.log("Unable to verify on etherscan");
      console.log(
        `yarn hardhat verify:contract --network ${hre.network.name} --address ${
          args.address
        } --constructor-arguments "${JSON.stringify(args.constructorArguments).replace(/"/g, '\\"')}"`,
      );
    }
  });
