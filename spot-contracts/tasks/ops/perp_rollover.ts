import fs from "fs";
import { task, types } from "hardhat/config";
import { TaskArguments, HardhatRuntimeEnvironment } from "hardhat/types";
import { utils, constants, Contract, BigNumber, Signer } from "ethers";
import { generateGnosisSafeBatchFile, ProposedTransaction } from "../helpers";

async function matureBond(bond: Contract, signer: Signer) {
  if (await bond.isMature()) {
    return true;
  }
  try {
    console.log("Invoking Mature");
    await bond.connect(signer).callStatic.mature();
    const tx = await bond.connect(signer).mature();
    await tx.wait();
    console.log("Tx:", tx.hash);
  } catch (e) {
    console.log("Not up for maturity");
    return false;
  }
  return true;
}

async function getTrancheData(hre: HardhatRuntimeEnvironment, bond: Contract): Promise<[Contract, BigNumber][]> {
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
    const d = balances[i].mul("1000").div(ratios[i]);
    if (d.lt(min)) {
      min = d;
    }
  }
  for (let i = 0; i < balances.length; i++) {
    redeemableAmts[i] = ratios[i].mul(min).div("1000");
  }
  return redeemableAmts;
}

async function computeRedeemableTrancheAmounts(td: [Contract, BigNumber][], address: string): Promise<BigNumber[]> {
  const balances: BigNumber[] = [];
  const ratios: BigNumber[] = [];
  for (let i = 0; i < td.length; i++) {
    balances.push(await td[i][0].balanceOf(address));
    ratios.push(td[i][1]);
  }
  return computeProportionalBalances(balances, ratios);
}

interface RolloverData {
  trancheIn: Contract;
  tokenOut: Contract;
  trancheInAmt: BigNumber;
  tokenOutAmt: BigNumber;
}

interface RolloverBatch {
  depositBond: Contract;
  depositTranches: Contract[];
  totalRolloverAmt: BigNumber;
  totalRolloverFee: BigNumber;
  remainingTrancheInAmts: BigNumber[];
  remainingTokenOutAmts: BigNumber[];
  rolloverData: RolloverData[];
  collateralUsed: BigNumber;
  excessCollateral: BigNumber;
}

async function computeRolloverBatchExact(
  hre: HardhatRuntimeEnvironment,
  router: Contract,
  perp: Contract,
  collateralUsed: BigNumber,
): Promise<RolloverBatch> {
  const bondIssuer = await hre.ethers.getContractAt("BondIssuer", await perp.bondIssuer());
  const collateralToken = await hre.ethers.getContractAt("MockERC20", await bondIssuer.collateral());
  const [depositBondAddress, trancheAddresses, depositTrancheAmts] = await router.callStatic.previewTranche(
    perp.address,
    collateralUsed,
  );
  const depositBond = await hre.ethers.getContractAt("IBondController", depositBondAddress);

  // Fresh Tranches
  const depositTranches = [];
  const trancheRatios = [];
  for (let i = 0; i < trancheAddresses.length; i++) {
    depositTranches.push(await hre.ethers.getContractAt("ITranche", trancheAddresses[i]));
    trancheRatios.push(await bondIssuer.trancheRatios(i));
  }

  // Tranches up for rollover
  const reserveCount = (await perp.callStatic.getReserveCount()).toNumber();
  const upForRotation = await perp.callStatic.getReserveTokensUpForRollover();
  const reserveTokens = [];
  const reserveTokenBalances = [];
  const rotationTokens = [];
  const rotationTokenBalances = [];
  for (let i = 0; i < reserveCount; i++) {
    const tranche = await hre.ethers.getContractAt("ITranche", await perp.callStatic.getReserveAt(i));
    const balance = await perp.callStatic.getReserveTrancheBalance(tranche.address);
    reserveTokens.push(tranche);
    reserveTokenBalances.push(balance);
    if (upForRotation[i] !== constants.AddressZero && balance.gt(0)) {
      rotationTokens.push(tranche);
      rotationTokenBalances.push(balance);
    }
  }

  // continues to the next token when only DUST remains
  const DUST_AMOUNT = utils.parseUnits("1", await perp.decimals());

  // Amounts at the start
  const remainingTrancheInAmts: BigNumber[] = depositTrancheAmts.map((t: BigNumber) => t);
  const remainingTokenOutAmts: BigNumber[] = rotationTokenBalances.map(b => b);

  // For each tranche token, and each token up for rollover
  // We try to rollover and once depleted (upto dust) and move on to the next pair
  const rolloverData: RolloverData[] = [];
  let totalRolloverAmt = BigNumber.from("0");
  let totalRolloverFee = BigNumber.from("0");

  for (let i = 0, j = 0; i < depositTranches.length && j < rotationTokens.length; ) {
    const trancheIn = depositTranches[i];
    const tokenOut = rotationTokens[j];
    const [rd, , rolloverFee] = await router.callStatic.previewRollover(
      perp.address,
      trancheIn.address,
      tokenOut.address,
      remainingTrancheInAmts[i],
      remainingTokenOutAmts[j],
    );

    // trancheIn isn't accepted by perp, likely because yield=0
    if (rd.perpRolloverAmt.eq("0")) {
      i++;
      continue;
    }

    rolloverData.push({
      trancheIn,
      tokenOut,
      trancheInAmt: rd.trancheInAmt,
      tokenOutAmt: rd.tokenOutAmt,
    });

    totalRolloverAmt = totalRolloverAmt.add(rd.perpRolloverAmt);
    totalRolloverFee = totalRolloverFee.add(rolloverFee);

    remainingTrancheInAmts[i] = rd.remainingTrancheInAmt;
    remainingTokenOutAmts[j] = remainingTokenOutAmts[j].sub(rd.tokenOutAmt);

    // trancheIn tokens are exhausted
    if (remainingTrancheInAmts[i].lte(DUST_AMOUNT)) {
      i++;
    }

    // tokenOut is exhausted
    if (remainingTokenOutAmts[j].lte(DUST_AMOUNT)) {
      j++;
    }
  }

  // calculate if any excess collateral was tranched
  let excessCollateral = BigNumber.from("0");
  if (remainingTrancheInAmts[0].gt("0")) {
    const excessTrancheTokens = computeProportionalBalances(remainingTrancheInAmts, trancheRatios);
    excessCollateral = excessTrancheTokens.reduce((m, t) => m.add(t), BigNumber.from("0"));
    try {
      // fails if bond isn't issued
      const depositBondTotalDebt = await depositBond.totalDebt();
      if (depositBondTotalDebt.gt(0)) {
        const bondCollateralBalance = await collateralToken.balanceOf(depositBond.address);
        excessCollateral = excessCollateral.mul(bondCollateralBalance).div(depositBondTotalDebt);
      }
    } catch (e) {}
  }

  return {
    depositBond,
    depositTranches,
    totalRolloverAmt,
    totalRolloverFee,
    remainingTrancheInAmts,
    remainingTokenOutAmts,
    rolloverData,
    collateralUsed,
    excessCollateral,
  };
}

