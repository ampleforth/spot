import { BigNumber, utils } from "ethers";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { getContractFactoryFromExternalArtifacts } from "../helpers";

task("ops:rebase:MockAMPL")
  .addParam("amplAddress", "the address of the AMPL contract", undefined, types.string, false)
  .addParam("rebasePerc", "the rebase percentage", "0.0", types.string)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { amplAddress, rebasePerc } = args;
    const rebasePercFloat = parseFloat(rebasePerc);

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    const UFragments = await getContractFactoryFromExternalArtifacts(hre.ethers, "UFragments");
    const ampl = await UFragments.attach(amplAddress);

    const UNIT_PERC = BigNumber.from(1e8);
    const PERC = BigNumber.from(Math.floor(Math.abs(rebasePercFloat) * 1e8));
    const ADJ_PERC = rebasePercFloat >= 0 ? UNIT_PERC.add(PERC) : UNIT_PERC.sub(PERC);
    const supply = await ampl.totalSupply();
    const newSupply = ADJ_PERC.mul(supply).div(UNIT_PERC);
    const supplyDiff = newSupply.sub(supply);
    const decimals = await ampl.decimals();

    console.log("Supply before", utils.formatUnits(supply, decimals));
    console.log("Applied diff", utils.formatUnits(supplyDiff, decimals));
    console.log("Rebase:");
    const tx = await ampl.connect(signer).rebase(1, supplyDiff);
    await tx.wait();
    console.log("Tx", tx.hash);
    console.log("Supply after", utils.formatUnits(await ampl.totalSupply(), decimals));
  });
