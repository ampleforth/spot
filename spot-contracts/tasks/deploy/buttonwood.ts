// Replicating: https://github.com/buttonwood-protocol/tranche/blob/main/tasks/deployers/tranche.ts
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { getContractFactoryFromExternalArtifacts } from "../helpers";

const DUMMY_ADDRESS = "0x000000000000000000000000000000000000dead";

task("deploy:BondFactory")
  .addParam("verify", "flag to set false for local deployments", true, types.boolean)
  .setAction(async function (args: TaskArguments, hre) {
    console.log("Signer", await (await hre.ethers.getSigners())[0].getAddress());
    const BondController = await getContractFactoryFromExternalArtifacts(hre.ethers, "BondController");
    const bondController = await BondController.deploy();
    await bondController.deployed();
    console.log("Bond controller", bondController.address);

    const Tranche = await getContractFactoryFromExternalArtifacts(hre.ethers, "Tranche");
    const tranche = await Tranche.deploy();
    await tranche.deployed();
    console.log("Tranche", tranche.address);

    const TrancheFactory = await getContractFactoryFromExternalArtifacts(hre.ethers, "TrancheFactory");
    const trancheFactory = await TrancheFactory.deploy(tranche.address);
    await trancheFactory.deployed();
    console.log("Tranche Factory", trancheFactory.address);

    await tranche["init(string,string,address,address)"]("IMPLEMENTATION", "IMPL", DUMMY_ADDRESS, DUMMY_ADDRESS);
    await bondController.init(
      trancheFactory.address,
      tranche.address,
      DUMMY_ADDRESS,
      [200, 300, 500],
      hre.ethers.constants.MaxUint256,
      0,
    );

    const BondFactory = await getContractFactoryFromExternalArtifacts(hre.ethers, "BondFactory");
    const bondFactory = await BondFactory.deploy(bondController.address, trancheFactory.address);
    await bondFactory.deployed();
    console.log("Bond Factory", bondFactory.address);

    if (args.verify) {
      try {
        await hre.run("verify:Template", { address: bondController.address });
        await hre.run("verify:Template", { address: tranche.address });
        await hre.run("verify:TrancheFactory", {
          address: trancheFactory.address,
          template: tranche.address,
        });
        await hre.run("verify:BondFactory", {
          address: bondFactory.address,
          template: bondController.address,
          trancheFactory: trancheFactory.address,
        });
      } catch (e) {
        console.log("Unable to verify on etherscan", e);
      }
    } else {
      console.log("Skipping verification");
    }
  });

task("verify:Template", "Verifies on etherscan")
  .addParam("address", "the contract address", undefined, types.string, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { address } = args;

    await hre.run("verify:contract", {
      address,
    });
  });

task("verify:TrancheFactory", "Verifies on etherscan")
  .addParam("address", "the contract address", undefined, types.string, false)
  .addParam("template", "the template address", undefined, types.string, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { address, template } = args;

    await hre.run("verify:contract", {
      address,
      constructorArguments: [template],
    });
  });

task("verify:BondFactory", "Verifies on etherscan")
  .addParam("address", "the contract address", undefined, types.string, false)
  .addParam("template", "the template address", undefined, types.string, false)
  .addParam("trancheFactory", "the tranche factory address", undefined, types.string, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { address, template, trancheFactory } = args;

    await hre.run("verify:contract", {
      address,
      constructorArguments: [template, trancheFactory],
    });
  });
