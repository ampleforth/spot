import { getAdminAddress, getImplementationAddress } from "@openzeppelin/upgrades-core";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { utils } from "ethers";

task("ops:perp:info")
  .addPositionalParam("perpAddress", "the address of the perp contract", undefined, types.string, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { perpAddress } = args;

    const perp = await hre.ethers.getContractAt("PerpetualTranche", perpAddress);
    const perpDecimals = await perp.decimals();

    const bondIssuer = await hre.ethers.getContractAt("BondIssuer", await perp.bondIssuer());
    const latestBond = await hre.ethers.getContractAt("IBondController", await bondIssuer.callStatic.getLatestBond());

    const collateralToken = await hre.ethers.getContractAt("MockERC20", await perp.underlying());
    const feePolicy = await hre.ethers.getContractAt("FeePolicy", await perp.feePolicy());
    const depositBond = await hre.ethers.getContractAt("IBondController", await perp.callStatic.getDepositBond());
    const issued = (await hre.ethers.provider.getCode(depositBond.address)) !== "0x";
    const perpSupply = await perp.totalSupply();
    const perpTVL = await perp.callStatic.getTVL();
    const perpPrice = perpSupply.gt("0") ? perpTVL.div(perpSupply) : 0;
    const proxyAdminAddress = await getAdminAddress(hre.ethers.provider, perpAddress);
    const implAddress = await getImplementationAddress(hre.ethers.provider, perpAddress);

    console.log("---------------------------------------------------------------");
    console.log("BondIssuer:", bondIssuer.address);
    console.log("bondFactory:", await bondIssuer.bondFactory());
    console.log("collateral:", await bondIssuer.collateral());
    console.log("issuedCount:", utils.formatUnits(await bondIssuer.issuedCount()), 0);
    console.log("maxMaturityDuration:", utils.formatUnits(await bondIssuer.maxMaturityDuration(), 0));
    console.log("minIssueTimeIntervalSec:", utils.formatUnits(await bondIssuer.minIssueTimeIntervalSec(), 0));
    console.log("issueWindowOffsetSec:", utils.formatUnits(await bondIssuer.issueWindowOffsetSec(), 0));
    let i = 0;
    while (true) {
      try {
        console.log(`trancheRatios(${i}):`, utils.formatUnits(await bondIssuer.trancheRatios(i), 3));
        i++;
      } catch (e) {
        break;
      }
    }
    console.log("lastIssueWindowTimestamp:", utils.formatUnits(await bondIssuer.lastIssueWindowTimestamp(), 0));
    console.log("latestBond:", latestBond.address);

    console.log("---------------------------------------------------------------");
    console.log("feePolicy:", feePolicy.address);
    console.log("owner", await feePolicy.owner());
    console.log("perpMintFeePerc:", utils.formatUnits(await feePolicy.perpMintFeePerc(), 8));
    console.log("perpBurnFeePerc:", utils.formatUnits(await feePolicy.perpBurnFeePerc(), 8));
    const r = await feePolicy.perpRolloverFee();
    console.log("perpRolloverFeeLower:", utils.formatUnits(r.lower, 8));
    console.log("perpRolloverFeeUpper:", utils.formatUnits(r.upper, 8));
    console.log("perpRolloverFeeGrowth:", utils.formatUnits(r.growth, 8));

    console.log("---------------------------------------------------------------");
    console.log("PerpetualTranche:", perp.address);
    console.log("proxyAdmin:", proxyAdminAddress);
    console.log("implementation:", implAddress);
    console.log("owner:", await perp.owner());
    console.log("keeper:", await perp.keeper());
    console.log("paused:", await perp.paused());
    console.log("collateralToken:", collateralToken.address);
    console.log("---------------------------------------------------------------");
    console.log(`maturityTolarance: [${await perp.minTrancheMaturitySec()}, ${await perp.maxTrancheMaturitySec()}]`);
    console.log("maxSupply:", utils.formatUnits(await perp.maxSupply(), await perp.decimals()));
    console.log("maxMintAmtPerTranche:", utils.formatUnits(await perp.maxMintAmtPerTranche(), await perp.decimals()));
    console.log("---------------------------------------------------------------");
    console.log("depositBond:", depositBond.address);
    console.log("issued:", issued);
    console.log("TotalSupply:", utils.formatUnits(perpSupply, perpDecimals));
    console.log("TVL:", utils.formatUnits(perpTVL, perpDecimals));
    console.log("---------------------------------------------------------------");
    console.log("Reserve:");
    const reserveCount = (await perp.callStatic.getReserveCount()).toNumber();
    const upForRollover = await perp.callStatic.getReserveTokensUpForRollover();
    const data = [];
    for (let i = 0; i < reserveCount; i++) {
      const tokenAddress = await perp.callStatic.getReserveAt(i);
      const balance = await perp.callStatic.getReserveTokenBalance(tokenAddress);
      const value = await perp.callStatic.getReserveTokenValue(tokenAddress);
      const price = balance.gt("0") ? value.div(balance) : 0;
      data.push({
        token: tokenAddress,
        balance: utils.formatUnits(balance, await perp.decimals()),
        price: utils.formatUnits(price, 0),
        upForRollover: balance.gt("0") && upForRollover.find(t => t === tokenAddress) !== undefined,
      });
    }
    console.table(data);

    console.log("reserveCount:", reserveCount);
    console.log("price:", utils.formatUnits(perpPrice, 0));
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

    const fixedPtCollateralAmount = utils.parseUnits(collateralAmount, await collateralToken.decimals());
    const [depositBondAddress, depositTranches] = await router.callStatic.previewTranche(
      perp.address,
      fixedPtCollateralAmount,
    );
    console.log(depositBondAddress, depositTranches);

    console.log("---------------------------------------------------------------");
    console.log("Preview tranche:", collateralAmount);
    console.log(
      "tranches(0):",
      depositTranches[0].token,
      utils.formatUnits(depositTranches[0].amount.toString(), await collateralToken.decimals()),
    );
    console.log(
      "tranches(1):",
      depositTranches[1].token,
      utils.formatUnits(depositTranches[1].amount.toString(), await collateralToken.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Preview mint:", collateralAmount);
    const totalMintAmt = await perp.callStatic.computeMintAmt(depositTranches[0].token, depositTranches[0].amount);
    console.log("mintAmt", utils.formatUnits(totalMintAmt, await perp.decimals()));
    if (totalMintAmt.eq("0")) {
      throw Error("No perp minted");
    }

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Approving router to spend tokens:");
    const allowance = await collateralToken.allowance(signerAddress, router.address);
    if (allowance.lt(fixedPtCollateralAmount)) {
      const tx1 = await collateralToken.connect(signer).approve(router.address, fixedPtCollateralAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    console.log("Tranche and deposit:");
    const tx2 = await router
      .connect(signer)
      .trancheAndDeposit(perp.address, depositBondAddress, fixedPtCollateralAmount);
    await tx2.wait();
    console.log("Tx", tx2.hash);

    console.log("Signer balance", utils.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()));
  });

task("ops:perp:redeem")
  .addParam("perpAddress", "the address of the perp contract", undefined, types.string, false)
  .addParam("routerAddress", "the address of the router contract", undefined, types.string, false)
  .addParam("amount", "the total amount of perp tokens (in float) to redeem", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { perpAddress, routerAddress, amount } = args;

    const router = await hre.ethers.getContractAt("RouterV2", routerAddress);
    const perp = await hre.ethers.getContractAt("PerpetualTranche", perpAddress);
    const fixedPtAmount = utils.parseUnits(amount, await perp.decimals());

    console.log("---------------------------------------------------------------");
    console.log("Preview redeem:", amount);
    const reserveTokens = await perp.callStatic.computeRedemptionAmts(fixedPtAmount);
    console.log("burnAmt", amount);
    console.log("reserve token redeemed");
    for (let i = 0; i < reserveTokens.length; i++) {
      console.log(
        `reserve(${i}):`,
        reserveTokens[i].token,
        utils.formatUnits(reserveTokens[i].amount.toString(), await perp.decimals()),
      );
    }

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Approving router to spend tokens:");
    if ((await perp.allowance(signerAddress, router.address)).lt(fixedPtAmount)) {
      const tx1 = await perp.connect(signer).approve(router.address, fixedPtAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    console.log("Redeem:");
    const tx2 = await perp.connect(signer).redeem(fixedPtAmount);
    await tx2.wait();
    console.log("Tx", tx2.hash);

    console.log("Signer balance", utils.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()));
  });
