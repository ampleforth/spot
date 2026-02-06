import { getAdminAddress, getImplementationAddress } from "@openzeppelin/upgrades-core";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { ethers } from "ethers";

function pp(val, decimals) {
  return parseFloat(ethers.formatUnits(val, decimals));
}

task("info:MetaOracle")
  .addPositionalParam(
    "address",
    "the address of the meta oracle contract",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const { address } = args;

    const oracle = await hre.ethers.getContractAt("IMetaOracle", address);
    const oracleDecimals = await oracle.decimals();
    console.log("---------------------------------------------------------------");
    console.log("MetaOracle:", oracle.target);

    console.log("---------------------------------------------------------------");
    const usdcPriceData = await oracle.usdcPrice.staticCall();
    console.log("usdcPrice:", pp(usdcPriceData[0], oracleDecimals));

    const ethPriceData = await oracle.ethUsdPrice.staticCall();
    console.log("ethPrice:", pp(ethPriceData[0], oracleDecimals));

    const wamplPriceData = await oracle.wamplUsdPrice.staticCall();
    console.log("wamplPrice:", pp(wamplPriceData[0], oracleDecimals));

    console.log("---------------------------------------------------------------");

    const amplPriceData = await oracle.amplUsdPrice.staticCall();
    console.log("amplPrice:", pp(amplPriceData[0], oracleDecimals));

    const amplTargetPriceData = await oracle.amplTargetUsdPrice.staticCall();
    console.log("amplTargetPrice:", pp(amplTargetPriceData[0], oracleDecimals));

    const amplDeviationData = await oracle.amplPriceDeviation.staticCall();
    console.log("amplDeviation:", pp(amplDeviationData[0], oracleDecimals));

    console.log("---------------------------------------------------------------");

    const spotPriceData = await oracle.spotUsdPrice.staticCall();
    console.log("spotPrice:", pp(spotPriceData[0], oracleDecimals));

    const spotFmvPriceData = await oracle.spotFmvUsdPrice.staticCall();
    console.log("spotFmvPrice:", pp(spotFmvPriceData[0], oracleDecimals));

    const spotDeviationData = await oracle.spotPriceDeviation.staticCall();
    console.log("spotDeviation:", pp(spotDeviationData[0], oracleDecimals));

    console.log("---------------------------------------------------------------");

    const spotDeviation = pp(spotDeviationData[0], oracleDecimals);
    const amplDeviation = pp(amplDeviationData[0], oracleDecimals);
    const relativeDeviation = spotDeviation / amplDeviation;

    console.log("relativeDeviation:", relativeDeviation);
    console.log("noArbZone:", relativeDeviation > 0.9 && relativeDeviation < 1.025);
    console.log("flashMintZone:", relativeDeviation >= 1.025);
    console.log("flashRedeemZone:", relativeDeviation <= 0.9);

    console.log("---------------------------------------------------------------");
  });

