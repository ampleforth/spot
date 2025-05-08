import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, sciParseFloat, univ3PositionKey } from "./helpers";

export const percFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);
export const spotFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 9);
export const usdcFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 6);
export const priceFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);

describe("UsdcSpotManager", function () {
  async function setupContracts() {
    const accounts = await ethers.getSigners();
    const owner = accounts[0];
    const addr1 = accounts[1];

    // Deploy mock contracts
    const mockVault = new DMock("IAlphaProVault");
    await mockVault.deploy();

    const mockPool = new DMock("IUniswapV3Pool");
    await mockPool.deploy();
    await mockPool.mockCall(
      "positions(bytes32)",
      [univ3PositionKey(mockVault.target, -800000, 800000)],
      [100000, 0, 0, 0, 0],
    );
    await mockPool.mockCall(
      "positions(bytes32)",
      [univ3PositionKey(mockVault.target, -1000, 1000)],
      [0, 0, 0, 0, 0],
    );
    await mockPool.mockCall(
      "positions(bytes32)",
      [univ3PositionKey(mockVault.target, 20000, 40000)],
      [50000, 0, 0, 0, 0],
    );
    await mockVault.mockMethod("baseLower()", [-1000]);
    await mockVault.mockMethod("baseUpper()", [1000]);
    await mockVault.mockMethod("fullLower()", [-800000]);
    await mockVault.mockMethod("fullUpper()", [800000]);
    await mockVault.mockMethod("limitLower()", [20000]);
    await mockVault.mockMethod("limitUpper()", [40000]);
    await mockVault.mockMethod("pool()", [mockPool.target]);
    await mockVault.mockMethod("getTotalAmounts()", [usdcFP("500000"), spotFP("500000")]);

    const mockOracle = new DMock("IMetaOracle");
    await mockOracle.deploy();
    await mockOracle.mockMethod("decimals()", [18]);
    await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("1.2"), true]);

    const mockUsdc = new DMock("IERC20Upgradeable");
    await mockUsdc.deploy();
    await mockVault.mockMethod("token0()", [mockUsdc.target]);

    const mockSpot = new DMock("IERC20Upgradeable");
    await mockSpot.deploy();
    await mockVault.mockMethod("token1()", [mockSpot.target]);

    // Deploy Manager contract
    const Manager = await ethers.getContractFactory("UsdcSpotManager");
    const manager = await Manager.deploy(mockVault.target, mockOracle.target);

    return {
      owner,
      addr1,
      mockVault,
      mockOracle,
      mockUsdc,
      mockSpot,
      mockPool,
      manager,
    };
  }

  async function stubRebalance(mockVault) {
    await mockVault.clearMockMethod("setPeriod(uint32)");
    await mockVault.clearMockMethod("period()");
    await mockVault.mockMethod("rebalance()", []);
  }

  async function stubForceRebalance(mockVault) {
    await mockVault.mockMethod("period()", [86400]);
    await mockVault.mockCall("setPeriod(uint32)", [0], []);
    await mockVault.mockCall("setPeriod(uint32)", [86400], []);
    await mockVault.mockMethod("rebalance()", []);
  }

  async function stubOverweightSpot(mockVault) {
    await mockVault.mockMethod("getTwap()", [30001]);
  }

  async function stubOverweightUsdc(mockVault) {
    await mockVault.mockMethod("getTwap()", [29999]);
  }

  async function stubActiveZoneLiq(mockVault, fr, base, limit) {
    await mockVault.mockCall("setFullRangeWeight(uint24)", [fr], []);
    await mockVault.mockCall("setBaseThreshold(int24)", [base], []);
    await mockVault.mockCall("setLimitThreshold(int24)", [limit], []);
  }

  async function stubInactiveLiq(mockVault) {
    await mockVault.mockCall("setFullRangeWeight(uint24)", [1000000], []);
    await mockVault.mockCall("setBaseThreshold(int24)", [48000], []);
    await mockVault.mockCall("setLimitThreshold(int24)", [48000], []);
  }

  async function stubTrimFullRangeLiq(mockVault, burntLiq) {
    await mockVault.mockCall(
      "emergencyBurn(int24,int24,uint128)",
      [-800000, 800000, burntLiq],
      [],
    );
  }

  async function stubRemovedLimitRange(mockVault) {
    await mockVault.clearMockMethod("emergencyBurn(int24,int24,uint128)");
    await mockVault.mockCall(
      "emergencyBurn(int24,int24,uint128)",
      [20000, 40000, 50000],
      [],
    );
  }

  describe("Initialization", function () {
    it("should set the correct owner", async function () {
      const { manager, owner } = await loadFixture(setupContracts);
      expect(await manager.owner()).to.eq(await owner.getAddress());
    });

    it("should set the correct vault address", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      expect(await manager.VAULT()).to.eq(mockVault.target);
    });

    it("should set the appraiser address", async function () {
      const { manager, mockOracle } = await loadFixture(setupContracts);
      expect(await manager.oracle()).to.eq(mockOracle.target);
    });

    it("should set the token refs", async function () {
      const { manager, mockPool } = await loadFixture(setupContracts);
      expect(await manager.POOL()).to.eq(mockPool.target);
    });

    it("should return the decimals", async function () {
      const { manager } = await loadFixture(setupContracts);
      expect(await manager.decimals()).to.eq(18);
    });

    it("should set initial parameters", async function () {
      const { manager } = await loadFixture(setupContracts);
      expect(await manager.prevWithinActiveZone()).to.eq(false);
      const r = await manager.activeZoneDeviation();
      expect(r[0]).to.eq(percFP("0.95"));
      expect(r[1]).to.eq(percFP("1.05"));
      expect(await manager.concBandDeviationWidth()).to.eq(percFP("0.05"));
      expect(await manager.fullRangeMaxUsdcBal()).to.eq(usdcFP("250000"));
    });
  });

  describe("#updateOracle", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      const mockOracle = new DMock("IMetaOracle");
      await mockOracle.deploy();
      await mockOracle.mockMethod("decimals()", [18]);
      await expect(
        manager.connect(addr1).updateOracle(mockOracle.target),
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should fail when decimals dont match", async function () {
      const { manager } = await loadFixture(setupContracts);
      const mockOracle = new DMock("IMetaOracle");
      await mockOracle.deploy();
      await mockOracle.mockMethod("decimals()", [9]);
      await expect(manager.updateOracle(mockOracle.target)).to.be.revertedWith(
        "UnexpectedDecimals",
      );
    });

    it("should succeed when called by owner", async function () {
      const { manager } = await loadFixture(setupContracts);
      const mockOracle = new DMock("IMetaOracle");
      await mockOracle.deploy();
      await mockOracle.mockMethod("decimals()", [18]);
      await manager.updateOracle(mockOracle.target);
      expect(await manager.oracle()).to.eq(mockOracle.target);
    });
  });

  describe("#updateActiveZone", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(
        manager.connect(addr1).updateActiveZone([percFP("0.9"), percFP("1.1")]),
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should succeed when called by owner", async function () {
      const { manager } = await loadFixture(setupContracts);
      await manager.updateActiveZone([percFP("0.9"), percFP("1.1")]);
      const r = await manager.activeZoneDeviation();
      expect(r[0]).to.eq(percFP("0.9"));
      expect(r[1]).to.eq(percFP("1.1"));
    });
  });

  describe("#updateConcentratedBand", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(
        manager.connect(addr1).updateConcentratedBand(percFP("0.1")),
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should succeed when called by owner", async function () {
      const { manager } = await loadFixture(setupContracts);
      await manager.updateConcentratedBand(percFP("0.1"));
      expect(await manager.concBandDeviationWidth()).to.eq(percFP("0.1"));
    });
  });

  describe("#updateFullRangeLiquidity", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(
        manager.connect(addr1).updateFullRangeLiquidity(usdcFP("1000000"), percFP("0.2")),
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should fail to when param is invalid", async function () {
      const { manager } = await loadFixture(setupContracts);
      await expect(
        manager.updateFullRangeLiquidity(usdcFP("1000000"), percFP("1.2")),
      ).to.be.revertedWith("InvalidPerc");
    });

    it("should succeed when called by owner", async function () {
      const { manager } = await loadFixture(setupContracts);
      await manager.updateFullRangeLiquidity(usdcFP("1000000"), percFP("0.2"));
      expect(await manager.fullRangeMaxUsdcBal()).to.eq(usdcFP("1000000"));
      expect(await manager.fullRangeMaxPerc()).to.eq(percFP("0.2"));
    });
  });

  describe("#execOnVault", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1, mockVault } = await loadFixture(setupContracts);
      await expect(
        manager
          .connect(addr1)
          .execOnVault(
            mockVault.refFactory.interface.encodeFunctionData("acceptManager"),
          ),
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should succeed when called by owner", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      await mockVault.mockCall("setManager(address)", [ethers.ZeroAddress], []);
      await manager.execOnVault(
        mockVault.refFactory.interface.encodeFunctionData("setManager", [
          ethers.ZeroAddress,
        ]),
      );
    });

    it("should revert if call failed", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      await expect(
        manager.execOnVault(
          mockVault.refFactory.interface.encodeFunctionData("acceptManager"),
        ),
      ).to.be.revertedWith("VaultExecutionFailed");
      await mockVault.mockCall("acceptManager()", [], []);
      await manager.execOnVault(
        mockVault.refFactory.interface.encodeFunctionData("acceptManager"),
      );
    });
  });

  describe("isOverweightSpot", function () {
    describe("when spot sell", function () {
      it("should return true", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await stubOverweightSpot(mockVault);
        expect(await manager.isOverweightSpot()).to.eq(true);
      });
    });

    describe("when spot buy", function () {
      it("should return false", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await stubOverweightUsdc(mockVault);
        expect(await manager.isOverweightSpot()).to.eq(false);
      });
    });
  });

  describe("activeZone", function () {
    it("should return state", async function () {
      const { manager } = await loadFixture(setupContracts);
      expect(await manager.activeZone(percFP("0.949"))).to.eq(false);
      expect(await manager.activeZone(percFP("0.95"))).to.eq(true);
      expect(await manager.activeZone(percFP("0.975"))).to.eq(true);
      expect(await manager.activeZone(percFP("1"))).to.eq(true);
      expect(await manager.activeZone(percFP("1.025"))).to.eq(true);
      expect(await manager.activeZone(percFP("1.05"))).to.eq(true);
      expect(await manager.activeZone(percFP("1.051"))).to.eq(false);
    });
  });

  describe("activeFullRangePerc", function () {
    it("should calculate full range perc", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      await manager.updateFullRangeLiquidity(usdcFP("25000"), percFP("0.2"));
      await mockVault.mockMethod("getTotalAmounts()", [usdcFP("500000"), spotFP("0")]);
      expect(await manager.activeFullRangePerc()).to.eq(percFP("0.05"));
    });
    it("should calculate full range perc", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      await manager.updateFullRangeLiquidity(usdcFP("250000"), percFP("0.1"));
      await mockVault.mockMethod("getTotalAmounts()", [usdcFP("500000"), spotFP("10")]);
      expect(await manager.activeFullRangePerc()).to.eq(percFP("0.1"));
    });
    it("should calculate full range perc", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      await manager.updateFullRangeLiquidity(usdcFP("250000"), percFP("1"));
      await mockVault.mockMethod("getTotalAmounts()", [
        usdcFP("500000"),
        spotFP("10000"),
      ]);
      expect(await manager.activeFullRangePerc()).to.eq(percFP("0.5"));
    });
  });

  describe("deviationToTicks", function () {
    it("should return ticks", async function () {
      const { manager } = await loadFixture(setupContracts);
      expect(await manager.deviationToTicks(percFP("0.1"))).to.eq(1000);
      expect(await manager.deviationToTicks(percFP("0.05"))).to.eq(400);
      expect(await manager.deviationToTicks(percFP("0.025"))).to.eq(200);
      expect(await manager.deviationToTicks(percFP("0.01"))).to.eq(200);
      expect(await manager.deviationToTicks(percFP("0"))).to.eq(200);
    });
  });

  describe("#rebalance", function () {
    describe("when price is inside active range, previously outside", function () {
      it("should force rebalance and update liquidity", async function () {
        const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);
        await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("0.98"), true]);

        await stubOverweightUsdc(mockVault);
        await stubActiveZoneLiq(mockVault, 500000, 400, 200);
        await stubForceRebalance(mockVault);

        expect(await manager.isOverweightSpot()).to.eq(false);
        expect(await manager.prevWithinActiveZone()).to.eq(false);
        await expect(manager.rebalance()).not.to.be.reverted;
        expect(await manager.prevWithinActiveZone()).to.eq(true);
      });

      it("should force rebalance and update liquidity", async function () {
        const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);
        await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("0.98"), true]);

        await stubOverweightSpot(mockVault);
        await stubActiveZoneLiq(mockVault, 500000, 400, 600);
        await stubForceRebalance(mockVault);

        expect(await manager.isOverweightSpot()).to.eq(true);
        expect(await manager.prevWithinActiveZone()).to.eq(false);
        await expect(manager.rebalance()).not.to.be.reverted;
        expect(await manager.prevWithinActiveZone()).to.eq(true);
      });
    });

    describe("when price is outside active range, previously inside", function () {
      it("should rebalance and update liquidity", async function () {
        const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

        await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("1"), true]);
        await stubOverweightUsdc(mockVault);
        await stubActiveZoneLiq(mockVault, 500000, 400, 400);
        await stubForceRebalance(mockVault);
        await manager.rebalance();

        await mockVault.mockMethod("getTotalAmounts()", [
          usdcFP("1000000"),
          spotFP("500000"),
        ]);
        await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("0.5"), true]);
        await stubInactiveLiq(mockVault);
        await stubTrimFullRangeLiq(mockVault, 75000);
        await stubRemovedLimitRange(mockVault);
        await stubForceRebalance(mockVault);

        expect(await manager.isOverweightSpot()).to.eq(false);
        expect(await manager.prevWithinActiveZone()).to.eq(true);
        await expect(manager.rebalance()).not.to.be.reverted;
        expect(await manager.prevWithinActiveZone()).to.eq(false);
      });
    });

    describe("when price is inside active range, previously inside", function () {
      it("should rebalance and update liquidity", async function () {
        const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

        await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("1"), true]);
        await stubOverweightUsdc(mockVault);
        await stubActiveZoneLiq(mockVault, 500000, 400, 400);
        await stubForceRebalance(mockVault);
        await manager.rebalance();

        await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("1.02"), true]);
        await stubActiveZoneLiq(mockVault, 500000, 400, 600);
        await stubRebalance(mockVault);

        expect(await manager.isOverweightSpot()).to.eq(false);
        expect(await manager.prevWithinActiveZone()).to.eq(true);
        await expect(manager.rebalance()).not.to.be.reverted;
        expect(await manager.prevWithinActiveZone()).to.eq(true);
      });

      it("should rebalance and update liquidity", async function () {
        const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

        await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("1"), true]);
        await stubOverweightUsdc(mockVault);
        await stubActiveZoneLiq(mockVault, 500000, 400, 400);
        await stubForceRebalance(mockVault);
        await manager.rebalance();

        await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("1.02"), true]);
        await stubOverweightSpot(mockVault);
        await stubActiveZoneLiq(mockVault, 500000, 400, 200);
        await stubRebalance(mockVault);

        expect(await manager.isOverweightSpot()).to.eq(true);
        expect(await manager.prevWithinActiveZone()).to.eq(true);
        await expect(manager.rebalance()).not.to.be.reverted;
        expect(await manager.prevWithinActiveZone()).to.eq(true);
      });
    });

    describe("when price is outside active range, previously outside", function () {
      it("should rebalance and update liquidity", async function () {
        const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

        await mockVault.mockMethod("getTotalAmounts()", [
          usdcFP("2500000"),
          spotFP("500000"),
        ]);
        await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("0.75"), true]);
        await stubOverweightUsdc(mockVault);
        await stubInactiveLiq(mockVault);
        await stubTrimFullRangeLiq(mockVault, 90000);
        await stubRemovedLimitRange(mockVault);
        await stubRebalance(mockVault);

        expect(await manager.isOverweightSpot()).to.eq(false);
        expect(await manager.prevWithinActiveZone()).to.eq(false);
        await expect(manager.rebalance()).not.to.be.reverted;
        expect(await manager.prevWithinActiveZone()).to.eq(false);
      });
    });

    describe("when price is invalid", function () {
      it("should rebalance and update liquidity", async function () {
        const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

        await mockVault.mockMethod("getTotalAmounts()", [
          usdcFP("2500000"),
          spotFP("500000"),
        ]);
        await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("0.75"), false]);
        await stubOverweightUsdc(mockVault);
        await stubInactiveLiq(mockVault);
        await stubTrimFullRangeLiq(mockVault, 90000);
        await stubRemovedLimitRange(mockVault);
        await stubRebalance(mockVault);

        expect(await manager.isOverweightSpot()).to.eq(false);
        expect(await manager.prevWithinActiveZone()).to.eq(false);
        await expect(manager.rebalance()).not.to.be.reverted;
        expect(await manager.prevWithinActiveZone()).to.eq(false);
      });
    });
  });
});
