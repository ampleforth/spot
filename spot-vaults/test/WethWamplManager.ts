import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, sciParseFloat, univ3PositionKey } from "./helpers";

export const percFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);
export const amplFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 9);
export const wamplFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);
export const ethOracleFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 8);
export const amplOracleFP = (a: string): BigInt =>
  ethers.parseUnits(sciParseFloat(a), 18);
const nowTS = () => parseInt(Date.now() / 1000);

describe("WethWamplManager", function () {
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
    await mockVault.mockMethod("getTwap()", [49875]);
    await mockVault.mockMethod("limitThreshold()", [800000]);

    const mockPool = new DMock("IUniswapV3Pool");
    await mockPool.deploy();
    await mockPool.mockCall(
      "positions(bytes32)",
      [univ3PositionKey(mockVault.target, -800000, 800000)],
      [100000, 0, 0, 0, 0],
    );
    await mockPool.mockCall(
      "positions(bytes32)",
      [univ3PositionKey(mockVault.target, 45000, 55000)],
      [20000, 0, 0, 0, 0],
    );
    await mockVault.mockMethod("pool()", [mockPool.target]);

    const mockCPIOracle = new DMock("IAmpleforthOracle");
    await mockCPIOracle.deploy();
    await mockCPIOracle.mockMethod("DECIMALS()", [18]);
    await mockCPIOracle.mockMethod("getData()", [amplOracleFP("1.19"), true]);

    const mockETHOracle = new DMock("IChainlinkOracle");
    await mockETHOracle.deploy();
    await mockETHOracle.mockMethod("decimals()", [8]);
    await mockETHOracle.mockMethod("latestRoundData()", [
      0,
      ethOracleFP("3300"),
      0,
      nowTS(),
      0,
    ]);

    const mockWeth = new DMock("IERC20Upgradeable");
    await mockWeth.deploy();
    await mockVault.mockMethod("token0()", [mockWeth.target]);

    const mockWampl = new DMock("IWAMPL");
    await mockWampl.deploy();
    await mockWampl.mockCall(
      "wrapperToUnderlying(uint256)",
      [wamplFP("1")],
      [amplFP("18")],
    );
    await mockVault.mockMethod("token1()", [mockWampl.target]);

    // Deploy Manager contract
    const Manager = await ethers.getContractFactory("WethWamplManager");
    const manager = await Manager.deploy(
      mockVault.target,
      mockCPIOracle.target,
      mockETHOracle.target,
    );

    return {
      owner,
      addr1,
      mockVault,
      mockCPIOracle,
      mockETHOracle,
      mockWeth,
      mockWampl,
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

    it("should set the correct CPI oracle address", async function () {
      const { manager, mockCPIOracle } = await loadFixture(setupContracts);
      expect(await manager.cpiOracle()).to.eq(mockCPIOracle.target);
    });

    it("should set the correct ETH oracle address", async function () {
      const { manager, mockETHOracle } = await loadFixture(setupContracts);
      expect(await manager.ethOracle()).to.eq(mockETHOracle.target);
    });

    it("should set the token refs", async function () {
      const { manager, mockWeth, mockWampl, mockPool } = await loadFixture(
        setupContracts,
      );
      expect(await manager.POOL()).to.eq(mockPool.target);
      expect(await manager.WETH()).to.eq(mockWeth.target);
      expect(await manager.WAMPL()).to.eq(mockWampl.target);
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

  describe("#setCpiOracle", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(manager.connect(addr1).setCpiOracle(addr1.address)).to.be.revertedWith(
        "Unauthorized caller",
      );
    });

    it("should succeed when called by owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await manager.setCpiOracle(addr1.address);
      expect(await manager.cpiOracle()).to.eq(await addr1.getAddress());
    });
  });

  describe("#setEthOracle", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(manager.connect(addr1).setEthOracle(addr1.address)).to.be.revertedWith(
        "Unauthorized caller",
      );
    });

    it("should succeed when called by owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await manager.setEthOracle(addr1.address);
      expect(await manager.ethOracle()).to.eq(await addr1.getAddress());
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
      ).to.be.revertedWith("Unauthorized caller");
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
      expect(await manager.computeActiveLiqPerc(ethers.MaxUint256)).to.eq(percFP("0.2"));
    });
  });

  describe("#computeDeviationFactor", function () {
    describe("when cpi is invalid", function () {
      it("should return invalid", async function () {
        const { manager, mockETHOracle, mockCPIOracle, mockWampl } = await loadFixture(
          setupContracts,
        );
        await mockETHOracle.mockMethod("latestRoundData()", [
          0,
          ethOracleFP("3300"),
          0,
          nowTS(),
          0,
        ]);
        await mockCPIOracle.mockMethod("getData()", [amplOracleFP("1.19"), false]);
        await mockWampl.mockCall(
          "wrapperToUnderlying(uint256)",
          [wamplFP("1")],
          [amplFP("18")],
        );
        const r = await manager.computeDeviationFactor.staticCall();
        expect(r[0]).to.eq(percFP("1.051378374404781289"));
        expect(r[1]).to.eq(false);
      });
    });

    describe("when eth price is invalid", function () {
      it("should return invalid", async function () {
        const { manager, mockETHOracle, mockCPIOracle, mockWampl } = await loadFixture(
          setupContracts,
        );
        await mockETHOracle.mockMethod("latestRoundData()", [
          0,
          ethOracleFP("3300"),
          0,
          nowTS() - 86400 * 7,
          0,
        ]);
        await mockCPIOracle.mockMethod("getData()", [amplOracleFP("1.19"), true]);
        await mockWampl.mockCall(
          "wrapperToUnderlying(uint256)",
          [wamplFP("1")],
          [amplFP("18")],
        );
        const r = await manager.computeDeviationFactor.staticCall();
        expect(r[0]).to.eq(percFP("1.051378374404781289"));
        expect(r[1]).to.eq(false);
      });
    });

    it("should return deviation factor", async function () {
      const { manager, mockETHOracle, mockCPIOracle, mockWampl } = await loadFixture(
        setupContracts,
      );
      await mockETHOracle.mockMethod("latestRoundData()", [
        0,
        ethOracleFP("3300"),
        0,
        nowTS(),
        0,
      ]);
      await mockCPIOracle.mockMethod("getData()", [amplOracleFP("1.19"), true]);
      await mockWampl.mockCall(
        "wrapperToUnderlying(uint256)",
        [wamplFP("1")],
        [amplFP("18")],
      );
      const r = await manager.computeDeviationFactor.staticCall();
      expect(r[0]).to.eq(percFP("1.051378374404781289"));
      expect(r[1]).to.eq(true);
    });

    it("should return deviation factor", async function () {
      const { manager, mockETHOracle, mockCPIOracle, mockWampl } = await loadFixture(
        setupContracts,
      );
      await mockETHOracle.mockMethod("latestRoundData()", [
        0,
        ethOracleFP("3300"),
        0,
        nowTS(),
        0,
      ]);
      await mockCPIOracle.mockMethod("getData()", [amplOracleFP("1.19"), true]);
      await mockWampl.mockCall(
        "wrapperToUnderlying(uint256)",
        [wamplFP("1")],
        [amplFP("10")],
      );
      const r = await manager.computeDeviationFactor.staticCall();
      expect(r[0]).to.eq(percFP("1.892481073928606322"));
      expect(r[1]).to.eq(true);
    });

    it("should return deviation factor", async function () {
      const { manager, mockETHOracle, mockCPIOracle, mockWampl } = await loadFixture(
        setupContracts,
      );
      await mockETHOracle.mockMethod("latestRoundData()", [
        0,
        ethOracleFP("3300"),
        0,
        nowTS(),
        0,
      ]);
      await mockCPIOracle.mockMethod("getData()", [amplOracleFP("1.19"), true]);
      await mockWampl.mockCall(
        "wrapperToUnderlying(uint256)",
        [wamplFP("1")],
        [amplFP("25")],
      );
      const r = await manager.computeDeviationFactor.staticCall();
      expect(r[0]).to.eq(percFP("0.756992429571442528"));
      expect(r[1]).to.eq(true);
    });

    it("should return max deviation when price is too high", async function () {
      const { manager, mockVault, mockETHOracle, mockCPIOracle, mockWampl } =
        await loadFixture(setupContracts);
      await mockVault.mockMethod("getTwap()", [1]);
      await mockETHOracle.mockMethod("latestRoundData()", [
        0,
        ethOracleFP("3300"),
        0,
        nowTS(),
        0,
      ]);
      await mockCPIOracle.mockMethod("getData()", [amplOracleFP("1.19"), true]);
      await mockWampl.mockCall(
        "wrapperToUnderlying(uint256)",
        [wamplFP("1")],
        [amplFP("18")],
      );
      const r = await manager.computeDeviationFactor.staticCall();
      expect(r[0]).to.eq(percFP("100"));
      expect(r[1]).to.eq(true);
    });
  });

  describe("isOverweightWampl", function () {
    describe("when wampl sell", function () {
      it("should return true", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await mockVault.mockMethod("getTwap()", [30001]);
        await mockVault.mockMethod("limitLower()", [20000]);
        await mockVault.mockMethod("limitUpper()", [40000]);
        expect(await manager.isOverweightWampl()).to.eq(true);
      });
    });

    describe("when wampl buy", function () {
      it("should return false", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await mockVault.mockMethod("getTwap()", [29999]);
        await mockVault.mockMethod("limitLower()", [20000]);
        await mockVault.mockMethod("limitUpper()", [40000]);
        expect(await manager.isOverweightWampl()).to.eq(false);
      });
    });
  });

  describe("#rebalance", function () {
    describe("when activePercDelta is within threshold", function () {
      describe("when deviation is < 1 and goes > 1", function () {
        describe("when overweight wampl", function () {
          it("should trim liquidity & keep limit range", async function () {
            const { manager, mockVault } = await loadFixture(setupContracts);
            await manager.setActivePercParams(
              percFP("1"),
              [percFP("0.5"), percFP("0.2"), percFP("1"), percFP("1")],
              [percFP("1"), percFP("1"), percFP("2"), percFP("0.2")],
            );

            await mockVault.mockMethod("getTwap()", [49500]);
            await mockVault.mockMethod("limitLower()", [40000]);
            await mockVault.mockMethod("limitUpper()", [45000]);
            await mockVault.mockMethod("period()", [86400]);
            await mockVault.mockCall("setPeriod(uint32)", [0], []);
            await mockVault.mockCall("setPeriod(uint32)", [86400], []);
            await mockVault.mockMethod("rebalance()", []);

            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [-800000, 800000, 7324],
              [],
            );
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [45000, 55000, 1464],
              [],
            );

            expect(await manager.prevDeviation()).to.eq("0");
            expect(await manager.isOverweightWampl()).to.eq(true);
            await expect(manager.rebalance()).not.to.be.reverted;
            expect(await manager.prevDeviation()).to.eq(percFP("1.091551595254704898"));
          });
        });

        describe("when overweight weth", function () {
          it("should trim liquidity & remove limit range", async function () {
            const { manager, mockVault, mockPool } = await loadFixture(setupContracts);
            await manager.setActivePercParams(
              percFP("1"),
              [percFP("0.5"), percFP("0.2"), percFP("1"), percFP("1")],
              [percFP("1"), percFP("1"), percFP("2"), percFP("0.2")],
            );

            await mockVault.mockMethod("getTwap()", [49500]);
            await mockVault.mockMethod("limitLower()", [50000]);
            await mockVault.mockMethod("limitUpper()", [55000]);
            await mockPool.mockCall(
              "positions(bytes32)",
              [univ3PositionKey(mockVault.target, 50000, 55000)],
              [50000, 0, 0, 0, 0],
            );

            await mockVault.mockMethod("period()", [86400]);
            await mockVault.mockCall("setPeriod(uint32)", [0], []);
            await mockVault.mockCall("setPeriod(uint32)", [86400], []);
            await mockVault.mockMethod("rebalance()", []);

            await mockVault.clearMockMethod("emergencyBurn(int24,int24,uint128)");
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [-800000, 800000, 7324],
              [],
            );
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [45000, 55000, 1464],
              [],
            );
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [50000, 55000, 50000],
              [],
            );

            expect(await manager.prevDeviation()).to.eq("0");
            expect(await manager.isOverweightWampl()).to.eq(false);
            await expect(manager.rebalance()).not.to.be.reverted;
            expect(await manager.prevDeviation()).to.eq(percFP("1.091551595254704898"));
          });
        });
      });

      describe("when deviation is > 1 and goes < 1", function () {
        describe("when overweight wampl", function () {
          it("should trim liquidity & remove limit range", async function () {
            const { manager, mockVault, mockPool } = await loadFixture(setupContracts);
            await manager.setActivePercParams(
              percFP("1"),
              [percFP("0.5"), percFP("0.2"), percFP("1"), percFP("1")],
              [percFP("1"), percFP("1"), percFP("2"), percFP("0.2")],
            );

            await mockVault.mockMethod("getTwap()", [49500]);
            await mockVault.mockMethod("limitLower()", [40000]);
            await mockVault.mockMethod("limitUpper()", [45000]);
            await mockVault.mockMethod("period()", [86400]);
            await mockVault.mockCall("setPeriod(uint32)", [0], []);
            await mockVault.mockCall("setPeriod(uint32)", [86400], []);
            await mockVault.mockMethod("rebalance()", []);
            await mockVault.mockMethod("emergencyBurn(int24,int24,uint128)", []);
            await manager.rebalance();

            await mockVault.mockMethod("getTwap()", [52000]);
            await mockVault.mockMethod("limitLower()", [50000]);
            await mockVault.mockMethod("limitUpper()", [51000]);
            await mockPool.mockCall(
              "positions(bytes32)",
              [univ3PositionKey(mockVault.target, 50000, 51000)],
              [50000, 0, 0, 0, 0],
            );

            await mockVault.clearMockMethod("emergencyBurn(int24,int24,uint128)");
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [-800000, 800000, 23982],
              [],
            );
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [45000, 55000, 4796],
              [],
            );
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [50000, 51000, 50000],
              [],
            );

            expect(await manager.prevDeviation()).to.eq(percFP("1.091551595254704898"));
            expect(await manager.isOverweightWampl()).to.eq(true);
            await expect(manager.rebalance()).not.to.be.reverted;
            expect(await manager.prevDeviation()).to.eq(percFP("0.850111862770710708"));
          });
        });

        describe("when overweight weth", function () {
          it("should trim liquidity & keep limit range", async function () {
            const { manager, mockVault } = await loadFixture(setupContracts);
            await manager.setActivePercParams(
              percFP("1"),
              [percFP("0.5"), percFP("0.2"), percFP("1"), percFP("1")],
              [percFP("1"), percFP("1"), percFP("2"), percFP("0.2")],
            );

            await mockVault.mockMethod("getTwap()", [49500]);
            await mockVault.mockMethod("limitLower()", [40000]);
            await mockVault.mockMethod("limitUpper()", [45000]);
            await mockVault.mockMethod("period()", [86400]);
            await mockVault.mockCall("setPeriod(uint32)", [0], []);
            await mockVault.mockCall("setPeriod(uint32)", [86400], []);
            await mockVault.mockMethod("rebalance()", []);
            await mockVault.mockMethod("emergencyBurn(int24,int24,uint128)", []);
            await manager.rebalance();

            await mockVault.mockMethod("getTwap()", [52000]);
            await mockVault.mockMethod("limitLower()", [53000]);
            await mockVault.mockMethod("limitUpper()", [55000]);

            await mockVault.clearMockMethod("emergencyBurn(int24,int24,uint128)");
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [-800000, 800000, 23982],
              [],
            );
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [45000, 55000, 4796],
              [],
            );

            expect(await manager.prevDeviation()).to.eq(percFP("1.091551595254704898"));
            expect(await manager.isOverweightWampl()).to.eq(false);
            await expect(manager.rebalance()).not.to.be.reverted;
            expect(await manager.prevDeviation()).to.eq(percFP("0.850111862770710708"));
          });
        });
      });
    });

    describe("when activePercDelta is outside threshold", function () {
      describe("when deviation is < 1 and goes > 1", function () {
        describe("when overweight wampl", function () {
          it("should trim liquidity & keep limit range", async function () {
            const { manager, mockVault } = await loadFixture(setupContracts);

            await mockVault.mockMethod("getTwap()", [49500]);
            await mockVault.mockMethod("limitLower()", [40000]);
            await mockVault.mockMethod("limitUpper()", [45000]);
            await mockVault.mockMethod("period()", [86400]);
            await mockVault.mockCall("setPeriod(uint32)", [0], []);
            await mockVault.mockCall("setPeriod(uint32)", [86400], []);
            await mockVault.mockMethod("rebalance()", []);

            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [-800000, 800000, 7324],
              [],
            );
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [45000, 55000, 1464],
              [],
            );

            expect(await manager.prevDeviation()).to.eq("0");
            expect(await manager.isOverweightWampl()).to.eq(true);
            await expect(manager.rebalance()).not.to.be.reverted;
            expect(await manager.prevDeviation()).to.eq(percFP("1.091551595254704898"));
          });
        });

        describe("when overweight weth", function () {
          it("should trim liquidity & remove limit range", async function () {
            const { manager, mockVault, mockPool } = await loadFixture(setupContracts);

            await mockVault.mockMethod("getTwap()", [49500]);
            await mockVault.mockMethod("limitLower()", [50000]);
            await mockVault.mockMethod("limitUpper()", [55000]);
            await mockPool.mockCall(
              "positions(bytes32)",
              [univ3PositionKey(mockVault.target, 50000, 55000)],
              [50000, 0, 0, 0, 0],
            );

            await mockVault.mockMethod("period()", [86400]);
            await mockVault.mockCall("setPeriod(uint32)", [0], []);
            await mockVault.mockCall("setPeriod(uint32)", [86400], []);
            await mockVault.mockMethod("rebalance()", []);

            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [-800000, 800000, 7324],
              [],
            );
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [45000, 55000, 1464],
              [],
            );
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [50000, 55000, 50000],
              [],
            );

            expect(await manager.prevDeviation()).to.eq("0");
            expect(await manager.isOverweightWampl()).to.eq(false);
            await expect(manager.rebalance()).not.to.be.reverted;
            expect(await manager.prevDeviation()).to.eq(percFP("1.091551595254704898"));
          });
        });
      });

      describe("when deviation is > 1 and goes < 1", function () {
        describe("when overweight wampl", function () {
          it("should trim liquidity & remove limit range", async function () {
            const { manager, mockVault, mockPool } = await loadFixture(setupContracts);

            await mockVault.mockMethod("getTwap()", [49500]);
            await mockVault.mockMethod("limitLower()", [40000]);
            await mockVault.mockMethod("limitUpper()", [45000]);
            await mockVault.mockMethod("period()", [86400]);
            await mockVault.mockCall("setPeriod(uint32)", [0], []);
            await mockVault.mockCall("setPeriod(uint32)", [86400], []);
            await mockVault.mockMethod("rebalance()", []);
            await mockVault.mockMethod("emergencyBurn(int24,int24,uint128)", []);
            await manager.rebalance();

            await mockVault.mockMethod("getTwap()", [52000]);
            await mockVault.mockMethod("limitLower()", [50000]);
            await mockVault.mockMethod("limitUpper()", [51000]);
            await mockPool.mockCall(
              "positions(bytes32)",
              [univ3PositionKey(mockVault.target, 50000, 51000)],
              [50000, 0, 0, 0, 0],
            );
            await mockVault.clearMockMethod("emergencyBurn(int24,int24,uint128)");
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [-800000, 800000, 23982],
              [],
            );
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [45000, 55000, 4796],
              [],
            );
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [50000, 51000, 50000],
              [],
            );

            expect(await manager.prevDeviation()).to.eq(percFP("1.091551595254704898"));
            expect(await manager.isOverweightWampl()).to.eq(true);
            await expect(manager.rebalance()).not.to.be.reverted;
            expect(await manager.prevDeviation()).to.eq(percFP("0.850111862770710708"));
          });
        });

        describe("when overweight weth", function () {
          it("should trim liquidity & keep limit range", async function () {
            const { manager, mockVault } = await loadFixture(setupContracts);

            await mockVault.mockMethod("getTwap()", [49500]);
            await mockVault.mockMethod("limitLower()", [40000]);
            await mockVault.mockMethod("limitUpper()", [45000]);
            await mockVault.mockMethod("period()", [86400]);
            await mockVault.mockCall("setPeriod(uint32)", [0], []);
            await mockVault.mockCall("setPeriod(uint32)", [86400], []);
            await mockVault.mockMethod("rebalance()", []);
            await mockVault.mockMethod("emergencyBurn(int24,int24,uint128)", []);
            await manager.rebalance();

            await mockVault.mockMethod("getTwap()", [52000]);
            await mockVault.mockMethod("limitLower()", [53000]);
            await mockVault.mockMethod("limitUpper()", [55000]);

            await mockVault.clearMockMethod("emergencyBurn(int24,int24,uint128)");
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [-800000, 800000, 23982],
              [],
            );
            await mockVault.mockCall(
              "emergencyBurn(int24,int24,uint128)",
              [45000, 55000, 4796],
              [],
            );

            expect(await manager.prevDeviation()).to.eq(percFP("1.091551595254704898"));
            expect(await manager.isOverweightWampl()).to.eq(false);
            await expect(manager.rebalance()).not.to.be.reverted;
            expect(await manager.prevDeviation()).to.eq(percFP("0.850111862770710708"));
          });
        });
      });
    });

    describe("when deviation remains below 1", function () {
      describe("when overweight wampl", function () {
        it("should not force rebalance", async function () {
          const { manager, mockVault, mockPool } = await loadFixture(setupContracts);
          await manager.setActivePercParams(
            percFP("1"),
            [percFP("0.5"), percFP("0.2"), percFP("1"), percFP("1")],
            [percFP("1"), percFP("1"), percFP("2"), percFP("0.2")],
          );

          await mockVault.mockMethod("getTwap()", [51500]);
          await mockVault.mockMethod("limitLower()", [40000]);
          await mockVault.mockMethod("limitUpper()", [45000]);
          await mockPool.mockCall(
            "positions(bytes32)",
            [univ3PositionKey(mockVault.target, 40000, 45000)],
            [50000, 0, 0, 0, 0],
          );
          await mockVault.mockMethod("rebalance()", []);
          await mockVault.mockMethod("emergencyBurn(int24,int24,uint128)", []);

          expect(await manager.prevDeviation()).to.eq("0");
          expect(await manager.isOverweightWampl()).to.eq(true);
          await expect(manager.rebalance()).not.to.be.reverted;
          expect(await manager.prevDeviation()).to.eq(percFP("0.893695795923885030"));
        });
      });
    });

    describe("when deviation remains above 1", function () {
      describe("when overweight weth", function () {
        it("should not force rebalance", async function () {
          const { manager, mockVault, mockPool } = await loadFixture(setupContracts);
          await manager.setActivePercParams(
            percFP("1"),
            [percFP("0.5"), percFP("0.2"), percFP("1"), percFP("1")],
            [percFP("1"), percFP("1"), percFP("2"), percFP("0.2")],
          );

          await mockVault.mockMethod("getTwap()", [49500]);
          await mockVault.mockMethod("limitLower()", [40000]);
          await mockVault.mockMethod("limitUpper()", [45000]);
          await mockVault.mockMethod("period()", [86400]);
          await mockVault.mockCall("setPeriod(uint32)", [0], []);
          await mockVault.mockCall("setPeriod(uint32)", [86400], []);
          await mockVault.mockMethod("rebalance()", []);
          await mockVault.mockMethod("emergencyBurn(int24,int24,uint128)", []);
          await manager.rebalance();

          await mockVault.clearMockCall("setPeriod(uint32)", [0]);
          await mockVault.clearMockCall("setPeriod(uint32)", [86400]);
          await mockVault.clearMockCall("period()", []);
          await mockVault.clearMockMethod("emergencyBurn(int24,int24,uint128)");

          await mockVault.mockMethod("getTwap()", [50000]);
          await mockVault.mockMethod("limitLower()", [53000]);
          await mockVault.mockMethod("limitUpper()", [55000]);
          await mockPool.mockCall(
            "positions(bytes32)",
            [univ3PositionKey(mockVault.target, 53000, 55000)],
            [50000, 0, 0, 0, 0],
          );
          await mockVault.mockMethod("emergencyBurn(int24,int24,uint128)", []);

          expect(await manager.prevDeviation()).to.eq(percFP("1.091551595254704898"));
          expect(await manager.isOverweightWampl()).to.eq(false);
          await expect(manager.rebalance()).not.to.be.reverted;
          expect(await manager.prevDeviation()).to.eq(percFP("1.038318591387163286"));
        });
      });
    });
  });
});
