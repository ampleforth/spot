import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { oracleAnsFP, perpFP, priceFP, DMock } from "./helpers";

const nowTS = () => parseInt(Date.now() / 1000);

describe("SpotCDRPricer", function () {
  async function setupContracts() {
    const accounts = await ethers.getSigners();
    const deployer = accounts[0];

    const amplTargetOracle = new DMock("MedianOracle");
    await amplTargetOracle.deploy();
    await amplTargetOracle.mockMethod("getData()", [priceFP("1.15"), true]);
    await amplTargetOracle.mockMethod("DECIMALS()", [18]);

    const policy = new DMock("UFragmentsPolicy");
    await policy.deploy();
    await policy.mockMethod("cpiOracle()", [amplTargetOracle.target]);

    const ampl = new DMock("UFragments");
    await ampl.deploy();
    await ampl.mockMethod("decimals()", [9]);
    await ampl.mockMethod("monetaryPolicy()", [policy.target]);

    const spot = new DMock("PerpetualTranche");
    await spot.deploy();
    await spot.mockMethod("underlying()", [ampl.target]);
    await spot.mockMethod("getTVL()", [perpFP("1000000")]);
    await spot.mockMethod("totalSupply()", [perpFP("1000000")]);

    const usdPriceOrcle = new DMock("IChainlinkOracle");
    await usdPriceOrcle.deploy();
    await usdPriceOrcle.mockMethod("decimals()", [8]);
    await usdPriceOrcle.mockMethod("latestRoundData()", [
      0,
      oracleAnsFP("1"),
      0,
      nowTS(),
      0,
    ]);

    const SpotCDRPricer = await ethers.getContractFactory("SpotCDRPricer");
    const strategy = await SpotCDRPricer.deploy(
      spot.target,
      usdPriceOrcle.target,
      amplTargetOracle.target,
    );
    return {
      deployer,
      ampl,
      spot,
      usdPriceOrcle,
      amplTargetOracle,
      strategy,
    };
  }

  describe("init", function () {
    it("should initial params", async function () {
      const { strategy, ampl, spot, usdPriceOrcle, amplTargetOracle } = await loadFixture(
        setupContracts,
      );
      expect(await strategy.AMPL()).to.eq(ampl.target);
      expect(await strategy.SPOT()).to.eq(spot.target);
      expect(await strategy.USD_ORACLE()).to.eq(usdPriceOrcle.target);
      expect(await strategy.AMPL_CPI_ORACLE()).to.eq(amplTargetOracle.target);
      expect(await strategy.decimals()).to.eq(18);
    });
  });

  describe("#usdPrice", function () {
    describe("when data is stale", function () {
      it("should return invalid", async function () {
        const { strategy, usdPriceOrcle } = await loadFixture(setupContracts);
        await usdPriceOrcle.mockMethod("latestRoundData()", [
          0,
          oracleAnsFP("1"),
          0,
          nowTS() - 50 * 3600,
          0,
        ]);
        const p = await strategy.usdPrice();
        expect(p[0]).to.eq(priceFP("1"));
        expect(p[1]).to.eq(false);
      });
    });

    describe("when oracle price is below thresh", function () {
      it("should return invalid", async function () {
        const { strategy, usdPriceOrcle } = await loadFixture(setupContracts);
        await usdPriceOrcle.mockMethod("latestRoundData()", [
          0,
          oracleAnsFP("0.98"),
          0,
          nowTS(),
          0,
        ]);
        const p = await strategy.usdPrice();
        expect(p[0]).to.eq(priceFP("1"));
        expect(p[1]).to.eq(false);
      });
    });

    describe("when oracle price is above thresh", function () {
      it("should return invalid", async function () {
        const { strategy, usdPriceOrcle } = await loadFixture(setupContracts);
        await usdPriceOrcle.mockMethod("latestRoundData()", [
          0,
          oracleAnsFP("1.02"),
          0,
          nowTS(),
          0,
        ]);
        const p = await strategy.usdPrice();
        expect(p[0]).to.eq(priceFP("1"));
        expect(p[1]).to.eq(false);
      });
    });

    it("should return price", async function () {
      const { strategy } = await loadFixture(setupContracts);
      const p = await strategy.usdPrice();
      expect(p[0]).to.eq(priceFP("1"));
      expect(p[1]).to.eq(true);
    });
  });

  describe("#perpPrice", function () {
    describe("when AMPL target data is invalid", function () {
      it("should return invalid", async function () {
        const { strategy, amplTargetOracle } = await loadFixture(setupContracts);
        await amplTargetOracle.mockMethod("getData()", [priceFP("1.2"), false]);
        const p = await strategy.perpPrice.staticCall();
        expect(p[0]).to.eq(priceFP("1.2"));
        expect(p[1]).to.eq(false);
      });
    });

    it("should return price", async function () {
      const { strategy } = await loadFixture(setupContracts);
      const p = await strategy.perpPrice.staticCall();
      expect(p[0]).to.eq(priceFP("1.15"));
      expect(p[1]).to.eq(true);
    });

    describe("when debasement/enrichment multiplier is not 1", function () {
      it("should return price", async function () {
        const { strategy, spot } = await loadFixture(setupContracts);
        await spot.mockMethod("getTVL()", [perpFP("1500000")]);
        await spot.mockMethod("totalSupply()", [perpFP("1000000")]);
        const p = await strategy.perpPrice.staticCall();
        expect(p[0]).to.eq(priceFP("1.725"));
        expect(p[1]).to.eq(true);
      });
      it("should return price", async function () {
        const { strategy, spot } = await loadFixture(setupContracts);
        await spot.mockMethod("getTVL()", [perpFP("900000")]);
        await spot.mockMethod("totalSupply()", [perpFP("1000000")]);
        const p = await strategy.perpPrice.staticCall();
        expect(p[0]).to.eq(priceFP("1.035"));
        expect(p[1]).to.eq(true);
      });
    });
  });
});
