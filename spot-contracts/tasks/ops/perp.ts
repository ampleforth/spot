import { getAdminAddress, getImplementationAddress } from "@openzeppelin/upgrades-core";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";

task("ops:perp:info")
  .addPositionalParam("perpAddress", "the address of the perp contract", undefined, types.string, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { perpAddress } = args;

    const perp = await hre.ethers.getContractAt("PerpetualTranche", perpAddress);
    const perpDecimals = await perp.decimals();
    const percDecimals = await perp.PERC_DECIMALS();

    const bondIssuer = await hre.ethers.getContractAt("BondIssuer", await perp.bondIssuer());
    const latestBond = await hre.ethers.getContractAt("IBondController", await bondIssuer.getLatestBond.staticCall());

    const collateralToken = await hre.ethers.getContractAt("MockERC20", await perp.underlying());
    const feePolicy = await hre.ethers.getContractAt("FeePolicy", await perp.feePolicy());
    const depositBond = await hre.ethers.getContractAt("IBondController", await perp.getDepositBond.staticCall());
    const issued = (await hre.ethers.provider.getCode(depositBond.target)) !== "0x";
    const perpSupply = await perp.totalSupply();
    const perpTVL = await perp.getTVL.staticCall();
    const perpPrice = perpSupply > 0n ? (perpTVL * 1000n) / perpSupply : 0;
    const proxyAdminAddress = await getAdminAddress(hre.ethers.provider, perpAddress);
    const implAddress = await getImplementationAddress(hre.ethers.provider, perpAddress);

    console.log("---------------------------------------------------------------");
    console.log("BondIssuer:", bondIssuer.target);
    console.log("bondFactory:", await bondIssuer.bondFactory());
    console.log("collateral:", await bondIssuer.collateral());
    console.log("issuedCount:", hre.ethers.formatUnits(await bondIssuer.issuedCount(), 0));
    console.log("maxMaturityDuration:", hre.ethers.formatUnits(await bondIssuer.maxMaturityDuration(), 0));
    console.log("minIssueTimeIntervalSec:", hre.ethers.formatUnits(await bondIssuer.minIssueTimeIntervalSec(), 0));
    console.log("issueWindowOffsetSec:", hre.ethers.formatUnits(await bondIssuer.issueWindowOffsetSec(), 0));
    let i = 0;
    while (true) {
      try {
        console.log(`trancheRatios(${i}):`, hre.ethers.formatUnits(await bondIssuer.trancheRatios(i), 3));
        i++;
      } catch (e) {
        break;
      }
    }
    console.log("lastIssueWindowTimestamp:", hre.ethers.formatUnits(await bondIssuer.lastIssueWindowTimestamp(), 0));
    console.log("latestBond:", latestBond.target);

    console.log("---------------------------------------------------------------");
    console.log("feePolicy:", feePolicy.target);
    console.log("owner", await feePolicy.owner());
    console.log("---------------------------------------------------------------");
    console.log("PerpetualTranche:", perp.target);
    console.log("proxyAdmin:", proxyAdminAddress);
    console.log("implementation:", implAddress);
    console.log("owner:", await perp.owner());
    console.log("keeper:", await perp.keeper());
    console.log("paused:", await perp.paused());
    console.log("collateralToken:", collateralToken.target);
    console.log("---------------------------------------------------------------");
    console.log(`maturityTolarance: [${await perp.minTrancheMaturitySec()}, ${await perp.maxTrancheMaturitySec()}]`);
    console.log("maxSupply:", hre.ethers.formatUnits(await perp.maxSupply(), await perp.decimals()));
    console.log(
      "maxDepositTrancheValuePerc:",
      hre.ethers.formatUnits(await perp.maxDepositTrancheValuePerc(), percDecimals),
    );
    console.log("---------------------------------------------------------------");
    console.log("depositBond:", depositBond.target);
    console.log("issued:", issued);
    console.log("TotalSupply:", hre.ethers.formatUnits(perpSupply, perpDecimals));
    console.log("TVL:", hre.ethers.formatUnits(perpTVL, perpDecimals));
    console.log("deviationRatio:", hre.ethers.formatUnits(await perp.deviationRatio.staticCall(), percDecimals));
    console.log("---------------------------------------------------------------");
    console.log("Reserve:");
    const reserveCount = await perp.getReserveCount.staticCall();
    const upForRollover = await perp.getReserveTokensUpForRollover.staticCall();
    const data = [];
    for (let i = 0; i < reserveCount; i++) {
      const tokenAddress = await perp.getReserveAt.staticCall(i);
      const balance = await perp.getReserveTokenBalance.staticCall(tokenAddress);
      const value = await perp.getReserveTokenValue.staticCall(tokenAddress);
      const price = balance > 0n ? (value * 1000n) / balance : 0n;
      data.push({
        token: tokenAddress,
        balance: hre.ethers.formatUnits(balance, await perp.decimals()),
        price: hre.ethers.formatUnits(price, 3),
        upForRollover: balance > 0n && upForRollover.find(t => t === tokenAddress) !== undefined,
      });
    }
    console.table(data);

    console.log("reserveCount:", reserveCount);
    console.log("price:", hre.ethers.formatUnits(perpPrice, 3));
    console.log("---------------------------------------------------------------");
  });

