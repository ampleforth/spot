import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import {
  amplOracleFP,
  usdOracleFP,
  ethOracleFP,
  perpFP,
  percFP,
  priceFP,
  wamplFP,
  amplFP,
  drFP,
  DMock,
} from "./helpers";

const nowTS = () => parseInt(Date.now() / 1000);

describe("SpotPricer", function () {
  async function setupContracts() {
    const amplPolicy = new DMock("IAmpleforth");
    await amplPolicy.deploy();
    await amplPolicy.mockMethod("getTargetRate()", [priceFP("1.15"), true]);

    const ampl = new DMock("UFragments");
    await ampl.deploy();
    await ampl.mockMethod("decimals()", [9]);
    await ampl.mockMethod("monetaryPolicy()", [amplPolicy.target]);

    const usdcPriceOrcle = new DMock("IChainlinkOracle");
    await usdcPriceOrcle.deploy();
    await usdcPriceOrcle.mockMethod("decimals()", [8]);
    await usdcPriceOrcle.mockMethod("latestRoundData()", [
      0,
      usdOracleFP("1"),
      0,
      nowTS(),
      0,
    ]);

    const ethPriceOrcle = new DMock("IChainlinkOracle");
    await ethPriceOrcle.deploy();
    await ethPriceOrcle.mockMethod("decimals()", [18]);
    await ethPriceOrcle.mockMethod("latestRoundData()", [
      0,
      ethOracleFP("2357.76"),
      0,
      nowTS(),
      0,
    ]);

    const usdc = new DMock("contracts/_interfaces/external/IERC20.sol:IERC20");
    await usdc.deploy();

    const wampl = new DMock("IWAMPL");
    await wampl.deploy();
    await wampl.mockCall(
      "wrapperToUnderlying(uint256)",
      [wamplFP("1")],
      [amplFP("7.692284616")],
    );

    const bond = new DMock(
      "contracts/_interfaces/external/IBondController.sol:IBondController",
    );
    await bond.deploy();
    await bond.mockMethod("collateralBalance()", [perpFP("2000")]);

    const tranche = new DMock("Tranche");
    await tranche.deploy();
    await tranche.mockMethod("bond()", [bond.target]);

    const feePolicy = new DMock("IPerpFeePolicy");
    await feePolicy.deploy();
    await feePolicy.mockMethod("decimals()", [8]);
    await feePolicy.mockMethod("deviationRatio()", [drFP("1")]);
    await feePolicy.mockMethod("computePerpRolloverFeePerc(uint256)", [0]);

    const spot = new DMock("PerpetualTranche");
    await spot.deploy();
    await spot.mockMethod("feePolicy()", [feePolicy.target]);
    await spot.mockMethod("underlying()", [ampl.target]);
    await spot.mockMethod("getTVL()", [perpFP("1000")]);
    await spot.mockMethod("totalSupply()", [perpFP("1000")]);
    await spot.mockMethod("getReserveCount()", [2]);
    await spot.mockCall("getReserveAt(uint256)", [0], [ampl.target]);
    await spot.mockCall("getReserveTokenBalance(address)", [ampl.target], ["0"]);
    await spot.mockCall("getReserveAt(uint256)", [1], [tranche.target]);
    await spot.mockCall(
      "getReserveTokenBalance(address)",
      [tranche.target],
      [perpFP("1000")],
    );
    await spot.mockCall(
      "getReserveTokenValue(address)",
      [tranche.target],
      [perpFP("1000")],
    );

    const wamplPool = new DMock("IUniswapV3Pool");
    await wamplPool.deploy();
    await wamplPool.mockMethod("token1()", [wampl.target]);
    await wamplPool.mockMethod("observe(uint32[])", [
      ["376921685400", "377121673968"],
      ["5338479444003340079488911551", "5338479669430834262798687400"],
    ]);

    const spotPool = new DMock("IUniswapV3Pool");
    await spotPool.deploy();
    await spotPool.mockMethod("token0()", [usdc.target]);
    await spotPool.mockMethod("token1()", [spot.target]);
    await spotPool.mockMethod("observe(uint32[])", [
      ["3780978019944", "3781218388344"],
      [
        "15033345577239143106349258268248842184594399522",
        "15033345577239143129748458314415242759127803748",
      ],
    ]);

    const SpotPricer = await ethers.getContractFactory("SpotPricer");
    const strategy = await SpotPricer.deploy(
      wamplPool.target,
      spotPool.target,
      ethPriceOrcle.target,
      usdcPriceOrcle.target,
    );
    return {
      amplPolicy,
      ethPriceOrcle,
      usdcPriceOrcle,
      usdc,
      ampl,
      wampl,
      spot,
      feePolicy,
      bond,
      tranche,
      wamplPool,
      spotPool,
      strategy,
    };
  }

  describe("init", function () {
    it("should initial params", async function () {
      const {
        amplPolicy,
        ethPriceOrcle,
        usdcPriceOrcle,
        usdc,
        ampl,
        wampl,
        spot,
        wamplPool,
        spotPool,
        strategy,
      } = await loadFixture(setupContracts);
      expect(await strategy.WETH_WAMPL_POOL()).to.eq(wamplPool.target);
      expect(await strategy.USDC_SPOT_POOL()).to.eq(spotPool.target);

      expect(await strategy.ETH_ORACLE()).to.eq(ethPriceOrcle.target);
      expect(await strategy.USDC_ORACLE()).to.eq(usdcPriceOrcle.target);
      expect(await strategy.AMPLEFORTH_POLICY()).to.eq(amplPolicy.target);

      expect(await strategy.WAMPL()).to.eq(wampl.target);
      expect(await strategy.USDC()).to.eq(usdc.target);
      expect(await strategy.AMPL()).to.eq(ampl.target);
      expect(await strategy.SPOT()).to.eq(spot.target);
      expect(await strategy.decimals()).to.eq(18);
    });
  });

  describe("#usdPrice", function () {
    describe("when data is stale", function () {
      it("should return invalid", async function () {
        const { strategy, usdcPriceOrcle } = await loadFixture(setupContracts);
        await usdcPriceOrcle.mockMethod("latestRoundData()", [
          0,
          usdOracleFP("1"),
          0,
          nowTS() - 50 * 3600,
          0,
        ]);
        const p = await strategy.usdPrice();
        expect(p[0]).to.eq(amplOracleFP("1"));
        expect(p[1]).to.eq(false);
      });
    });

    describe("when oracle price is below thresh", function () {
      it("should return invalid", async function () {
        const { strategy, usdcPriceOrcle } = await loadFixture(setupContracts);
        await usdcPriceOrcle.mockMethod("latestRoundData()", [
          0,
          usdOracleFP("0.98"),
          0,
          nowTS(),
          0,
        ]);
        const p = await strategy.usdPrice();
        expect(p[0]).to.eq(amplOracleFP("1"));
        expect(p[1]).to.eq(false);
      });
    });

    describe("when oracle price is above thresh", function () {
      it("should return invalid", async function () {
        const { strategy, usdcPriceOrcle } = await loadFixture(setupContracts);
        await usdcPriceOrcle.mockMethod("latestRoundData()", [
          0,
          usdOracleFP("1.02"),
          0,
          nowTS(),
          0,
        ]);
        const p = await strategy.usdPrice();
        expect(p[0]).to.eq(amplOracleFP("1"));
        expect(p[1]).to.eq(false);
      });
    });

    it("should return price", async function () {
      const { strategy } = await loadFixture(setupContracts);
      const p = await strategy.usdPrice();
      expect(p[0]).to.eq(amplOracleFP("1"));
      expect(p[1]).to.eq(true);
    });
  });

  describe("#perpFmvUsdPrice", function () {
    describe("when AMPL target data is invalid", function () {
      it("should return invalid", async function () {
        const { strategy, amplPolicy } = await loadFixture(setupContracts);
        await amplPolicy.mockMethod("getTargetRate()", [amplOracleFP("1.2"), false]);
        const p = await strategy.perpFmvUsdPrice.staticCall();
        expect(p[0]).to.eq(amplOracleFP("1.2"));
        expect(p[1]).to.eq(false);
      });
    });

    it("should return price", async function () {
      const { strategy } = await loadFixture(setupContracts);
      const p = await strategy.perpFmvUsdPrice.staticCall();
      expect(p[0]).to.eq(amplOracleFP("1.15"));
      expect(p[1]).to.eq(true);
    });

    describe("when debasement/enrichment multiplier is not 1", function () {
      it("should return price", async function () {
        const { strategy, spot } = await loadFixture(setupContracts);
        await spot.mockMethod("getTVL()", [perpFP("1500000")]);
        await spot.mockMethod("totalSupply()", [perpFP("1000000")]);
        const p = await strategy.perpFmvUsdPrice.staticCall();
        expect(p[0]).to.eq(amplOracleFP("1.725"));
        expect(p[1]).to.eq(true);
      });
      it("should return price", async function () {
        const { strategy, spot } = await loadFixture(setupContracts);
        await spot.mockMethod("getTVL()", [perpFP("900000")]);
        await spot.mockMethod("totalSupply()", [perpFP("1000000")]);
        const p = await strategy.perpFmvUsdPrice.staticCall();
        expect(p[0]).to.eq(amplOracleFP("1.035"));
        expect(p[1]).to.eq(true);
      });
    });
  });

  describe("#perpUsdPrice", function () {
    describe("when usdc price is invalid", function () {
      it("should return invalid", async function () {
        const { strategy, usdcPriceOrcle } = await loadFixture(setupContracts);
        await usdcPriceOrcle.mockMethod("latestRoundData()", [
          0,
          usdOracleFP("1"),
          0,
          nowTS() - 50 * 3600,
          0,
        ]);
        const p = await strategy.perpUsdPrice.staticCall();
        expect(p[0]).to.eq(priceFP("1.260097503535148000"));
        expect(p[1]).to.eq(false);
      });
    });

    it("should compute spot usd price", async function () {
      const { strategy } = await loadFixture(setupContracts);
      const p = await strategy.perpUsdPrice.staticCall();
      expect(p[0]).to.eq(priceFP("1.260097503535148000"));
      expect(p[1]).to.eq(true);
    });
  });

  describe("#underlyingUsdPrice", function () {
    describe("when eth price is invalid", function () {
      it("should return invalid", async function () {
        const { strategy, ethPriceOrcle } = await loadFixture(setupContracts);
        await ethPriceOrcle.mockMethod("latestRoundData()", [
          0,
          ethOracleFP("3000"),
          0,
          nowTS() - 50 * 3600,
          0,
        ]);
        const p = await strategy.underlyingUsdPrice.staticCall();
        expect(p[0]).to.eq(priceFP("1.508668510241881174"));
        expect(p[1]).to.eq(false);
      });
    });

    it("should compute ampl price", async function () {
      const { strategy } = await loadFixture(setupContracts);
      const p = await strategy.underlyingUsdPrice.staticCall();
      expect(p[0]).to.eq(priceFP("1.185692755569299252"));
      expect(p[1]).to.eq(true);
    });
  });

  describe("intermediate prices", function () {
    it("should compute eth price", async function () {
      const { strategy } = await loadFixture(setupContracts);
      const p = await strategy.ethUsdPrice.staticCall();
      expect(p[0]).to.eq(priceFP("2357.76"));
      expect(p[1]).to.eq(true);
    });

    it("should compute wampl price", async function () {
      const { strategy } = await loadFixture(setupContracts);
      const p = await strategy.wamplUsdPrice.staticCall();
      expect(p[0]).to.eq(priceFP("9.120686142968368965"));
      expect(p[1]).to.eq(true);
    });

    it("should compute spot price deviation", async function () {
      const { strategy } = await loadFixture(setupContracts);
      const p = await strategy.spotPriceDeviation.staticCall();
      expect(p[0]).to.eq(percFP("1.095736959595780869"));
      expect(p[1]).to.eq(true);
    });

    it("should compute spot price deviation", async function () {
      const { strategy, amplPolicy } = await loadFixture(setupContracts);
      await amplPolicy.mockMethod("getTargetRate()", [amplOracleFP("2"), true]);
      const p = await strategy.spotPriceDeviation.staticCall();
      expect(p[0]).to.eq(percFP("0.630048751767574000"));
      expect(p[1]).to.eq(true);
    });

    it("should compute spot price deviation", async function () {
      const { strategy, amplPolicy } = await loadFixture(setupContracts);
      await amplPolicy.mockMethod("getTargetRate()", [amplOracleFP("0"), false]);
      const p = await strategy.spotPriceDeviation.staticCall();
      expect(p[0]).to.eq(percFP("100"));
      expect(p[1]).to.eq(false);
    });

    it("should compute ampl price deviation", async function () {
      const { strategy } = await loadFixture(setupContracts);
      const p = await strategy.amplPriceDeviation.staticCall();
      expect(p[0]).to.eq(percFP("1.031037178755912393"));
      expect(p[1]).to.eq(true);
    });

    it("should compute spot price deviation", async function () {
      const { strategy, amplPolicy } = await loadFixture(setupContracts);
      await amplPolicy.mockMethod("getTargetRate()", [amplOracleFP("1.5"), true]);
      const p = await strategy.amplPriceDeviation.staticCall();
      expect(p[0]).to.eq(percFP("0.790461837046199501"));
      expect(p[1]).to.eq(true);
    });

    it("should compute spot price deviation", async function () {
      const { strategy, amplPolicy } = await loadFixture(setupContracts);
      await amplPolicy.mockMethod("getTargetRate()", [amplOracleFP("0"), false]);
      const p = await strategy.amplPriceDeviation.staticCall();
      expect(p[0]).to.eq(percFP("100"));
      expect(p[1]).to.eq(false);
    });
  });
});
