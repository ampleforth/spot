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
    await mockVault.mockMethod("fullLower()", [-800000]);
    await mockVault.mockMethod("fullUpper()", [800000]);
    await mockVault.mockMethod("baseLower()", [45000]);
    await mockVault.mockMethod("baseUpper()", [55000]);
    await mockVault.mockMethod("getTwap()", [67200]);
    await mockVault.mockMethod("limitThreshold()", [800000]);

    const mockPool = new DMock("IUniswapV3Pool");
    await mockPool.deploy();
    await mockVault.mockMethod("pool()", [mockPool.target]);

    const mockAppraiser = new DMock("IBillBrokerPricingStrategy");
    await mockAppraiser.deploy();
    await mockAppraiser.mockMethod("decimals()", [18]);
    await mockAppraiser.mockMethod("perpPrice()", [priceFP("1.2"), true]);
    await mockAppraiser.mockMethod("usdPrice()", [priceFP("1"), true]);

    const mockUsdc = new DMock("IERC20Upgradeable");
    await mockUsdc.deploy();
    await mockVault.mockMethod("token0()", [mockUsdc.target]);

    const mockSpot = new DMock("IERC20Upgradeable");
    await mockSpot.deploy();
    await mockVault.mockMethod("token1()", [mockSpot.target]);

    // Deploy Manager contract
    const Manager = await ethers.getContractFactory("UsdcSpotManager");
    const manager = await Manager.deploy(mockVault.target, mockAppraiser.target);

    return {
      owner,
      addr1,
      mockVault,
      mockAppraiser,
      mockUsdc,
      mockSpot,
      mockPool,
      manager,
    };
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
      const { manager, mockAppraiser } = await loadFixture(setupContracts);
      expect(await manager.spotAppraiser()).to.eq(mockAppraiser.target);
    });

    it("should set the token refs", async function () {
      const { manager, mockUsdc, mockSpot, mockPool } = await loadFixture(setupContracts);
      expect(await manager.POOL()).to.eq(mockPool.target);
      expect(await manager.USDC()).to.eq(mockUsdc.target);
      expect(await manager.SPOT()).to.eq(mockSpot.target);
    });

    it("should return the decimals", async function () {
      const { manager } = await loadFixture(setupContracts);
      expect(await manager.decimals()).to.eq(18);
    });
  });

  describe("#transferOwnership", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(
        manager.connect(addr1).transferOwnership(addr1.address),
      ).to.be.revertedWith("Unauthorized caller");
    });

    it("should succeed when called by owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await manager.transferOwnership(addr1.address);
      expect(await manager.owner()).to.eq(await addr1.getAddress());
    });
  });

  describe("#setSpotAppraiser", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(
        manager.connect(addr1).setSpotAppraiser(addr1.address),
      ).to.be.revertedWith("Unauthorized caller");
    });

    it("should succeed when called by owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await manager.setSpotAppraiser(addr1.address);
      expect(await manager.spotAppraiser()).to.eq(await addr1.getAddress());
    });
  });

  describe("#setLiquidityRanges", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(
        manager.connect(addr1).setLiquidityRanges(7200, 330000, 1200),
      ).to.be.revertedWith("Unauthorized caller");
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
      ).to.be.revertedWith("Unauthorized caller");
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
      ).to.be.revertedWith("Vault call failed");
      await mockVault.mockCall("acceptManager()", [], []);
      await manager.execOnVault(
        mockVault.refFactory.interface.encodeFunctionData("acceptManager"),
      );
    });
  });

  describe("#computeDeviationFactor", function () {
    describe("when spot price is invalid", function () {
      it("should return invalid", async function () {
        const { manager, mockAppraiser } = await loadFixture(setupContracts);
        await mockAppraiser.mockMethod("perpPrice()", [priceFP("1.2"), false]);
        const r = await manager.computeDeviationFactor.staticCall();
        expect(r[0]).to.eq(percFP("1.0057863765655975"));
        expect(r[1]).to.eq(false);
      });
    });

    describe("when usd price is invalid", function () {
      it("should return invalid", async function () {
        const { manager, mockAppraiser } = await loadFixture(setupContracts);
        await mockAppraiser.mockMethod("usdPrice()", [priceFP("0.8"), false]);
        const r = await manager.computeDeviationFactor.staticCall();
        expect(r[0]).to.eq(percFP("1.0057863765655975"));
        expect(r[1]).to.eq(false);
      });
    });

    it("should return deviation factor", async function () {
      const { manager } = await loadFixture(setupContracts);
      const r = await manager.computeDeviationFactor.staticCall();
      expect(r[0]).to.eq(percFP("1.0057863765655975"));
      expect(r[1]).to.eq(true);
    });

    it("should return deviation factor", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      await mockVault.mockMethod("getTwap()", [65800]);
      const r = await manager.computeDeviationFactor.staticCall();
      expect(r[0]).to.eq(percFP("1.1569216182711425"));
      expect(r[1]).to.eq(true);
    });

    it("should return deviation factor", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      await mockVault.mockMethod("getTwap()", [67800]);
      const r = await manager.computeDeviationFactor.staticCall();
      expect(r[0]).to.eq(percFP("0.947216779268338333"));
      expect(r[1]).to.eq(true);
    });

    it("should return deviation factor", async function () {
      const { manager, mockAppraiser } = await loadFixture(setupContracts);
      await mockAppraiser.mockMethod("perpPrice()", [priceFP("1.5"), true]);
      const r = await manager.computeDeviationFactor.staticCall();
      expect(r[0]).to.eq(percFP("0.804629101252478"));
      expect(r[1]).to.eq(true);
    });

    it("should return deviation factor", async function () {
      const { manager, mockAppraiser } = await loadFixture(setupContracts);
      await mockAppraiser.mockMethod("perpPrice()", [priceFP("1"), true]);
      const r = await manager.computeDeviationFactor.staticCall();
      expect(r[0]).to.eq(percFP("1.206943651878717"));
      expect(r[1]).to.eq(true);
    });

    it("should return deviation factor when perp price is invalid", async function () {
      const { manager, mockAppraiser } = await loadFixture(setupContracts);
      await mockAppraiser.mockMethod("perpPrice()", [priceFP("0"), true]);
      const r = await manager.computeDeviationFactor.staticCall();
      expect(r[0]).to.eq(percFP("100"));
      expect(r[1]).to.eq(true);
    });
  });

  describe("isOverweightSpot", function () {
    describe("when spot sell", function () {
      it("should return true", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await mockVault.mockMethod("getTwap()", [30001]);
        await mockVault.mockMethod("limitLower()", [20000]);
        await mockVault.mockMethod("limitUpper()", [40000]);
        expect(await manager.isOverweightSpot()).to.eq(true);
      });
    });

    describe("when spot buy", function () {
      it("should return false", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await mockVault.mockMethod("getTwap()", [29999]);
        await mockVault.mockMethod("limitLower()", [20000]);
        await mockVault.mockMethod("limitUpper()", [40000]);
        expect(await manager.isOverweightSpot()).to.eq(false);
      });
    });
  });

  describe("#rebalance", function () {
    describe("when deviation is < 1 and goes > 1", function () {
      describe("when overweight spot", function () {
        it("should keep limit range", async function () {
          const { manager, mockVault } = await loadFixture(setupContracts);

          await mockVault.mockMethod("getTwap()", [66200]);
          await mockVault.mockMethod("limitLower()", [40000]);
          await mockVault.mockMethod("limitUpper()", [45000]);

          await mockVault.mockMethod("period()", [86400]);
          await mockVault.mockCall("setPeriod(uint32)", [0], []);
          await mockVault.mockCall("setPeriod(uint32)", [86400], []);
          await mockVault.mockMethod("rebalance()", []);

          expect(await manager.prevDeviation()).to.eq("0");
          expect(await manager.isOverweightSpot()).to.eq(true);
          await expect(manager.rebalance()).not.to.be.reverted;
          expect(await manager.prevDeviation()).to.eq(percFP("1.111560295732100833"));
        });
      });

      describe("when overweight usdc", function () {
        it("should remove limit range", async function () {
          const { manager, mockVault, mockPool } = await loadFixture(setupContracts);

          await mockVault.mockMethod("getTwap()", [66200]);
          await mockVault.mockMethod("limitLower()", [73000]);
          await mockVault.mockMethod("limitUpper()", [75000]);
          await mockPool.mockCall(
            "positions(bytes32)",
            [univ3PositionKey(mockVault.target, 73000, 75000)],
            [50000, 0, 0, 0, 0],
          );

          await mockVault.mockMethod("period()", [86400]);
          await mockVault.mockCall("setPeriod(uint32)", [0], []);
          await mockVault.mockCall("setPeriod(uint32)", [86400], []);
          await mockVault.mockMethod("rebalance()", []);
          await mockVault.mockCall(
            "emergencyBurn(int24,int24,uint128)",
            [73000, 75000, 50000],
            [],
          );

          expect(await manager.prevDeviation()).to.eq("0");
          expect(await manager.isOverweightSpot()).to.eq(false);
          await expect(manager.rebalance()).not.to.be.reverted;
          expect(await manager.prevDeviation()).to.eq(percFP("1.111560295732100833"));
        });
      });
    });

    describe("when deviation is > 1 and goes < 1", function () {
      describe("when overweight spot", function () {
        it("should remove limit range", async function () {
          const { manager, mockVault, mockPool } = await loadFixture(setupContracts);

          await mockVault.mockMethod("getTwap()", [66200]);
          await mockVault.mockMethod("limitLower()", [40000]);
          await mockVault.mockMethod("limitUpper()", [45000]);
          await mockVault.mockMethod("period()", [86400]);
          await mockVault.mockCall("setPeriod(uint32)", [0], []);
          await mockVault.mockCall("setPeriod(uint32)", [86400], []);
          await mockVault.mockMethod("rebalance()", []);
          await manager.rebalance();

          await mockVault.mockMethod("getTwap()", [67800]);
          await mockVault.mockMethod("limitLower()", [60000]);
          await mockVault.mockMethod("limitUpper()", [65000]);
          await mockPool.mockCall(
            "positions(bytes32)",
            [univ3PositionKey(mockVault.target, 60000, 65000)],
            [50000, 0, 0, 0, 0],
          );
          await mockVault.clearMockMethod("emergencyBurn(int24,int24,uint128)");
          await mockVault.mockCall(
            "emergencyBurn(int24,int24,uint128)",
            [60000, 65000, 50000],
            [],
          );

          expect(await manager.prevDeviation()).to.eq(percFP("1.111560295732100833"));
          expect(await manager.isOverweightSpot()).to.eq(true);
          await expect(manager.rebalance()).not.to.be.reverted;
          expect(await manager.prevDeviation()).to.eq(percFP("0.947216779268338333"));
        });
      });

      describe("when overweight usdc", function () {
        it("should keep limit range", async function () {
          const { manager, mockVault } = await loadFixture(setupContracts);

          await mockVault.mockMethod("getTwap()", [66200]);
          await mockVault.mockMethod("limitLower()", [40000]);
          await mockVault.mockMethod("limitUpper()", [45000]);
          await mockVault.mockMethod("period()", [86400]);
          await mockVault.mockCall("setPeriod(uint32)", [0], []);
          await mockVault.mockCall("setPeriod(uint32)", [86400], []);
          await mockVault.mockMethod("rebalance()", []);
          await manager.rebalance();

          await mockVault.mockMethod("getTwap()", [67800]);
          await mockVault.mockMethod("limitLower()", [75000]);
          await mockVault.mockMethod("limitUpper()", [80000]);
          await mockVault.clearMockMethod("emergencyBurn(int24,int24,uint128)");

          expect(await manager.prevDeviation()).to.eq(percFP("1.111560295732100833"));
          expect(await manager.isOverweightSpot()).to.eq(false);
          await expect(manager.rebalance()).not.to.be.reverted;
          expect(await manager.prevDeviation()).to.eq(percFP("0.947216779268338333"));
        });
      });
    });

    describe("when deviation remains below 1", function () {
      describe("when overweight spot", function () {
        it("should not force rebalance", async function () {
          const { manager, mockVault, mockPool } = await loadFixture(setupContracts);

          await mockVault.mockMethod("getTwap()", [67800]);
          await mockVault.mockMethod("limitLower()", [40000]);
          await mockVault.mockMethod("limitUpper()", [45000]);
          await mockVault.mockMethod("rebalance()", []);
          await mockPool.mockCall(
            "positions(bytes32)",
            [univ3PositionKey(mockVault.target, 40000, 45000)],
            [50000, 0, 0, 0, 0],
          );
          await mockVault.mockCall(
            "emergencyBurn(int24,int24,uint128)",
            [40000, 45000, 50000],
            [],
          );

          expect(await manager.prevDeviation()).to.eq("0");
          expect(await manager.isOverweightSpot()).to.eq(true);
          await expect(manager.rebalance()).not.to.be.reverted;
          expect(await manager.prevDeviation()).to.eq(percFP("0.947216779268338333"));
        });
      });
    });

    describe("when deviation remains above 1", function () {
      describe("when overweight usdc", function () {
        it("should not force rebalance", async function () {
          const { manager, mockVault, mockPool } = await loadFixture(setupContracts);

          await mockVault.mockMethod("getTwap()", [66200]);
          await mockVault.mockMethod("limitLower()", [40000]);
          await mockVault.mockMethod("limitUpper()", [45000]);
          await mockVault.mockMethod("period()", [86400]);
          await mockVault.mockCall("setPeriod(uint32)", [0], []);
          await mockVault.mockCall("setPeriod(uint32)", [86400], []);
          await mockVault.mockMethod("rebalance()", []);
          await manager.rebalance();

          await mockVault.clearMockCall("setPeriod(uint32)", [0]);
          await mockVault.clearMockCall("setPeriod(uint32)", [86400]);
          await mockVault.clearMockCall("period()", []);
          await mockVault.clearMockMethod("emergencyBurn(int24,int24,uint128)");

          await mockVault.mockMethod("getTwap()", [66800]);
          await mockVault.mockMethod("limitLower()", [75000]);
          await mockVault.mockMethod("limitUpper()", [80000]);
          await mockPool.mockCall(
            "positions(bytes32)",
            [univ3PositionKey(mockVault.target, 75000, 80000)],
            [50000, 0, 0, 0, 0],
          );
          await mockVault.mockMethod("emergencyBurn(int24,int24,uint128)", []);

          expect(await manager.prevDeviation()).to.eq(percFP("1.111560295732100833"));
          expect(await manager.isOverweightSpot()).to.eq(false);
          await expect(manager.rebalance()).not.to.be.reverted;
          expect(await manager.prevDeviation()).to.eq(percFP("1.0468312037404625"));
        });
      });
    });
  });
});
