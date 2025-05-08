import fs from "fs";
import { task, types } from "hardhat/config";
import { TaskArguments, HardhatRuntimeEnvironment } from "hardhat/types";
import { constants, Contract, BigNumber, Signer } from "ethers";
import { generateGnosisSafeBatchFile, ProposedTransaction } from "../helpers";

async function matureBond(bond: Contract, signer: Signer) {
  if (await bond.isMature()) {
    return true;
  }
  try {
    console.log("Invoking Mature");
    await bond.connect(signer).mature.staticCall();
    const tx = await bond.connect(signer).mature();
    await tx.wait();
    console.log("Tx:", tx.hash);
  } catch (e) {
    console.log("Not up for maturity");
    return false;
  }
  return true;
}

async function getTranches(hre: HardhatRuntimeEnvironment, bond: Contract): Promise<[Contract, BigNumber][]> {
  const trancheCount = await bond.trancheCount();
  const tranches: [Contract, BigNumber][] = [];
  for (let i = 0; i < trancheCount; i++) {
    const [address, ratio] = await bond.tranches(i);
    const tranche = await hre.ethers.getContractAt("ITranche", address);
    tranches.push([tranche, ratio]);
  }
  return tranches;
}

function computeProportionalBalances(balances: BigNumber[], ratios: BigNumber[]): BigNumber[] {
  if (balances.length !== ratios.length) {
    throw Error("balances and ratios length mismatch");
  }

  const redeemableAmts: BigNumber[] = [];
  let min = BigNumber.from(constants.MaxUint256);
  for (let i = 0; i < balances.length && min.gt("0"); i++) {
    const b = balances[i].sub(balances[i].mod(ratios[i]));
    const d = b.mul("1000").div(ratios[i]);
    if (d.lt(min)) {
      min = d;
    }
  }

  for (let i = 0; i < balances.length; i++) {
    redeemableAmts[i] = ratios[i].mul(min).div("1000");
  }
  return redeemableAmts;
}

async function computeRedeemableTrancheAmounts(bt: [Contract, BigNumber][], address: string): Promise<BigNumber[]> {
  const balances: BigNumber[] = [];
  const ratios: BigNumber[] = [];
  for (let i = 0; i < bt.length; i++) {
    balances.push(await bt[i][0].balanceOf(address));
    ratios.push(bt[i][1]);
  }
  return computeProportionalBalances(balances, ratios);
}

task("ops:redeemTranches")
  .addParam("bondIssuerAddress", "the address of the bond issuer contract", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre: HardhatRuntimeEnvironment) {
    const { bondIssuerAddress } = args;
    const bondIssuer = await hre.ethers.getContractAt("BondIssuer", bondIssuerAddress);
    console.log(await bondIssuer.collateral());

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    // mature active bonds
    console.log("---------------------------------------------------------------");
    console.log("Mature active");
    try {
      await bondIssuer.matureActive();
    } catch {
      console.log("No active bonds mature");
    }

    // iterate through the bonds
    const issuedCount = await bondIssuer.issuedCount();
    for (let i = 0; i < issuedCount; i++) {
      console.log(i);
      const bondAddress = await bondIssuer.issuedBondAt(i);
      const bond = await hre.ethers.getContractAt("IBondController", bondAddress);

      console.log("---------------------------------------------------------------");
      console.log("Processing bond", bondAddress);

      const bt = await getTranches(hre, bond);
      const isMature = await matureBond(bond, signer);

      if (isMature) {
        for (let j = 0; j < bt.length; j++) {
          const b = await bt[j][0].balanceOf(signerAddress);
          if (b.gt(0)) {
            console.log("Redeeming mature tranche", bt[j][0].target);
            const tx = await bond.connect(signer).redeemMature(bt[j][0].target, b);
            await tx.wait();
            console.log("Tx:", tx.hash);
          }
        }
      } else {
        const redemptionAmounts = await computeRedeemableTrancheAmounts(bt, signerAddress);
        if (redemptionAmounts[0].gt("0")) {
          console.log(
            "Redeeming immature bond",
            redemptionAmounts.map(a => a.toString()),
          );
          const tx = await bond.connect(signer).redeem(redemptionAmounts);
          await tx.wait();
          console.log("Tx:", tx.hash);
        }
      }
    }
  });

task("ops:preview_tx:redeemTranches")
  .addParam("walletAddress", "the address of the wallet with the collateral token", undefined, types.string, false)
  .addParam("bondIssuerAddress", "the address of the bond issuer", undefined, types.string, false)
  .addParam("depth", "the number of bonds to check", 5, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { walletAddress, bondIssuerAddress, depth } = args;
    const txs: ProposedTransaction[] = [];
    const bondIssuer = await hre.ethers.getContractAt("BondIssuer", bondIssuerAddress);

    const issuedCount = await bondIssuer.issuedCount.staticCall();
    for (let i = issuedCount - 1; i > 0 && issuedCount - 1 - i < depth; i--) {
      const bondAddress = await bondIssuer.issuedBondAt.staticCall(i);
      const bond = await hre.ethers.getContractAt("IBondController", bondAddress);

      const bt = await getTranches(hre, bond);
      const isMature = await bond.isMature();

      if (isMature) {
        for (let j = 0; j < bt.length; j++) {
          const b = await bt[j][0].balanceOf(walletAddress);
          if (b.gt(0)) {
            txs.push({
              contract: bond,
              method: "redeemMature",
              args: [bt[j][0].target, b.toString()],
            });
          }
        }
      } else {
        const redemptionAmounts = await computeRedeemableTrancheAmounts(bt, walletAddress);
        if (redemptionAmounts[0].gt("0")) {
          txs.push({
            contract: bond,
            method: "redeem",
            args: [JSON.stringify(redemptionAmounts.map(a => a.toString()))],
          });
        }
      }
    }

    console.log("---------------------------------------------------------------");
    console.log("Execute the following transactions");

    for (let i = 0; i < txs.length; i++) {
      console.log({ to: txs[i].contract.target, method: txs[i].method, args: txs[i].args });
    }

    console.log("Wrote tx batch to file:", "RedeemBatch.json");
    fs.writeFileSync("RedeemBatch.json", JSON.stringify(await generateGnosisSafeBatchFile(hre, txs), null, 2));
  });
