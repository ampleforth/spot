import { getAdminAddress, getImplementationAddress } from "@openzeppelin/upgrades-core";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { utils, constants, BigNumber } from "ethers";

task("ops:perp:info")
  .addPositionalParam("perpAddress", "the address of the perp contract", undefined, types.string, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { perpAddress } = args;

    const perp = await hre.ethers.getContractAt("PerpetualTranche", perpAddress);
    const perpDecimals = await perp.decimals();

    const bondIssuer = await hre.ethers.getContractAt("BondIssuer", await perp.bondIssuer());
    const latestBond = await hre.ethers.getContractAt("IBondController", await bondIssuer.callStatic.getLatestBond());

    const collateralToken = await hre.ethers.getContractAt("MockERC20", await perp.collateral());
    const feeStrategy = await hre.ethers.getContractAt("BasicFeeStrategy", await perp.feeStrategy());
    const pricingStrategy = await hre.ethers.getContractAt("CDRPricingStrategy", await perp.pricingStrategy());
    const discountStrategy = await hre.ethers.getContractAt(
      "TrancheClassDiscountStrategy",
      await perp.discountStrategy(),
    );
    const depositBond = await hre.ethers.getContractAt("IBondController", await perp.callStatic.getDepositBond());
    const issued = (await hre.ethers.provider.getCode(depositBond.address)) !== "0x";
    const perpSupply = await perp.totalSupply();
    const priceDecimals = await pricingStrategy.decimals();
    const proxyAdminAddress = await getAdminAddress(hre.ethers.provider, perpAddress);
    const implAddress = await getImplementationAddress(hre.ethers.provider, perpAddress);

    console.log("---------------------------------------------------------------");
    console.log("BondIssuer:", bondIssuer.address);
    console.log("bondFactory:", await bondIssuer.bondFactory());
    console.log("collateral:", await bondIssuer.collateral());
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
    console.log("feeStrategy:", feeStrategy.address);
    console.log("owner", await feeStrategy.owner());
    console.log("feeToken", await feeStrategy.feeToken());
    console.log("mintFeePerc:", utils.formatUnits(await feeStrategy.mintFeePerc(), 6));
    console.log("burnFeePerc:", utils.formatUnits(await feeStrategy.burnFeePerc(), 6));
    console.log("rolloverFeePerc:", utils.formatUnits(await feeStrategy.rolloverFeePerc(), 6));

    console.log("---------------------------------------------------------------");
    console.log("discountStrategy:", discountStrategy.address);
    console.log("owner", await discountStrategy.owner());

    console.log("---------------------------------------------------------------");
    console.log("pricingStrategy:", pricingStrategy.address);

    console.log("---------------------------------------------------------------");
    console.log("PerpetualTranche:", perp.address);
    console.log("proxyAdmin:", proxyAdminAddress);
    console.log("implementation:", implAddress);
    console.log("owner:", await perp.owner());
    console.log("keeper:", await perp.keeper());
    console.log("reserve:", await perp.reserve());
    console.log("protocolFeeCollector:", await perp.protocolFeeCollector());
    console.log("paused:", await perp.paused());
    console.log("collateralToken:", collateralToken.address);
    console.log("---------------------------------------------------------------");
    console.log(`maturityTolarance: [${await perp.minTrancheMaturitySec()}, ${await perp.maxTrancheMaturitySec()}]`);
    console.log("maxSupply:", utils.formatUnits(await perp.maxSupply(), await perp.decimals()));
    console.log("maxMintAmtPerTranche:", utils.formatUnits(await perp.maxMintAmtPerTranche(), await perp.decimals()));
    console.log(
      "matureValueTargetPerc:",
      utils.formatUnits(await perp.matureValueTargetPerc(), await perp.PERC_DECIMALS()),
    );
    console.log("---------------------------------------------------------------");
    console.log("depositBond:", depositBond.address);
    console.log("issued:", issued);
    const matureTrancheBalance = await perp.callStatic.getMatureTrancheBalance();
    console.log("MatureTrancheBalance:", utils.formatUnits(matureTrancheBalance, perpDecimals));
    console.log("TotalSupply:", utils.formatUnits(perpSupply, perpDecimals));
    console.log("---------------------------------------------------------------");
    console.log("Reserve:");
    const reserveCount = (await perp.callStatic.getReserveCount()).toNumber();
    const upForRollover = await perp.callStatic.getReserveTokensUpForRollover();
    const perpPrice = await perp.callStatic.getAvgPrice();
    const reserveValue = (await perp.totalSupply()).mul(perpPrice);
    let totalTrancheBalance = BigNumber.from(0);
    const data = [];
    for (let i = 0; i < reserveCount; i++) {
      const tokenAddress = await perp.callStatic.getReserveAt(i);
      const balance = await perp.callStatic.getReserveTrancheBalance(tokenAddress);
      totalTrancheBalance = totalTrancheBalance.add(balance);
      const discountF = await perp.computeDiscount(tokenAddress);
      const price = await perp.computePrice(tokenAddress);
      data.push({
        balance: utils.formatUnits(balance, await perp.decimals()),
        discountFactor: utils.formatUnits(discountF, await discountStrategy.decimals()),
        price: utils.formatUnits(price, priceDecimals),
        upForRollover: upForRollover[i] !== constants.AddressZero && balance.gt(0),
      });
    }
    console.table(data);

    console.log("reserveCount:", reserveCount);
    console.log("reserveValue:", utils.formatUnits(reserveValue, perpDecimals + priceDecimals));
    if (perpSupply.gt("0")) {
      console.log("price:", utils.formatUnits(perpPrice, priceDecimals));
      console.log(
        "impliedPrice:",
        utils.formatUnits(totalTrancheBalance.mul(10 ** priceDecimals).div(perpSupply), priceDecimals),
      );
    }
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

task("ops:updateState")
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

task("ops:trancheAndDeposit")
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

    const router = await hre.ethers.getContractAt("RouterV1", routerAddress);
    const perp = await hre.ethers.getContractAt("PerpetualTranche", perpAddress);
    const bondIssuer = await hre.ethers.getContractAt("BondIssuer", await perp.bondIssuer());
    const collateralToken = await hre.ethers.getContractAt("MockERC20", await bondIssuer.collateral());

    const fixedPtCollateralAmount = utils.parseUnits(collateralAmount, await collateralToken.decimals());
    const [depositBondAddress, trancheAddresses, trancheAmts] = await router.callStatic.previewTranche(
      perp.address,
      fixedPtCollateralAmount,
    );

    console.log("---------------------------------------------------------------");
    console.log("Preview tranche:", collateralAmount);
    for (let i = 0; i < trancheAddresses.length; i++) {
      console.log(
        `tranches(${i}):`,
        trancheAddresses[i],
        utils.formatUnits(trancheAmts[i].toString(), await collateralToken.decimals()),
      );
    }

    console.log("---------------------------------------------------------------");
    console.log("Preview mint:", collateralAmount);
    const feeToken = await hre.ethers.getContractAt("PerpetualTranche", await perp.feeToken());
    let totalMintFee = BigNumber.from("0");
    let totalMintAmt = BigNumber.from("0");
    for (let i = 0; i < trancheAddresses.length; i++) {
      const [mintAmt, , mintFee] = await router.callStatic.previewDeposit(
        perp.address,
        trancheAddresses[i],
        trancheAmts[i],
      );
      totalMintAmt = totalMintAmt.add(mintAmt);
      totalMintFee = totalMintFee.add(mintFee);
    }
    console.log("mintAmt", utils.formatUnits(totalMintAmt, await perp.decimals()));
    console.log("mintFee", utils.formatUnits(totalMintFee, await feeToken.decimals()));

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

    let fee = BigNumber.from("0");
    if (totalMintFee.gt("0") && feeToken.address !== perp.address) {
      fee = totalMintFee;
      console.log("Approving fees to be spent:");
      const tx2 = await feeToken.connect(signer).increaseAllowance(router.address, fee);
      await tx2.wait();
      console.log("Tx", tx2.hash);
    }

    console.log("Tranche and deposit:");
    const tx3 = await router
      .connect(signer)
      .trancheAndDeposit(perp.address, depositBondAddress, fixedPtCollateralAmount, fee);
    await tx3.wait();
    console.log("Tx", tx3.hash);

    console.log("Signer balance", utils.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()));
  });

