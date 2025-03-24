import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, sciParseFloat, univ3PositionKey } from "./helpers";

export const percFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);
export const priceFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);

describe("WethWamplManager", function () {
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
      [univ3PositionKey(mockVault.target, -100000, 100000)],
      [100000, 0, 0, 0, 0],
    );
    await mockPool.mockCall(
      "positions(bytes32)",
      [univ3PositionKey(mockVault.target, 20000, 40000)],
      [50000, 0, 0, 0, 0],
    );
    await mockVault.mockMethod("baseLower()", [-100000]);
    await mockVault.mockMethod("baseUpper()", [100000]);
    await mockVault.mockMethod("fullLower()", [-800000]);
    await mockVault.mockMethod("fullUpper()", [800000]);
    await mockVault.mockMethod("limitLower()", [20000]);
    await mockVault.mockMethod("limitUpper()", [40000]);
    await mockVault.mockMethod("pool()", [mockPool.target]);

    const mockOracle = new DMock("IMetaOracle");
    await mockOracle.deploy();
    await mockOracle.mockMethod("decimals()", [18]);
    await mockOracle.mockMethod("amplPriceDeviation()", [priceFP("1.2"), true]);

    const mockWeth = new DMock("IERC20Upgradeable");
    await mockWeth.deploy();
    await mockVault.mockMethod("token0()", [mockWeth.target]);

    const mockWampl = new DMock("IWAMPL");
    await mockWampl.deploy();
    await mockVault.mockMethod("token1()", [mockWampl.target]);

    // Deploy Manager contract
    const Manager = await ethers.getContractFactory("WethWamplManager");
    const manager = await Manager.deploy(mockVault.target, mockOracle.target);

    return {
      owner,
      addr1,
      mockVault,
      mockOracle,
      mockWeth,
      mockWampl,
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

  async function stubOverweightWampl(mockVault) {
    await mockVault.mockMethod("getTwap()", [30001]);
  }
  async function stubOverweightWeth(mockVault) {
    await mockVault.mockMethod("getTwap()", [29999]);
    await mockVault.mockMethod("limitLower()", [20000]);
    await mockVault.mockMethod("limitUpper()", [40000]);
  }

  async function stubTrimLiquidity(mockVault, burntLiq) {
    await mockVault.mockCall(
      "emergencyBurn(int24,int24,uint128)",
      [-800000, 800000, burntLiq],
      [],
    );
    await mockVault.mockCall(
      "emergencyBurn(int24,int24,uint128)",
      [-100000, 100000, burntLiq],
      [],
    );
  }

  async function stubUnchangedLimitRange(mockVault) {
    await mockVault.clearMockCall(
      "emergencyBurn(int24,int24,uint128)",
      [20000, 40000, 50000],
    );
  }

  async function stubRemovedLimitRange(mockVault) {
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

    it("should set the correct oracle address", async function () {
      const { manager, mockOracle } = await loadFixture(setupContracts);
      expect(await manager.oracle()).to.eq(mockOracle.target);
    });

    it("should set the token refs", async function () {
      const { manager, mockPool } = await loadFixture(setupContracts);
      expect(await manager.POOL()).to.eq(mockPool.target);
    });

    it("should set the active perc calculation params", async function () {
      const { manager } = await loadFixture(setupContracts);
      expect(await manager.prevDeviation()).to.eq(percFP("0"));
      expect(await manager.tolerableActiveLiqPercDelta()).to.eq(percFP("0.1"));

      const f1 = await manager.activeLiqPercFn1();
      expect(f1[0]).to.eq(percFP("0.5"));
      expect(f1[1]).to.eq(percFP("0.2"));
      expect(f1[2]).to.eq(percFP("1"));
      expect(f1[3]).to.eq(percFP("1"));

      const f2 = await manager.activeLiqPercFn2();
      expect(f2[0]).to.eq(percFP("1"));
      expect(f2[1]).to.eq(percFP("1"));
      expect(f2[2]).to.eq(percFP("2"));
      expect(f2[3]).to.eq(percFP("0.2"));
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

  describe("#setActivePercParams", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(
        manager
          .connect(addr1)
          .setActivePercParams(
            percFP("0.05"),
            [percFP("0.5"), percFP("0.2"), percFP("1"), percFP("1")],
            [percFP("1"), percFP("1"), percFP("2"), percFP("0.2")],
          ),
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should succeed when called by owner", async function () {
      const { manager } = await loadFixture(setupContracts);
      await manager.setActivePercParams(
        percFP("0.1"),
        [percFP("0.5"), percFP("0.2"), percFP("1"), percFP("1")],
        [percFP("1"), percFP("1"), percFP("2"), percFP("0.2")],
      );

      expect(await manager.tolerableActiveLiqPercDelta()).to.eq(percFP("0.1"));

      const f1 = await manager.activeLiqPercFn1();
      expect(f1[0]).to.eq(percFP("0.5"));
      expect(f1[1]).to.eq(percFP("0.2"));
      expect(f1[2]).to.eq(percFP("1"));
      expect(f1[3]).to.eq(percFP("1"));

      const f2 = await manager.activeLiqPercFn2();
      expect(f2[0]).to.eq(percFP("1"));
      expect(f2[1]).to.eq(percFP("1"));
      expect(f2[2]).to.eq(percFP("2"));
      expect(f2[3]).to.eq(percFP("0.2"));
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

  describe("#computeActiveLiqPerc", function () {
    it("should compute the active liquidity percentage", async function () {
      const { manager } = await loadFixture(setupContracts);
      expect(await manager.computeActiveLiqPerc(percFP("0"))).to.eq(percFP("0.2"));
      expect(await manager.computeActiveLiqPerc(percFP("0.5"))).to.eq(percFP("0.2"));
      expect(await manager.computeActiveLiqPerc(percFP("0.75"))).to.eq(percFP("0.6"));
      expect(await manager.computeActiveLiqPerc(percFP("0.95"))).to.eq(percFP("0.92"));
      expect(await manager.computeActiveLiqPerc(percFP("1"))).to.eq(percFP("1"));
      expect(await manager.computeActiveLiqPerc(percFP("1.05"))).to.eq(percFP("0.96"));
      expect(await manager.computeActiveLiqPerc(percFP("1.25"))).to.eq(percFP("0.8"));
      expect(await manager.computeActiveLiqPerc(percFP("1.5"))).to.eq(percFP("0.6"));
      expect(await manager.computeActiveLiqPerc(percFP("1.75"))).to.eq(percFP("0.4"));
      expect(await manager.computeActiveLiqPerc(percFP("2"))).to.eq(percFP("0.2"));
      expect(await manager.computeActiveLiqPerc(percFP("2.5"))).to.eq(percFP("0.2"));
      expect(await manager.computeActiveLiqPerc(percFP("5"))).to.eq(percFP("0.2"));
      expect(await manager.computeActiveLiqPerc(percFP("10"))).to.eq(percFP("0.2"));
      expect(await manager.computeActiveLiqPerc(percFP("100000"))).to.eq(percFP("0.2"));
      expect(await manager.computeActiveLiqPerc(ethers.MaxInt256)).to.eq(percFP("0.2"));
    });
  });

  describe("isOverweightWampl", function () {
    describe("when wampl sell", function () {
      it("should return true", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await stubOverweightWampl(mockVault);
        expect(await manager.isOverweightWampl()).to.eq(true);
      });
    });

    describe("when wampl buy", function () {
      it("should return false", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await stubOverweightWeth(mockVault);
        expect(await manager.isOverweightWampl()).to.eq(false);
      });
    });
  });

  describe("shouldRemoveLimitRange", function () {
    describe("is overweight wampl", function () {
      it("should return bool", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await stubOverweightWampl(mockVault);
        expect(await manager.shouldRemoveLimitRange(percFP("1.01"))).to.eq(false);
        expect(await manager.shouldRemoveLimitRange(percFP("1"))).to.eq(false);
        expect(await manager.shouldRemoveLimitRange(percFP("0.99"))).to.eq(true);
      });
    });

    describe("is overweight weth", function () {
      it("should return bool", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await stubOverweightWeth(mockVault);
        expect(await manager.shouldRemoveLimitRange(percFP("1.01"))).to.eq(true);
        expect(await manager.shouldRemoveLimitRange(percFP("1"))).to.eq(false);
        expect(await manager.shouldRemoveLimitRange(percFP("0.99"))).to.eq(false);
      });
    });
  });

  describe("shouldForceRebalance", function () {
    it("should return bool", async function () {
      const { manager } = await loadFixture(setupContracts);

      // inside active delta
      expect(
        await manager.shouldForceRebalance(percFP("0.5"), percFP("0.8"), percFP("0.09")),
      ).to.eq(false);
      expect(
        await manager.shouldForceRebalance(percFP("0.9"), percFP("1.1"), percFP("0.09")),
      ).to.eq(true);
      expect(
        await manager.shouldForceRebalance(percFP("1.0"), percFP("1.1"), percFP("0.09")),
      ).to.eq(true);
      expect(
        await manager.shouldForceRebalance(percFP("1.05"), percFP("1.1"), percFP("0.09")),
      ).to.eq(false);
      expect(
        await manager.shouldForceRebalance(percFP("1.1"), percFP("1"), percFP("0.09")),
      ).to.eq(false);
      expect(
        await manager.shouldForceRebalance(percFP("1.1"), percFP("0.99"), percFP("0.09")),
      ).to.eq(true);
      expect(
        await manager.shouldForceRebalance(percFP("1"), percFP("0.8"), percFP("0.09")),
      ).to.eq(true);
      expect(
        await manager.shouldForceRebalance(percFP("0.9"), percFP("0.8"), percFP("0.09")),
      ).to.eq(false);

      // outside active delta
      expect(
        await manager.shouldForceRebalance(percFP("0.5"), percFP("0.8"), percFP("1.1")),
      ).to.eq(true);
      expect(
        await manager.shouldForceRebalance(percFP("0.9"), percFP("1.1"), percFP("1.1")),
      ).to.eq(true);
      expect(
        await manager.shouldForceRebalance(percFP("1.0"), percFP("1.1"), percFP("1.1")),
      ).to.eq(true);
      expect(
        await manager.shouldForceRebalance(percFP("1.05"), percFP("1.1"), percFP("1.1")),
      ).to.eq(true);
      expect(
        await manager.shouldForceRebalance(percFP("1.1"), percFP("1"), percFP("1.1")),
      ).to.eq(true);
      expect(
        await manager.shouldForceRebalance(percFP("1.1"), percFP("0.99"), percFP("1.1")),
      ).to.eq(true);
      expect(
        await manager.shouldForceRebalance(percFP("1"), percFP("0.8"), percFP("1.1")),
      ).to.eq(true);
      expect(
        await manager.shouldForceRebalance(percFP("0.9"), percFP("0.8"), percFP("1.1")),
      ).to.eq(true);
    });
  });

  describe("#rebalance", function () {
    it("should rebalance, trim liquidity and prev_deviation", async function () {
      const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

      await stubOverweightWeth(mockVault);
      await stubForceRebalance(mockVault);
      await stubTrimLiquidity(mockVault, 1600);
      await stubUnchangedLimitRange(mockVault);
      await mockOracle.mockMethod("amplPriceDeviation()", [priceFP("0.99"), true]);

      expect(await manager.isOverweightWampl()).to.eq(false);
      expect(await manager.prevDeviation()).to.eq("0");
      await expect(manager.rebalance()).not.to.be.reverted;
      expect(await manager.prevDeviation()).to.eq(percFP("0.99"));
    });

    it("should rebalance, trim liquidity and prev_deviation", async function () {
      const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

      await stubOverweightWampl(mockVault);
      await stubForceRebalance(mockVault);
      await stubTrimLiquidity(mockVault, 1600);
      await stubRemovedLimitRange(mockVault);
      await mockOracle.mockMethod("amplPriceDeviation()", [priceFP("0.99"), true]);

      expect(await manager.isOverweightWampl()).to.eq(true);
      expect(await manager.prevDeviation()).to.eq("0");
      await expect(manager.rebalance()).not.to.be.reverted;
      expect(await manager.prevDeviation()).to.eq(percFP("0.99"));
    });

    it("should rebalance, trim liquidity and prev_deviation", async function () {
      const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

      await stubOverweightWeth(mockVault);
      await stubForceRebalance(mockVault);
      await stubTrimLiquidity(mockVault, 16000);
      await stubRemovedLimitRange(mockVault);
      await mockOracle.mockMethod("amplPriceDeviation()", [priceFP("1.2"), true]);

      expect(await manager.isOverweightWampl()).to.eq(false);
      expect(await manager.prevDeviation()).to.eq("0");
      await expect(manager.rebalance()).not.to.be.reverted;
      expect(await manager.prevDeviation()).to.eq(percFP("1.2"));
    });

    it("should rebalance, trim liquidity and prev_deviation", async function () {
      const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

      await stubOverweightWampl(mockVault);
      await stubForceRebalance(mockVault);
      await stubTrimLiquidity(mockVault, 16000);
      await stubUnchangedLimitRange(mockVault);
      await mockOracle.mockMethod("amplPriceDeviation()", [priceFP("1.2"), true]);

      expect(await manager.isOverweightWampl()).to.eq(true);
      expect(await manager.prevDeviation()).to.eq("0");
      await expect(manager.rebalance()).not.to.be.reverted;
      expect(await manager.prevDeviation()).to.eq(percFP("1.2"));
    });

    it("should rebalance, trim liquidity and not change prev_deviation", async function () {
      const { manager, mockVault, mockOracle } = await loadFixture(setupContracts);

      await stubOverweightWampl(mockVault);
      await stubRebalance(mockVault);
      await stubTrimLiquidity(mockVault, 80000);
      await stubRemovedLimitRange(mockVault);
      await mockOracle.mockMethod("amplPriceDeviation()", [priceFP("1.2"), false]);

      expect(await manager.isOverweightWampl()).to.eq(true);
      expect(await manager.prevDeviation()).to.eq("0");
      await expect(manager.rebalance()).not.to.be.reverted;
      expect(await manager.prevDeviation()).to.eq(percFP("0"));
    });
  });
});
