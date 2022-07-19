import { task } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { getContractFactoryFromExternalArtifacts } from "../helpers";

task("deploy:MockAMPL").setAction(async function (args: TaskArguments, hre) {
  const deployer = await (await hre.ethers.getSigners())[0].getAddress();
  console.log("Signer", deployer);

  const UFragments = await getContractFactoryFromExternalArtifacts(hre.ethers, "UFragments");
  const ampl = await UFragments.deploy();

  await ampl.deployed();

  const tx1 = await ampl["initialize(address)"](deployer);
  await tx1.wait();

  const tx2 = await ampl.setMonetaryPolicy(deployer);
  await tx2.wait();

  try {
    await hre.run("verify:contract", {
      address: ampl.address,
    });
  } catch (e) {
    console.log("Unable to verify on etherscan", e);
  }

  console.log("AMPL", ampl.address);
});