async function computeRolloverBatch(
  hre: HardhatRuntimeEnvironment,
  router: Contract,
  perp: Contract,
  collateralUsed: BigNumber,
): Promise<RolloverBatch> {
  const r = await computeRolloverBatchExact(hre, router, perp, collateralUsed);
  return r.excessCollateral.eq("0")
    ? r
    : computeRolloverBatchExact(hre, router, perp, r.collateralUsed.sub(r.excessCollateral));
}

task("ops:redeemTranches")
  .addParam("bondIssuerAddress", "the address of the bond issuer contract", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre: HardhatRuntimeEnvironment) {
    const { bondIssuerAddress } = args;
    const bondIssuer = await hre.ethers.getContractAt("BondIssuer", bondIssuerAddress);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    // iterate through the bonds
    const issuedCount = await bondIssuer.callStatic.issuedCount();
    for (let i = 0; i < issuedCount; i++) {
      const bondAddress = await bondIssuer.callStatic.issuedBondAt(i);
      const bond = await hre.ethers.getContractAt("IBondController", bondAddress);

      console.log("---------------------------------------------------------------");
      console.log("Processing bond", bondAddress);

      const td = await getTrancheData(hre, bond);
      const isMature = await matureBond(bond, signer);

      if (isMature) {
        for (let j = 0; j < td.length; j++) {
          const b = await td[j][0].balanceOf(signerAddress);
          if (b.gt(0)) {
            console.log("Redeeming mature tranche", td[j][0].address);
            const tx = await bond.connect(signer).redeemMature(td[j][0].address, b);
            await tx.wait();
            console.log("Tx:", tx.hash);
          }
        }
      } else {
        const redemptionAmounts = await computeRedeemableTrancheAmounts(td, signerAddress);
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

task("ops:trancheAndRollover")
  .addParam("perpAddress", "the address of the perp contract", undefined, types.string, false)
  .addParam("routerAddress", "the address of the router contract", undefined, types.string, false)
  .addParam(
    "collateralAmount",
    "the total amount of collateral (in float) to tranche and use for rolling over",
    undefined,
    types.string,
    false,
  )
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { perpAddress, routerAddress, collateralAmount } = args;

    const router = await hre.ethers.getContractAt("RouterV1", routerAddress);
    const perp = await hre.ethers.getContractAt("PerpetualTranche", perpAddress);
    const bondIssuer = await hre.ethers.getContractAt("BondIssuer", await perp.bondIssuer());
    const collateralToken = await hre.ethers.getContractAt("MockERC20", await bondIssuer.collateral());
    const feeToken = await hre.ethers.getContractAt("PerpetualTranche", await perp.feeToken());

    const fixedPtCollateralAmount = utils.parseUnits(collateralAmount, await collateralToken.decimals());
    const { depositBond, totalRolloverFee, rolloverData } = await computeRolloverBatch(
      hre,
      router,
      perp,
      fixedPtCollateralAmount,
    );

    if (rolloverData.length === 0) {
      throw Error("No tokens up for rollover");
    }

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Approving collateralToken to be spent");
    const allowance = await collateralToken.allowance(signerAddress, router.address);
    if (allowance.lt(fixedPtCollateralAmount)) {
      const tx1 = await collateralToken.connect(signer).approve(router.address, fixedPtCollateralAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    let fee = BigNumber.from("0");
    if (totalRolloverFee.gt("0")) {
      fee = totalRolloverFee;
      console.log("Approving fees to be spent:");
      const tx2 = await feeToken.connect(signer).increaseAllowance(router.address, fee);
      await tx2.wait();
      console.log("Tx", tx2.hash);
    }

    // TODO: fee calculation has some rounding issues. Overpaying fixes it for now
    fee = fee.mul("2");

    console.log("Executing rollover:");
    const tx3 = await router.connect(signer).trancheAndRollover(
      perp.address,
      depositBond.address,
      fixedPtCollateralAmount,
      rolloverData.map(r => [r.trancheIn.address, r.tokenOut.address, r.trancheInAmt]),
      fee,
    );
    await tx3.wait();
    console.log("Tx", tx3.hash);
  });

task("ops:preview_tx:trancheAndRollover")
  .addParam("walletAddress", "the address of the wallet with the collateral token", undefined, types.string, false)
  .addParam("perpAddress", "the address of the perp contract", undefined, types.string, false)
  .addParam("routerAddress", "the address of the router contract", undefined, types.string, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { walletAddress, perpAddress, routerAddress } = args;

    const router = await hre.ethers.getContractAt("RouterV1", routerAddress);
    const perp = await hre.ethers.getContractAt("PerpetualTranche", perpAddress);
    const bondIssuer = await hre.ethers.getContractAt("BondIssuer", await perp.bondIssuer());
    const collateralToken = await hre.ethers.getContractAt("MockERC20", await bondIssuer.collateral());

    const maxCollateralAvaiable = await collateralToken.balanceOf(walletAddress);
    const { depositBond, totalRolloverAmt, totalRolloverFee, rolloverData, collateralUsed } =
      await computeRolloverBatch(hre, router, perp, maxCollateralAvaiable);
    const rolloverDataInput = rolloverData.map(r => [
      r.trancheIn.address,
      r.tokenOut.address,
      r.trancheInAmt.toString(),
    ]);

    console.log("---------------------------------------------------------------");
    console.log("Rollover preview");
    console.log("balanceAvailable", utils.formatUnits(maxCollateralAvaiable, await collateralToken.decimals()));
    console.log("collateralUsed", utils.formatUnits(collateralUsed, await collateralToken.decimals()));
    console.log("rolloverAmt", utils.formatUnits(totalRolloverAmt, await perp.decimals()));

    console.log("---------------------------------------------------------------");
    console.log("collateralToken", collateralToken.address);
    console.log("router", router.address);
    console.log("perp", perp.address);
    console.log("depositBond", depositBond.address);
    console.log("collateralAmountFixedPt", collateralUsed.toString());
    console.log("rolloverData", JSON.stringify(rolloverDataInput, null, 2));
    console.log("rolloverFeeFixedPt", totalRolloverFee.toString());

    console.log("---------------------------------------------------------------");
    console.log("Execute the following transactions");

    const tx1: ProposedTransaction = {
      contract: collateralToken,
      method: "approve",
      args: [router.address, collateralUsed.toString()],
    };
    const tx2: ProposedTransaction = {
      contract: router,
      method: "trancheAndRollover",
      args: [
        perp.address,
        depositBond.address,
        collateralUsed.toString(),
        JSON.stringify(rolloverDataInput),
        totalRolloverFee.toString(),
      ],
    };

    console.log({ to: tx1.contract.address, method: tx1.method, args: tx1.args });
    console.log({ to: tx2.contract.address, method: tx2.method, args: tx2.args });

    console.log("Wrote tx batch to file:", "RolloverBatch.json");
    fs.writeFileSync("RolloverBatch.json", JSON.stringify(await generateGnosisSafeBatchFile(hre, [tx1, tx2]), null, 2));
  });
