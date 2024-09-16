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
      [univ3PositionKey(mockVault.target, 20000, 40000)],
      [50000, 0, 0, 0, 0],
    );
    await mockVault.mockMethod("limitLower()", [20000]);
    await mockVault.mockMethod("limitUpper()", [40000]);
    await mockVault.mockMethod("pool()", [mockPool.target]);

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

  async function stubUnchangedLimitRange(mockVault) {
    await mockVault.clearMockMethod("emergencyBurn(int24,int24,uint128)");
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

  describe("#setLiquidityRanges", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(
        manager.connect(addr1).setLiquidityRanges(7200, 330000, 1200),
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should succeed when called by owner", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      await mockVault.mockCall("setBaseThreshold(int24)", [7200], []);
      await mockVault.mockCall("setFullRangeWeight(uint24)", [330000], []);
      await mockVault.mockCall("setLimitThreshold(int24)", [1200], []);
      await manager.setLiquidityRanges(7200, 330000, 1200);
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

  describe("shouldRemoveLimitRange", function () {
    describe("is overweight spot", function () {
      it("should return bool", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await stubOverweightSpot(mockVault);
        expect(await manager.shouldRemoveLimitRange(percFP("1.01"))).to.eq(false);
        expect(await manager.shouldRemoveLimitRange(percFP("1"))).to.eq(false);
        expect(await manager.shouldRemoveLimitRange(percFP("0.99"))).to.eq(true);
      });
    });

    describe("is overweight usdc", function () {
      it("should return bool", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await stubOverweightUsdc(mockVault);
        expect(await manager.shouldRemoveLimitRange(percFP("1.01"))).to.eq(true);
        expect(await manager.shouldRemoveLimitRange(percFP("1"))).to.eq(false);
        expect(await manager.shouldRemoveLimitRange(percFP("0.99"))).to.eq(false);
      });
    });
  });

  describe("shouldForceRebalance", function () {
    describe("when deviation crosses 1", function () {
      it("should return true", async function () {
        const { manager } = await loadFixture(setupContracts);
        expect(await manager.shouldForceRebalance(percFP("0.9"), percFP("1.1"))).to.eq(
          true,
        );
        expect(await manager.shouldForceRebalance(percFP("1.5"), percFP("0.99"))).to.eq(
          true,
        );
        expect(await manager.shouldForceRebalance(percFP("1"), percFP("1.1"))).to.eq(
          true,
        );
        expect(await manager.shouldForceRebalance(percFP("1"), percFP("0.99"))).to.eq(
          true,
        );
      });
    });

    describe("when deviation does not cross 1", function () {
      it("should return false", async function () {
        const { manager } = await loadFixture(setupContracts);
        expect(await manager.shouldForceRebalance(percFP("0.9"), percFP("0.99"))).to.eq(
          false,
        );
        expect(await manager.shouldForceRebalance(percFP("1.5"), percFP("1.1"))).to.eq(
          false,
        );
        expect(await manager.shouldForceRebalance(percFP("0.9"), percFP("1"))).to.eq(
          false,
        );
        expect(await manager.shouldForceRebalance(percFP("1.5"), percFP("1"))).to.eq(
          false,
        );
      });
    });
  });

  describe("#rebalance", function () {
    it("should rebalance, update limit range and prev_deviation", async function () {
      const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

      await stubOverweightUsdc(mockVault);
      await stubRebalance(mockVault);
      await stubUnchangedLimitRange(mockVault);
      await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("0.99"), true]);

      expect(await manager.isOverweightSpot()).to.eq(false);
      expect(await manager.prevDeviation()).to.eq("0");
      await expect(manager.rebalance()).not.to.be.reverted;
      expect(await manager.prevDeviation()).to.eq(percFP("0.99"));
    });

    it("should rebalance, update limit range and prev_deviation", async function () {
      const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

      await stubOverweightSpot(mockVault);
      await stubRebalance(mockVault);
      await stubRemovedLimitRange(mockVault);
      await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("0.99"), true]);

      expect(await manager.isOverweightSpot()).to.eq(true);
      expect(await manager.prevDeviation()).to.eq("0");
      await expect(manager.rebalance()).not.to.be.reverted;
      expect(await manager.prevDeviation()).to.eq(percFP("0.99"));
    });

    it("should rebalance, update limit range and prev_deviation", async function () {
      const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

      await stubOverweightUsdc(mockVault);
      await stubForceRebalance(mockVault);
      await stubRemovedLimitRange(mockVault);
      await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("1.2"), true]);

      expect(await manager.isOverweightSpot()).to.eq(false);
      expect(await manager.prevDeviation()).to.eq("0");
      await expect(manager.rebalance()).not.to.be.reverted;
      expect(await manager.prevDeviation()).to.eq(percFP("1.2"));
    });

    it("should rebalance, update limit range and prev_deviation", async function () {
      const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

      await stubOverweightSpot(mockVault);
      await stubForceRebalance(mockVault);
      await stubUnchangedLimitRange(mockVault);
      await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("1.2"), true]);

      expect(await manager.isOverweightSpot()).to.eq(true);
      expect(await manager.prevDeviation()).to.eq("0");
      await expect(manager.rebalance()).not.to.be.reverted;
      expect(await manager.prevDeviation()).to.eq(percFP("1.2"));
    });

    it("should rebalance, remove limit range and not change prev_deviation", async function () {
      const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

      await stubOverweightSpot(mockVault);
      await stubRebalance(mockVault);
      await stubRemovedLimitRange(mockVault);
      await mockOracle.mockMethod("spotPriceDeviation()", [priceFP("1.2"), false]);

      expect(await manager.isOverweightSpot()).to.eq(true);
      expect(await manager.prevDeviation()).to.eq("0");
      await expect(manager.rebalance()).not.to.be.reverted;
      expect(await manager.prevDeviation()).to.eq(percFP("0"));
    });
  });
});
