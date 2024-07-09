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
    await mockVault.mockMethod("fullLower()", [-887200]);
    await mockVault.mockMethod("fullUpper()", [887200]);
    await mockVault.mockMethod("baseLower()", [45000]);
    await mockVault.mockMethod("baseUpper()", [55000]);
    await mockVault.mockMethod("getTwap()", [49875]);

    const mockPool = new DMock("IUniswapV3Pool");
    await mockPool.deploy();
    await mockPool.mockCall(
      "positions(bytes32)",
      [univ3PositionKey(mockVault.target, -887200, 887200)],
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
      expect(await manager.owner()).to.equal(await owner.getAddress());
    });

    it("should set the correct vault address", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      expect(await manager.VAULT()).to.equal(mockVault.target);
    });

    it("should set the correct CPI oracle address", async function () {
      const { manager, mockCPIOracle } = await loadFixture(setupContracts);
      expect(await manager.cpiOracle()).to.equal(mockCPIOracle.target);
    });

    it("should set the correct ETH oracle address", async function () {
      const { manager, mockETHOracle } = await loadFixture(setupContracts);
      expect(await manager.ethOracle()).to.equal(mockETHOracle.target);
    });

    it("should set the token refs", async function () {
      const { manager, mockWeth, mockWampl, mockPool } = await loadFixture(
        setupContracts,
      );
      expect(await manager.POOL()).to.equal(mockPool.target);
      expect(await manager.WETH()).to.equal(mockWeth.target);
      expect(await manager.WAMPL()).to.equal(mockWampl.target);
    });

    it("should set the active perc calculation params", async function () {
      const { manager } = await loadFixture(setupContracts);
      expect(await manager.deviationCutoff()).to.equal(percFP("1"));
      expect(await manager.lastActiveLiqPerc()).to.equal(percFP("1"));
      expect(await manager.tolerableActiveLiqPercDelta()).to.equal(percFP("0.1"));

      const f1 = await manager.activeLiqPercFn1();
      expect(f1[0]).to.equal(percFP("0.7"));
      expect(f1[1]).to.equal(percFP("0.25"));
      expect(f1[2]).to.equal(percFP("0.95"));
      expect(f1[3]).to.equal(percFP("1"));

      const f2 = await manager.activeLiqPercFn2();
      expect(f2[0]).to.equal(percFP("1.2"));
      expect(f2[1]).to.equal(percFP("1"));
      expect(f2[2]).to.equal(percFP("2.5"));
      expect(f2[3]).to.equal(percFP("0.25"));
    });

    it("should set the limit threshold params", async function () {
      const { manager } = await loadFixture(setupContracts);
      expect(await manager.limitThresholdNarrow()).to.equal(3200);
      expect(await manager.limitThresholdWide()).to.equal(887200);
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
      expect(await manager.owner()).to.equal(await addr1.getAddress());
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
      expect(await manager.cpiOracle()).to.equal(await addr1.getAddress());
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
      expect(await manager.ethOracle()).to.equal(await addr1.getAddress());
    });
  });

  describe("#setActivePercParams", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(
        manager
          .connect(addr1)
          .setActivePercParams(
            percFP("1.05"),
            percFP("0.05"),
            [percFP("0.5"), percFP("0.05"), percFP("1.05"), percFP("1")],
            [percFP("1.1"), percFP("1"), percFP("2"), percFP("0.1")],
          ),
      ).to.be.revertedWith("Unauthorized caller");
    });

    it("should succeed when called by owner", async function () {
      const { manager } = await loadFixture(setupContracts);
      await manager.setActivePercParams(
        percFP("1.05"),
        percFP("0.1"),
        [percFP("0.5"), percFP("0.05"), percFP("1.05"), percFP("1")],
        [percFP("1.1"), percFP("1"), percFP("2"), percFP("0.1")],
      );

      expect(await manager.deviationCutoff()).to.equal(percFP("1.05"));
      expect(await manager.tolerableActiveLiqPercDelta()).to.equal(percFP("0.1"));

      const f1 = await manager.activeLiqPercFn1();
      expect(f1[0]).to.equal(percFP("0.5"));
      expect(f1[1]).to.equal(percFP("0.05"));
      expect(f1[2]).to.equal(percFP("1.05"));
      expect(f1[3]).to.equal(percFP("1"));

      const f2 = await manager.activeLiqPercFn2();
      expect(f2[0]).to.equal(percFP("1.1"));
      expect(f2[1]).to.equal(percFP("1"));
      expect(f2[2]).to.equal(percFP("2"));
      expect(f2[3]).to.equal(percFP("0.1"));
    });
  });

  describe("#setLiquidityRanges", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(
        manager.connect(addr1).setLiquidityRanges(7200, 330000, 1200, 100000),
      ).to.be.revertedWith("Unauthorized caller");
    });

    it("should succeed when called by owner", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      await mockVault.mockCall("setBaseThreshold(int24)", [7200], []);
      await mockVault.mockCall("setFullRangeWeight(uint24)", [330000], []);
      await mockVault.mockCall("setLimitThreshold(int24)", [100000], []);
      await manager.setLiquidityRanges(7200, 330000, 1200, 100000);
      expect(await manager.limitThresholdNarrow()).to.equal(1200);
      expect(await manager.limitThresholdWide()).to.equal(100000);
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
      expect(await manager.computeActiveLiqPerc(percFP("0"))).to.eq(percFP("0.25"));
      expect(await manager.computeActiveLiqPerc(percFP("0.5"))).to.eq(percFP("0.25"));
      expect(await manager.computeActiveLiqPerc(percFP("0.73888888"))).to.eq(
        percFP("0.36666664"),
      );
      expect(await manager.computeActiveLiqPerc(percFP("0.7425"))).to.eq(
        percFP("0.3775"),
      );
      expect(await manager.computeActiveLiqPerc(percFP("0.75"))).to.eq(percFP("0.4"));
      expect(await manager.computeActiveLiqPerc(percFP("0.8"))).to.eq(percFP("0.55"));
      expect(await manager.computeActiveLiqPerc(percFP("0.85"))).to.eq(percFP("0.7"));
      expect(await manager.computeActiveLiqPerc(percFP("0.9"))).to.eq(percFP("0.85"));
      expect(await manager.computeActiveLiqPerc(percFP("0.95"))).to.eq(percFP("1"));
      expect(await manager.computeActiveLiqPerc(percFP("1"))).to.eq(percFP("1"));
      expect(await manager.computeActiveLiqPerc(percFP("1.05"))).to.eq(percFP("1"));
      expect(await manager.computeActiveLiqPerc(percFP("1.1"))).to.eq(percFP("1"));
      expect(await manager.computeActiveLiqPerc(percFP("1.2"))).to.eq(percFP("1"));
      expect(await manager.computeActiveLiqPerc(percFP("1.3"))).to.eq(
        percFP("0.942307692307692307"),
      );
      expect(await manager.computeActiveLiqPerc(percFP("1.5"))).to.eq(
        percFP("0.826923076923076923"),
      );
      expect(await manager.computeActiveLiqPerc(percFP("1.75"))).to.eq(
        percFP("0.682692307692307692"),
      );
      expect(await manager.computeActiveLiqPerc(percFP("2"))).to.eq(
        percFP("0.538461538461538461"),
      );
      expect(await manager.computeActiveLiqPerc(percFP("2.25"))).to.eq(
        percFP("0.394230769230769230"),
      );
      expect(await manager.computeActiveLiqPerc(percFP("2.5"))).to.eq(percFP("0.25"));
      expect(await manager.computeActiveLiqPerc(percFP("5"))).to.eq(percFP("0.25"));
      expect(await manager.computeActiveLiqPerc(percFP("10"))).to.eq(percFP("0.25"));
      expect(await manager.computeActiveLiqPerc(percFP("100000"))).to.eq(percFP("0.25"));
      expect(await manager.computeActiveLiqPerc(ethers.MaxUint256)).to.eq(percFP("0.25"));
    });
  });

  describe("#computeDeviationFactor", function () {
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
      expect(await manager.computeDeviationFactor.staticCall()).to.eq(
        percFP("1.051378374404781289"),
      );
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
      expect(await manager.computeDeviationFactor.staticCall()).to.eq(
        percFP("1.892481073928606322"),
      );
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
      expect(await manager.computeDeviationFactor.staticCall()).to.eq(
        percFP("0.756992429571442528"),
      );
    });

    it("should return 0 if eth price is invalid", async function () {
      const { manager, mockETHOracle, mockCPIOracle, mockWampl } = await loadFixture(
        setupContracts,
      );
      await mockETHOracle.mockMethod("latestRoundData()", [
        0,
        ethOracleFP("3300"),
        0,
        nowTS() - 86400 * 2,
        0,
      ]);
      await mockCPIOracle.mockMethod("getData()", [amplOracleFP("1.19"), true]);
      await mockWampl.mockCall(
        "wrapperToUnderlying(uint256)",
        [wamplFP("1")],
        [amplFP("18")],
      );
      expect(await manager.computeDeviationFactor.staticCall()).to.eq("0");
    });

    it("should return 0 if cpi target is invalid", async function () {
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
      expect(await manager.computeDeviationFactor.staticCall()).to.eq("0");
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
      expect(await manager.computeDeviationFactor.staticCall()).to.eq(percFP("100"));
    });
  });

  describe("inNarrowLimitRange", function () {
    describe("when wampl sell, dr > 1", function () {
      it("should return true", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await mockVault.mockMethod("getTwap()", [30001]);
        await mockVault.mockMethod("limitLower()", [20000]);
        await mockVault.mockMethod("limitUpper()", [40000]);
        expect(await manager.inNarrowLimitRange(percFP("1.1"))).to.eq(true);
      });
    });

    describe("when wampl sell, dr < 1", function () {
      it("should return false", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await mockVault.mockMethod("getTwap()", [30001]);
        await mockVault.mockMethod("limitLower()", [20000]);
        await mockVault.mockMethod("limitUpper()", [40000]);
        expect(await manager.inNarrowLimitRange(percFP("0.9"))).to.eq(false);
      });
    });

    describe("when wampl buy, dr > 1", function () {
      it("should return true", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await mockVault.mockMethod("getTwap()", [29999]);
        await mockVault.mockMethod("limitLower()", [20000]);
        await mockVault.mockMethod("limitUpper()", [40000]);
        expect(await manager.inNarrowLimitRange(percFP("1.1"))).to.eq(false);
      });
    });

    describe("when wampl buy, dr < 1", function () {
      it("should return true", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await mockVault.mockMethod("getTwap()", [29999]);
        await mockVault.mockMethod("limitLower()", [20000]);
        await mockVault.mockMethod("limitUpper()", [40000]);
        expect(await manager.inNarrowLimitRange(percFP("0.9"))).to.eq(true);
      });
    });
  });

  describe("#rebalance", function () {
    describe("when in narrow range", function () {
      it("should update the limit threshold", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await mockVault.mockMethod("limitLower()", [45000]);
        await mockVault.mockMethod("limitUpper()", [50000]);
        await mockVault.mockMethod("rebalance()", []);
        await mockVault.mockCall("setLimitThreshold(int24)", [3200], []);
        await mockVault.mockMethod("emergencyBurn(int24,int24,uint128)", []);
        await expect(manager.rebalance()).not.to.be.reverted;
      });
    });

    describe("when in wide range", function () {
      it("should update the limit threshold", async function () {
        const { manager, mockVault } = await loadFixture(setupContracts);
        await mockVault.mockMethod("limitLower()", [55000]);
        await mockVault.mockMethod("limitUpper()", [60000]);
        await mockVault.mockMethod("rebalance()", []);
        await mockVault.mockCall("setLimitThreshold(int24)", [887200], []);
        await mockVault.mockMethod("emergencyBurn(int24,int24,uint128)", []);
        await expect(manager.rebalance()).not.to.be.reverted;
      });
    });

    describe("when outside active perc threshold", function () {
      it("should exec force rebalance", async function () {
        const { manager, mockVault, mockCPIOracle } = await loadFixture(setupContracts);
        await mockVault.mockMethod("limitLower()", [45000]);
        await mockVault.mockMethod("limitUpper()", [50000]);
        await mockVault.mockCall("setLimitThreshold(int24)", [887200], []);
        await mockCPIOracle.mockMethod("getData()", [amplOracleFP("1.5"), true]);
        await mockVault.mockMethod("emergencyBurn(int24,int24,uint128)", []);
        await mockVault.mockMethod("period()", [86400]);
        await mockVault.mockCall("setPeriod(uint32)", [0], []);
        await mockVault.mockCall("setPeriod(uint32)", [86400], []);
        await mockVault.mockMethod("rebalance()", []);
        await expect(manager.rebalance()).not.to.be.reverted;
      });
    });

    describe("when inside active perc threshold", function () {
      it("should exec rebalance", async function () {
        const { manager, mockVault, mockCPIOracle } = await loadFixture(setupContracts);
        await mockVault.mockMethod("limitLower()", [45000]);
        await mockVault.mockMethod("limitUpper()", [50000]);
        await mockVault.mockCall("setLimitThreshold(int24)", [887200], []);
        await mockCPIOracle.mockMethod("getData()", [amplOracleFP("1.35"), true]);
        await mockVault.mockMethod("emergencyBurn(int24,int24,uint128)", []);
        await mockVault.mockMethod("rebalance()", []);
        await expect(manager.rebalance()).not.to.be.reverted;
      });
    });

    it("should trim liquidity", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      await mockVault.mockMethod("limitLower()", [45000]);
      await mockVault.mockMethod("limitUpper()", [55000]);
      await mockVault.mockCall("setLimitThreshold(int24)", [887200], []);
      await mockVault.mockMethod("getTwap()", [47500]);
      await mockVault.mockMethod("rebalance()", []);
      // activePerc = ~0.92
      await mockVault.mockCall(
        "emergencyBurn(int24,int24,uint128)",
        [-887200, 887200, 7685],
        [],
      );
      await mockVault.mockCall(
        "emergencyBurn(int24,int24,uint128)",
        [45000, 55000, 1537],
        [],
      );
      await expect(manager.rebalance()).not.to.be.reverted;
    });

    it("should update the active perc", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      await mockVault.mockMethod("limitLower()", [45000]);
      await mockVault.mockMethod("limitUpper()", [55000]);
      await mockVault.mockCall("setLimitThreshold(int24)", [887200], []);
      await mockVault.mockMethod("getTwap()", [47500]);
      await mockVault.mockMethod("rebalance()", []);
      await mockVault.mockMethod("emergencyBurn(int24,int24,uint128)", []);
      await expect(manager.rebalance()).not.to.be.reverted;
      expect(await manager.lastActiveLiqPerc()).to.eq(percFP("0.923147616635188312"));
    });
  });
});