task("info:BillBroker")
  .addPositionalParam(
    "address",
    "the address of the bill broker contract",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const { address } = args;

    const billBroker = await hre.ethers.getContractAt("BillBroker", address);
    const billBrokerDecimals = await billBroker.decimals();
    const proxyAdminAddress = await getAdminAddress(hre.ethers.provider, address);
    const implAddress = await getImplementationAddress(hre.ethers.provider, address);

    const usd = await hre.ethers.getContractAt("ERC20", await billBroker.usd());
    const usdDecimals = await usd.decimals();
    const perp = await hre.ethers.getContractAt("ERC20", await billBroker.perp());
    const perpDecimals = await perp.decimals();

    const unitUsd = await billBroker.usdUnitAmt();
    const unitPerp = await billBroker.perpUnitAmt();

    const oracle = await hre.ethers.getContractAt(
      "SpotPricer",
      await billBroker.oracle.staticCall(),
      // "0x0f8f519878c10ce36C6aAF89c1AeefaaDE5D7881",
    );
    const oracleDecimals = await oracle.decimals();
    console.log("---------------------------------------------------------------");
    console.log("oracle:", oracle.target);
    const usdPriceCall = await oracle.usdPrice.staticCall();
    console.log("usdPrice:", pp(usdPriceCall[0], oracleDecimals));
    console.log("usdPriceValid:", usdPriceCall[1]);
    const perpPriceCall = await oracle.perpFmvUsdPrice.staticCall();
    console.log("perpPrice:", pp(perpPriceCall[0], oracleDecimals));
    console.log("perpPriceValid:", perpPriceCall[1]);
    console.log("---------------------------------------------------------------");
    console.log("BillBroker:", billBroker.target);
    console.log("owner:", await billBroker.owner());
    console.log("keeper:", await billBroker.keeper());
    console.log("proxyAdmin:", proxyAdminAddress);
    console.log("implementation:", implAddress);
    console.log("paused:", await billBroker.paused());
    const fees = await billBroker.fees.staticCall();
    console.log("Fees:");
    console.table([
      ["mintFeePerc", pp(fees[0], billBrokerDecimals)],
      ["burnFeePerc", pp(fees[1], billBrokerDecimals)],
      ["perpToUsdSwapFeeLowerPerc", pp(fees[2][0], billBrokerDecimals)],
      ["perpToUsdSwapFeeUpperPerc", pp(fees[2][1], billBrokerDecimals)],
      ["usdToPerpSwapFeeLowerPerc", pp(fees[3][0], billBrokerDecimals)],
      ["usdToPerpSwapFeeUpperPerc", pp(fees[3][1], billBrokerDecimals)],
      ["protocolSwapSharePerc", pp(fees[4], billBrokerDecimals)],
    ]);

    console.log("ARBounds:");
    const arSoft = await billBroker.arSoftBound.staticCall();
    const arHard = await billBroker.arHardBound.staticCall();
    console.table([
      ["softLower", pp(arSoft[0], billBrokerDecimals)],
      ["softUpper", pp(arSoft[1], billBrokerDecimals)],
      ["hardLower", pp(arHard[0], billBrokerDecimals)],
      ["hardUpper", pp(arHard[1], billBrokerDecimals)],
    ]);

    try {
      console.log("ReserveState:");
      const r = await billBroker.reserveState.staticCall();
      console.table([
        ["usdBalance", pp(r[0], usdDecimals)],
        ["perpBalance", pp(r[1], perpDecimals)],
        ["usdPrice", pp(r[2], billBrokerDecimals)],
        ["perpPrice", pp(r[3], billBrokerDecimals)],
      ]);
      const assetRatio = await billBroker.assetRatio({
        usdBalance: r[0],
        perpBalance: r[1],
        usdPrice: r[2],
        perpPrice: r[3],
      });
      console.log("assetRatio", pp(assetRatio, billBrokerDecimals));

      const tvl =
        pp(r[0], usdDecimals) * pp(r[2], billBrokerDecimals) +
        pp(r[1], perpDecimals) * pp(r[3], billBrokerDecimals);
      console.log("tvl", tvl);

      console.log("---------------------------------------------------------------");
      const swapAmts = [1n, 1000n, 10000n, 15000n, 20000n, 25000n];
      for (let i = 0; i < swapAmts.length; i++) {
        const swapAmt = swapAmts[i];
        console.log(
          `Buy price for ${swapAmt} perp: `,
          pp(
            await billBroker["computePerpToUSDSwapAmt(uint256)"].staticCall(
              unitPerp * swapAmt,
            ),
            usdDecimals,
          ) / parseFloat(swapAmt),
          `usd per perp`,
        );
        console.log(
          `~Sell price for ${swapAmt} perp: `,
          parseFloat(swapAmt) /
            pp(
              await billBroker["computeUSDToPerpSwapAmt(uint256)"].staticCall(
                unitUsd * swapAmt,
              ),
              perpDecimals,
            ),
          `usd per perp`,
        );
      }
      console.log("---------------------------------------------------------------");
    } catch (e) {
      // console.log(e);
      console.log("---------------------------------------------------------------");
    }
  });

