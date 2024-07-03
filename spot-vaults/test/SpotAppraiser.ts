import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { oracleAnsFP, perpFP, percentageFP, priceFP, DMock } from "./helpers";

const nowTS = () => parseInt(Date.now() / 1000);

describe("SpotAppraiser", function () {
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

    const bond = new DMock("BondController");
    await bond.deploy();
    await bond.mockMethod("isMature()", [false]);
    await bond.mockMethod("trancheCount()", [2]);
    await bond.mockMethod("totalDebt()", [perpFP("500000")]);
    await ampl.mockCall("balanceOf(address)", [bond.target], [perpFP("500000")]);

    const tranche = new DMock("Tranche");
    await tranche.deploy();
    await tranche.mockMethod("bond()", [bond.target]);
    await tranche.mockMethod("totalSupply()", [perpFP("100000")]);
    await bond.mockCall("tranches(uint256)", [0], [tranche.target, 200]);
    await bond.mockCall("tranches(uint256)", [1], [ethers.ZeroAddress, 800]);

    const spot = new DMock("PerpetualTranche");
    await spot.deploy();
    await spot.mockMethod("underlying()", [ampl.target]);
    await spot.mockMethod("getTVL()", [perpFP("1000000")]);
    await spot.mockMethod("totalSupply()", [perpFP("1000000")]);
    await spot.mockMethod("deviationRatio()", [oracleAnsFP("1.5")]);
    await spot.mockMethod("getReserveCount()", [2]);
    await spot.mockCall("getReserveAt(uint256)", [0], [ampl.target]);
    await spot.mockCall("getReserveAt(uint256)", [1], [tranche.target]);
    await ampl.mockCall("balanceOf(address)", [spot.target], [perpFP("1000")]);

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

    const SpotAppraiser = await ethers.getContractFactory("SpotAppraiser");
    const strategy = await SpotAppraiser.deploy(
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
      bond,
      tranche,
      strategy,
    };
  }

  describe("init", function () {
    it("should initial params", async function () {
      const { deployer, strategy, ampl, spot, usdPriceOrcle, amplTargetOracle } =
        await loadFixture(setupContracts);
      expect(await strategy.AMPL()).to.eq(ampl.target);
      expect(await strategy.SPOT()).to.eq(spot.target);
      expect(await strategy.USD_ORACLE()).to.eq(usdPriceOrcle.target);
      expect(await strategy.AMPL_CPI_ORACLE()).to.eq(amplTargetOracle.target);
      expect(await strategy.AMPL_DUST_AMT()).to.eq(perpFP("25000"));
      expect(await strategy.minSPOTDR()).to.eq(percentageFP("0.8"));
      expect(await strategy.minSeniorCDR()).to.eq(percentageFP("1.1"));
      expect(await strategy.owner()).to.eq(await deployer.getAddress());
      expect(await strategy.decimals()).to.eq(18);
    });
  });

  describe("#updateMinSPOTDR", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { strategy } = await loadFixture(setupContracts);
        await strategy.renounceOwnership();
        await expect(strategy.updateMinSPOTDR(percentageFP("1.15"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when triggered by owner", function () {
      it("should update value", async function () {
        const { strategy } = await loadFixture(setupContracts);
        await strategy.updateMinSPOTDR(percentageFP("1.15"));
        expect(await strategy.minSPOTDR()).to.eq(percentageFP("1.15"));
      });
    });
  });

  describe("#updateMinPerpCollateralCDR", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { strategy } = await loadFixture(setupContracts);
        await strategy.renounceOwnership();
        await expect(
          strategy.updateMinPerpCollateralCDR(percentageFP("1.25")),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when cdr is invalid", function () {
      it("should revert", async function () {
        const { strategy } = await loadFixture(setupContracts);
        await expect(
          strategy.updateMinPerpCollateralCDR(percentageFP("0.9")),
        ).to.be.revertedWithCustomError(strategy, "InvalidSeniorCDRBound");
      });
    });

    describe("when triggered by owner", function () {
      it("should update value", async function () {
        const { strategy } = await loadFixture(setupContracts);
        await strategy.updateMinPerpCollateralCDR(percentageFP("1.25"));
        expect(await strategy.minSeniorCDR()).to.eq(percentageFP("1.25"));
      });
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

    describe("when balancer DR is too low", function () {
      it("should return invalid", async function () {
        const { strategy, spot } = await loadFixture(setupContracts);
        await spot.mockMethod("deviationRatio()", [oracleAnsFP("0.79999")]);
        const p = await strategy.perpPrice.staticCall();
        expect(p[0]).to.eq(priceFP("1.15"));
        expect(p[1]).to.eq(false);
      });
    });

    describe("when spot senior cdr is too low", function () {
      it("should return invalid", async function () {
        const { strategy, ampl, bond } = await loadFixture(setupContracts);
        await ampl.mockCall("balanceOf(address)", [bond.target], [perpFP("109999")]);
        const p = await strategy.perpPrice.staticCall();
        expect(p[0]).to.eq(priceFP("1.15"));
        expect(p[1]).to.eq(false);
      });
      it("should return invalid", async function () {
        const { strategy, bond } = await loadFixture(setupContracts);
        await bond.mockMethod("isMature()", [true]);
        const p = await strategy.perpPrice.staticCall();
        expect(p[0]).to.eq(priceFP("1.15"));
        expect(p[1]).to.eq(false);
      });
    });

    describe("when spot has mature AMPL", function () {
      it("should return invalid", async function () {
        const { strategy, ampl, spot } = await loadFixture(setupContracts);
        await ampl.mockCall("balanceOf(address)", [spot.target], [perpFP("25001")]);
        const p = await strategy.perpPrice.staticCall();
        expect(p[0]).to.eq(priceFP("1.15"));
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
