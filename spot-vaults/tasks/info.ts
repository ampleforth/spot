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
    const usdPriceCall = await spotAppraiser.usdPrice.staticCall();
    const perpPriceCall = await spotAppraiser.perpPrice.staticCall();
    console.log("usdPrice:", pp(usdPriceCall[0], appraiserDecimals));
    console.log("usdPriceValid:", usdPriceCall[1]);
    console.log("perpPrice:", pp(perpPriceCall[0], appraiserDecimals));
    console.log("perpPriceValid:", perpPriceCall[1]);
    console.log("isSpotHealthy:", await spotAppraiser.isSPOTHealthy.staticCall());
    console.log("---------------------------------------------------------------");
    console.log("BillBroker:", billBroker.target);

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

      const swapAmt = 100n;
      console.log(
        `Quote for ${swapAmt} perp: `,
        pp(
          await billBroker["computePerpToUSDSwapAmt(uint256)"].staticCall(
            unitPerp * swapAmt,
          ),
          usdDecimals,
        ),
      );
      console.log(
        `Quote for ${swapAmt} usd: `,
        pp(
          await billBroker["computeUSDToPerpSwapAmt(uint256)"].staticCall(
            unitUsd * swapAmt,
          ),
          perpDecimals,
        ),
      );
    } catch (e) {
      console.log(e);
      console.log("ReserveState: NA");
    }
    console.log("---------------------------------------------------------------");
  });