task("info:DRBalancerVault")
  .addPositionalParam(
    "address",
    "the address of the DR balancer vault contract",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const { address } = args;

    const vault = await hre.ethers.getContractAt("DRBalancerVault", address);
    const vaultDecimals = await vault.DECIMALS();
    const drDecimals = await vault.DR_DECIMALS();
    const proxyAdminAddress = await getAdminAddress(hre.ethers.provider, address);
    const implAddress = await getImplementationAddress(hre.ethers.provider, address);

    const underlying = await hre.ethers.getContractAt("ERC20", await vault.underlying());
    const underlyingDecimals = await underlying.decimals();
    const perp = await hre.ethers.getContractAt("ERC20", await vault.perp());
    const perpDecimals = await perp.decimals();
    const stampl = await vault.stampl();

    console.log("---------------------------------------------------------------");
    console.log("DRBalancerVault:", vault.target);
    console.log("owner:", await vault.owner());
    console.log("keeper:", await vault.keeper());
    console.log("proxyAdmin:", proxyAdminAddress);
    console.log("implementation:", implAddress);
    console.log("paused:", await vault.paused());

    console.log("---------------------------------------------------------------");
    console.log("Tokens:");
    console.log("underlying:", underlying.target, `(${await underlying.symbol()})`);
    console.log("perp:", perp.target, `(${await perp.symbol()})`);
    console.log("stampl:", stampl);

    console.log("---------------------------------------------------------------");
    console.log("Configuration:");
    const targetDR = await vault.targetDR();
    const equilibriumDR = await vault.equilibriumDR();
    console.table([
      ["targetDR", pp(targetDR, drDecimals)],
      ["equilibriumDR.lower", pp(equilibriumDR[0], drDecimals)],
      ["equilibriumDR.upper", pp(equilibriumDR[1], drDecimals)],
      ["lagFactorUnderlyingToPerp", (await vault.lagFactorUnderlyingToPerp()).toString()],
      ["lagFactorPerpToUnderlying", (await vault.lagFactorPerpToUnderlying()).toString()],
      ["minRebalanceVal", pp(await vault.minRebalanceVal(), underlyingDecimals)],
      ["rebalanceFreqSec", (await vault.rebalanceFreqSec()).toString()],
      ["maxSwapFeePerc", pp(await vault.maxSwapFeePerc(), vaultDecimals)],
    ]);

    console.log("---------------------------------------------------------------");
    console.log("State:");
    const underlyingBal = await vault.underlyingBalance();
    const perpBal = await vault.perpBalance();
    const totalSupply = await vault.totalSupply();
    const lastRebalance = await vault.lastRebalanceTimestampSec();
    const lastRebalanceDate =
      lastRebalance > 0 ? new Date(Number(lastRebalance) * 1000).toISOString() : "never";

    console.table([
      ["underlyingBalance", pp(underlyingBal, underlyingDecimals)],
      ["perpBalance", pp(perpBal, perpDecimals)],
      ["totalSupply (notes)", pp(totalSupply, vaultDecimals)],
      ["lastRebalanceTimestampSec", lastRebalance.toString()],
      ["lastRebalanceDate", lastRebalanceDate],
    ]);

    try {
      const tvl = await vault.getTVL.staticCall();
      console.log("TVL (underlying denomination):", pp(tvl, underlyingDecimals));

      const stamplContract = await hre.ethers.getContractAt("IRolloverVault", stampl);
      const currentDR = await stamplContract.deviationRatio.staticCall();
      console.log("Current system DR:", pp(currentDR, drDecimals));

      const [rebalanceAmt, isUnderlyingIntoPerp] =
        await vault.computeRebalanceAmount.staticCall();
      console.log("---------------------------------------------------------------");
      console.log("Rebalance Preview:");
      console.log("rebalanceAmount:", pp(rebalanceAmt, underlyingDecimals));
      console.log(
        "direction:",
        isUnderlyingIntoPerp
          ? "underlying -> perp (mint)"
          : "perp -> underlying (redeem)",
      );

      // Check if rebalance is pokable
      console.log("---------------------------------------------------------------");
      console.log("Rebalance Pokability:");

      const currentTimestamp = Math.floor(Date.now() / 1000);
      const rebalanceFreq = Number(await vault.rebalanceFreqSec());
      const nextRebalanceTimestamp = Number(lastRebalance) + rebalanceFreq;
      const timeElapsed = currentTimestamp >= nextRebalanceTimestamp;
      const secondsUntilPokable = timeElapsed
        ? 0
        : nextRebalanceTimestamp - currentTimestamp;

      const equilibriumDR = await vault.equilibriumDR();
      const inEquilibriumZone =
        currentDR >= equilibriumDR[0] && currentDR <= equilibriumDR[1];

      console.table([
        ["timeElapsed", timeElapsed],
        ["secondsUntilPokable", secondsUntilPokable],
        ["inEquilibriumZone", inEquilibriumZone],
        ["hasRebalanceAmount", rebalanceAmt > 0n],
      ]);

      // Try static call to see if rebalance would succeed
      let rebalanceExecutable = false;
      try {
        await vault.rebalance.staticCall();
        rebalanceExecutable = true;
      } catch (e) {
        // rebalance not executable
      }
      console.log("rebalanceExecutable:", rebalanceExecutable);
    } catch (e) {
      console.log(e);
      console.log("Unable to fetch dynamic state (TVL/DR/rebalance)");
    }

    console.log("---------------------------------------------------------------");
  });