task("ops:redeem")
  .addParam("perpAddress", "the address of the perp contract", undefined, types.string, false)
  .addParam("routerAddress", "the address of the router contract", undefined, types.string, false)
  .addParam("amount", "the total amount of perp tokens (in float) to redeem", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { perpAddress, routerAddress, amount } = args;

    const router = await hre.ethers.getContractAt("RouterV1", routerAddress);
    const perp = await hre.ethers.getContractAt("PerpetualTranche", perpAddress);
    const feeToken = await hre.ethers.getContractAt("PerpetualTranche", await perp.feeToken());
    const fixedPtAmount = utils.parseUnits(amount, await perp.decimals());

    console.log("---------------------------------------------------------------");
    console.log("Preview redeem:", amount);
    const [reserveTokens, , , burnFee] = await router.callStatic.previewRedeem(perp.address, fixedPtAmount);
    console.log("burnAmt", amount);
    console.log("burnFee", utils.formatUnits(burnFee, await feeToken.decimals()));
    console.log("reserve token redeemed");
    for (let i = 0; i < reserveTokens.length; i++) {
      console.log(`reserve(${i}):`, reserveTokens[i]);
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

    let fee = BigNumber.from("0");
    if (burnFee.gt("0")) {
      fee = burnFee;
      console.log("Approving fees to be spent:");
      const tx2 = await feeToken.connect(signer).increaseAllowance(router.address, fee);
      await tx2.wait();
      console.log("Tx", tx2.hash);
    }

    console.log("Redeem:");
    const tx3 = await perp.connect(signer).redeem(fixedPtAmount);
    await tx3.wait();
    console.log("Tx", tx3.hash);

    console.log("Signer balance", utils.formatUnits(await perp.balanceOf(signerAddress), await perp.decimals()));
  });
