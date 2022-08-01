import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { getContractFactoryFromExternalArtifacts } from "../helpers";

task("deploy:MockAMPL")
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    const UFragments = await getContractFactoryFromExternalArtifacts(hre.ethers, "UFragments");
    const ampl = (await UFragments.connect(signer).deploy()).connect(signer);
    await ampl.deployed();

    const tx1 = await ampl["initialize(address)"](signerAddress);
    await tx1.wait();

    const tx2 = await ampl.setMonetaryPolicy(signerAddress);
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
