import { getAdminAddress, getImplementationAddress } from "@openzeppelin/upgrades-core";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { ethers } from "ethers";

function pp(val, decimals) {
  return parseFloat(ethers.formatUnits(val, decimals));
}

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

    const spotAppraiser = await hre.ethers.getContractAt(
      "SpotAppraiser",
      await billBroker.pricingStrategy.staticCall(),
    );
    const appraiserDecimals = await spotAppraiser.decimals();
    console.log("---------------------------------------------------------------");
    console.log("SpotAppraiser:", spotAppraiser.target);
    console.log("owner:", await spotAppraiser.owner());
    const usdPriceCall = await spotAppraiser.usdPrice.staticCall();
    console.log("usdPrice:", pp(usdPriceCall[0], appraiserDecimals));
    console.log("usdPriceValid:", usdPriceCall[1]);
    const perpPriceCall = await spotAppraiser.perpPrice.staticCall();
    console.log("perpPrice:", pp(perpPriceCall[0], appraiserDecimals));
    console.log("perpPriceValid:", perpPriceCall[1]);
    console.log("isSpotHealthy:", await spotAppraiser.isSPOTHealthy.staticCall());
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
      const swapAmts = [1n, 1000n, 10000n, 25000n, 50000n, 100000n];
      for (let i = 0; i < swapAmts.length; i++) {
        const swapAmt = swapAmts[i];
        console.log(
          `Buy price for ${swapAmt} perp: `,
          pp(
            await billBroker["computePerpToUSDSwapAmt(uint256)"].staticCall(
              unitPerp * swapAmt,
            ),
            usdDecimals,
          ) / parseInt(swapAmt),
          `usd per perp`,
        );
        console.log(
          `~Sell price for ${swapAmt} perp: `,
          parseInt(swapAmt) /
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
      console.log(e);
      console.log("ReserveState: NA");
      console.log("---------------------------------------------------------------");
    }
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
    const managerDecimals = await manager.decimals();
    console.log("---------------------------------------------------------------");
    console.log("WethWamplManager:", manager.target);
    console.log("owner:", await manager.owner());
    console.log("cpiOracle:", await manager.cpiOracle());
    console.log("ethOracle:", await manager.ethOracle());

    console.log("---------------------------------------------------------------");
    const ethPriceData = await manager.getEthUSDPrice();
    console.log("ethPrice:", pp(ethPriceData[0], managerDecimals));

    const wamplPrice = await manager.getWamplUSDPrice(ethPriceData[0]);
    console.log("wamplPrice:", pp(wamplPrice, managerDecimals));

    const amplPrice = await manager.getAmplUSDPrice(ethPriceData[0]);
    console.log("amplPrice:", pp(amplPrice, managerDecimals));

    const r = await manager.computeDeviationFactor.staticCall();
    const deviation = r[0];
    console.log("dataValid:", r[1]);
    console.log("isOverweightWampl:", await manager.isOverweightWampl());
    console.log("prevDeviation:", pp(await manager.prevDeviation(), managerDecimals));
    console.log("amplDeviation:", pp(deviation, managerDecimals));
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