task("info:WethWamplManager")
  .addPositionalParam(
    "address",
    "the address of the weth-wampl mananger contract",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const { address } = args;

    const manager = await hre.ethers.getContractAt("WethWamplManager", address);
    const oracle = await hre.ethers.getContractAt("IMetaOracle", await manager.oracle());
    const managerDecimals = await manager.decimals();
    console.log("---------------------------------------------------------------");
    console.log("WethWamplManager:", manager.target);
    console.log("owner:", await manager.owner());
    console.log("oracle:", oracle.target);

    console.log("---------------------------------------------------------------");
    const r = await oracle.amplPriceDeviation.staticCall();
    const deviation = r[0];
    console.log("dataValid:", r[1]);
    console.log("isOverweightWampl:", await manager.isOverweightWampl());
    console.log("prevDeviation:", pp(await manager.prevDeviation(), managerDecimals));
    console.log("deviation:", pp(deviation, managerDecimals));
    console.log(
      "activeLiqPerc:",
      pp(await manager.computeActiveLiqPerc(deviation), managerDecimals),
    );

    let rebalanceActive = true;
    try {
      await manager.rebalance.staticCall();
    } catch (e) {
      rebalanceActive = false;
    }
    console.log("rebalanceActive:", rebalanceActive);
    console.log("---------------------------------------------------------------");
  });

task("info:UsdcSpotManager")
  .addPositionalParam(
    "address",
    "the address of the usdc-spot mananger contract",
    undefined,
    types.string,
    false,
  )
  .setAction(async function (args: TaskArguments, hre) {
    const { address } = args;

    const manager = await hre.ethers.getContractAt("UsdcSpotManager", address);
    const oracle = await hre.ethers.getContractAt("IMetaOracle", await manager.oracle());
    const managerDecimals = await manager.decimals();
    console.log("---------------------------------------------------------------");
    console.log("UsdcSpotManager:", manager.target);
    console.log("owner:", await manager.owner());
    console.log("oracle:", oracle.target);

    console.log("---------------------------------------------------------------");
    const r = await oracle.spotPriceDeviation.staticCall();
    const deviation = r[0];
    console.log("dataValid:", r[1]);
    console.log("isOverweightSpot:", await manager.isOverweightSpot());
    console.log("prevWithinActiveZone:", await manager.prevWithinActiveZone());
    console.log("withinActiveZone:", await manager.activeZone(deviation));
    console.log("deviation:", pp(deviation, managerDecimals));
    console.log(
      "fullRangePerc:",
      pp(await manager.activeFullRangePerc(), managerDecimals),
    );
    let rebalanceActive = true;
    try {
      await manager.rebalance.staticCall();
    } catch (e) {
      rebalanceActive = false;
    }
    console.log("rebalanceActive:", rebalanceActive);
    console.log("---------------------------------------------------------------");
  });