task("ops:perp:updateKeeper", "Updates the keeper address of perpetual tranche")
  .addParam("address", "the perpetual tranche contract address", undefined, types.string, false)
  .addParam("newKeeperAddress", "the address of the new keeper", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { address, newKeeperAddress } = args;
    const perp = await hre.ethers.getContractAt("PerpetualTranche", address);

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log(`Updating keeper to ${newKeeperAddress}`);
    const tx = await perp.updateKeeper(newKeeperAddress);
    console.log(tx.hash);
    await tx.wait();
  });

task("ops:perp:updateTolerableTrancheMaturity", "Updates the tolerable maturity params of perpetual tranche")
  .addParam("address", "the perpetual tranche contract address", undefined, types.string, false)
  .addParam("minimum", "the new minimum tolerable tranche maturity", undefined, types.int, false)
  .addParam("maximum", "the new maximum tolerable tranche maturity", undefined, types.int, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { address, minimum, maximum } = args;
    const signer = (await hre.ethers.getSigners())[0];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);
    const perp = await hre.ethers.getContractAt("PerpetualTranche", address);
    console.log(`Updating tolerable tranche maturity range to ${minimum}, ${maximum}`);
    const tx = await perp.updateTolerableTrancheMaturity(minimum, maximum);
    console.log(tx.hash);
    await tx.wait();
  });

task("ops:perp:pause", "Pauses operations on the perpetual tranche contract")
  .addParam("address", "the perpetual tranche contract address", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { address } = args;
    const perp = await hre.ethers.getContractAt("PerpetualTranche", address);

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log(`Pausing`);
    const tx = await perp.pause();
    console.log(tx.hash);
    await tx.wait();
  });

task("ops:perp:updateState")
  .addPositionalParam("perpAddress", "the address of the perp contract", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { perpAddress } = args;

    const perp = await hre.ethers.getContractAt("PerpetualTranche", perpAddress);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Update state:");
    const tx = await perp.connect(signer).updateState();
    await tx.wait();
    console.log("Tx", tx.hash);
  });

task("ops:perp:trancheAndDeposit")
  .addParam("perpAddress", "the address of the perp contract", undefined, types.string, false)
  .addParam("routerAddress", "the address of the router contract", undefined, types.string, false)
  .addParam(
    "collateralAmount",
    "the total amount of collateral (in float) to tranche and deposit to mint perps",
    undefined,
    types.string,
    false,
  )
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { perpAddress, routerAddress, collateralAmount } = args;

    const router = await hre.ethers.getContractAt("RouterV2", routerAddress);
    const perp = await hre.ethers.getContractAt("PerpetualTranche", perpAddress);
    const bondIssuer = await hre.ethers.getContractAt("BondIssuer", await perp.bondIssuer());
    const collateralToken = await hre.ethers.getContractAt("MockERC20", await bondIssuer.collateral());

    const fixedPtCollateralAmount = hre.ethers.parseUnits(collateralAmount, await collateralToken.decimals());
    const [depositBondAddress, depositTranches] = await router.previewTranche.staticCall(
      perp.target,
      fixedPtCollateralAmount,
    );
    console.log(depositBondAddress, depositTranches);

    console.log("---------------------------------------------------------------");
    console.log("Preview tranche:", collateralAmount);
    console.log(
      "tranches(0):",
      depositTranches[0].token,
      hre.ethers.formatUnits(depositTranches[0].amount.toString(), await collateralToken.decimals()),
    );
    console.log(
      "tranches(1):",
      depositTranches[1].token,
      hre.ethers.formatUnits(depositTranches[1].amount.toString(), await collateralToken.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Preview mint:", collateralAmount);
    const totalMintAmt = await perp.computeMintAmt.staticCall(depositTranches[0].token, depositTranches[0].amount);
    console.log("mintAmt", hre.ethers.formatUnits(totalMintAmt, await perp.decimals()));
    if (totalMintAmt <= 0n) {
      throw Error("No perp minted");
    }

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Approving router to spend tokens:");
    const allowance = await collateralToken.allowance(signerAddress, router.target);
    if (allowance < fixedPtCollateralAmount) {
      const tx1 = await collateralToken.connect(signer).approve(router.target, fixedPtCollateralAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    console.log("Tranche and deposit:");
    const tx2 = await router
      .connect(signer)
      .trancheAndDeposit(perp.target, depositBondAddress, fixedPtCollateralAmount);
    await tx2.wait();
    console.log("Tx", tx2.hash);

    console.log("Signer balance", hre.ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()));
  });

task("ops:perp:redeem")
  .addParam("perpAddress", "the address of the perp contract", undefined, types.string, false)
  .addParam("amount", "the total amount of perp tokens (in float) to redeem", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { perpAddress, amount } = args;

    const perp = await hre.ethers.getContractAt("PerpetualTranche", perpAddress);
    const fixedPtAmount = hre.ethers.parseUnits(amount, await perp.decimals());

    console.log("---------------------------------------------------------------");
    console.log("Preview redeem:", amount);
    const reserveTokens = await perp.computeRedemptionAmts.staticCall(fixedPtAmount);
    console.log("burnAmt", amount);
    console.log("reserve token redeemed");
    for (let i = 0; i < reserveTokens.length; i++) {
      console.log(
        `reserve(${i}):`,
        reserveTokens[i].token,
        hre.ethers.formatUnits(reserveTokens[i].amount.toString(), await perp.decimals()),
      );
    }

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Redeem:");
    const tx = await perp.connect(signer).redeem(fixedPtAmount);
    await tx.wait();
    console.log("Tx", tx.hash);

    console.log("Signer balance", hre.ethers.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()));
  });
