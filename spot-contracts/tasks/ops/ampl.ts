import { BigNumber } from "ethers";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { getContractFactoryFromExternalArtifacts } from "../helpers";

task("ops:rebase:MockAMPL")
  .addParam("amplAddress", "the address of the AMPL contract", undefined, types.string, false)
  .addParam("rebasePerc", "the rebase percentage", 0.0, types.float)
  .setAction(async function (args: TaskArguments, hre) {
    const { amplAddress, rebasePerc } = args;

    const deployer = await (await hre.ethers.getSigners())[0].getAddress();
    console.log("Signer", deployer);

    const UFragments = await getContractFactoryFromExternalArtifacts(hre.ethers, "UFragments");
    const ampl = await UFragments.attach(amplAddress);

    const UNIT_PERC = BigNumber.from(1e8);
    const PERC = BigNumber.from(Math.floor(Math.abs(rebasePerc) * 1e8));
    const ADJ_PERC = rebasePerc >= 0 ? PERC.add(UNIT_PERC) : PERC.sub(UNIT_PERC);
    const supply = await ampl.totalSupply();
    const newSupply = ADJ_PERC.mul(supply).div(UNIT_PERC);
    const supplyDiff = newSupply.sub(supply);

    console.log("Rebase:");
    const tx = await ampl.rebase(1, supplyDiff);
    await tx.wait();
    console.log("Tx", tx.hash);
  });
