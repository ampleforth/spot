import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, sciParseFloat, univ3PositionKey } from "./helpers";

export const ONE = ethers.parseUnits("1", 18);
export const percFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);
export const amplFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 9);
export const wamplFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);
// export const usdcFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 6);
export const amplOracleFP = (a: string): BigInt =>
  ethers.parseUnits(sciParseFloat(a), 18);
export const usdcOracleFP = (a: string): BigInt => ethers.parseUnits(sciParseFloat(a), 18);
const nowTS = () => parseInt(Date.now() / 1000);

describe("UsdcWamplManager", function () {
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
    await mockVault.mockMethod("getTwap()", [244800]);
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

    const mockUsdcOracle = new DMock("IChainlinkOracle");
    await mockUsdcOracle.deploy();
    await mockUsdcOracle.mockMethod("decimals()", [18]);
    await mockUsdcOracle.mockMethod("latestRoundData()", [
      0,
      usdcOracleFP("1.00"),
      0,
      nowTS(),
      0,
    ]);

    const mockUsdc = new DMock("IERC20Upgradeable");
    await mockUsdc.deploy();
    await mockVault.mockMethod("token0()", [mockUsdc.target]);

    const mockWampl = new DMock("IWAMPL");
    await mockWampl.deploy();
    await mockWampl.mockCall(
      "wrapperToUnderlying(uint256)",
      [wamplFP("1")],
      [amplFP("18")],
    );
    await mockVault.mockMethod("token1()", [mockWampl.target]);

    // Deploy Manager contract
    const Manager = await ethers.getContractFactory("UsdcWamplManager");
    const manager = await Manager.deploy(
      mockVault.target,
      mockCPIOracle.target,
      mockUsdcOracle.target,
    );

    return {
      owner,
      addr1,
      mockVault,
      mockCPIOracle,
      mockUsdcOracle,
      mockUsdc,
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

    it("should set the correct USDC oracle address", async function () {
      const { manager, mockUsdcOracle } = await loadFixture(setupContracts);
      expect(await manager.usdcOracle()).to.eq(mockUsdcOracle.target);
    });

    it("should set the correct token refs", async function () {
      const { manager, mockUsdc, mockWampl, mockPool } = await loadFixture(
        setupContracts,
      );
      expect(await manager.POOL()).to.eq(mockPool.target)
      expect(await manager.USDC()).to.eq(mockUsdc.target);
      expect(await manager.WAMPL()).to.eq(mockWampl.target);
    });

    it("should set the active perc calculation params", async function () {
      const { manager } = await loadFixture(setupContracts);
      expect(await manager.prevDeviation()).to.eq(percFP("0"));
      expect(await manager.tolerableActiveLiqPercDelta()).to.eq(percFP("0.1"));
      expect(await manager.MIN_ACTIVE_LIQ_PERC()).to.eq(percFP("0.2"));
      expect(await manager.MAX_DEVIATION()).to.eq(percFP("100"));
      expect(await manager.CL_ORACLE_STALENESS_THRESHOLD_SEC()).to.eq(3600 * 24);
      expect(await manager.USD_UPPER_BOUND()).to.eq(percFP("1.01"));
      expect(await manager.USD_LOWER_BOUND()).to.eq(percFP("0.99"));

      const f1 = await manager.activeLiqPercFn1();
      expect(f1.x1).to.eq(percFP("0.5"));
      expect(f1.y1).to.eq(percFP("0.2"));
      expect(f1.x2).to.eq(ONE);
      expect(f1.y2).to.eq(ONE);

      const f2 = await manager.activeLiqPercFn2();
      expect(f2.x1).to.eq(ONE);
      expect(f2.y1).to.eq(ONE);
      expect(f2.x2).to.eq(percFP("2"));
      expect(f2.y2).to.eq(percFP("0.2"));
    });

    it("should return the decimals", async function () {
      const { manager } = await loadFixture(setupContracts);
      expect(await manager.decimals()).to.eq(18);
    });

    it("should set AMPL and WAMPL constants", async function () {
      const { manager } = await loadFixture(setupContracts);
      expect(await manager.ONE_AMPL()).to.eq(ethers.parseUnits("1", 9));
      expect(await manager.ONE_WAMPL()).to.eq(ethers.parseUnits("1", 18));
      expect(await manager.ONE_USDC()).to.eq(ethers.parseUnits("1", 6));
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

  describe("#setUsdcOracle", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(manager.connect(addr1).setUsdcOracle(addr1.address)).to.be.revertedWith(
        "Unauthorized caller",
      );
    });

    it("should succeed when called by owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await manager.setUsdcOracle(addr1.address);
      expect(await manager.usdcOracle()).to.eq(await addr1.getAddress());
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
            { x1: percFP("0.5"), y1: percFP("0.2"), x2: ONE, y2: ONE },
            { x1: ONE, y1: ONE, x2: percFP("2"), y2: percFP("0.2") },
          ),
      ).to.be.revertedWith("Unauthorized caller");
    });

    it("should succeed when called by owner", async function () {
      const { manager } = await loadFixture(setupContracts);
      const newDelta = percFP("0.15");
      const newFn1 = { x1: percFP("0.6"), y1: percFP("0.3"), x2: ONE, y2: percFP("0.9") };
      const newFn2 = { x1: ONE, y1: percFP("0.9"), x2: percFP("1.5"), y2: percFP("0.1") };

      await manager.setActivePercParams(newDelta, newFn1, newFn2);

      expect(await manager.tolerableActiveLiqPercDelta()).to.eq(newDelta);

      const f1 = await manager.activeLiqPercFn1();
      expect(f1.x1).to.eq(newFn1.x1);
      expect(f1.y1).to.eq(newFn1.y1);
      expect(f1.x2).to.eq(newFn1.x2);
      expect(f1.y2).to.eq(newFn1.y2);

      const f2 = await manager.activeLiqPercFn2();
      expect(f2.x1).to.eq(newFn2.x1);
      expect(f2.y1).to.eq(newFn2.y1);
      expect(f2.x2).to.eq(newFn2.x2);
      expect(f2.y2).to.eq(newFn2.y2);
    });
  });

  describe("#setLiquidityRanges", function () {
    it("should fail to when called by non-owner", async function () {
      const { manager, addr1, mockVault } = await loadFixture(setupContracts);
      await expect(
        manager.connect(addr1).setLiquidityRanges(7200, 330000, 1200),
      ).to.be.revertedWith("Unauthorized caller");
      expect(await mockVault.mockCall["setBaseThreshold(int24)"]).to.be.undefined;
      expect(await mockVault.mockCall["setFullRangeWeight(uint24)"]).to.be.undefined;
      expect(await mockVault.mockCall["setLimitThreshold(int24)"]).to.be.undefined;
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
      await expect(manager.connect(addr1).execOnVault(mockVault.refFactory.interface.encodeFunctionData("acceptManager"))).to.be.revertedWith(
        "Unauthorized caller",
      );
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
        const { manager, mockUsdcOracle, mockCPIOracle, mockWampl } = await loadFixture(
          setupContracts,
        );
        await mockUsdcOracle.mockMethod("latestRoundData()", [
          0,
          usdcOracleFP("1.00"),
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
        expect(r[0]).to.eq(percFP("1.091900700280112044"));
        expect(r[1]).to.eq(false);
      });
    });

    describe("when usdc price is invalid", function () {
      it("should return invalid", async function () {
        const { manager, mockUsdcOracle, mockCPIOracle, mockWampl } = await loadFixture(
          setupContracts,
        );
        await mockUsdcOracle.mockMethod("latestRoundData()", [
          0,
          usdcOracleFP("1.25"),
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
        expect(r[0]).to.eq(percFP("1.091900700280112044"));
        expect(r[1]).to.eq(false);
      });
    });

    it("should return deviation factor", async function () {
      const { manager, mockUsdcOracle, mockCPIOracle, mockWampl } = await loadFixture(
        setupContracts,
      );
      await mockUsdcOracle.mockMethod("latestRoundData()", [
        0,
        usdcOracleFP("1.0"),
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
      // // test
      //   const amplPrice = await manager.getAmplUSDPrice.staticCall();
      //   const wamplPrice = await manager.getWamplUSDPrice.staticCall();
      //   const usdcPrice = await manager.getUSDCPrice.staticCall();
      //   console.log({amplPrice, wamplPrice, usdcPrice})
      //   //
      const r = await manager.computeDeviationFactor.staticCall();
      expect(r[0]).to.eq(percFP("1.091900700280112044"));
      expect(r[1]).to.eq(true);
    });

    it("should return deviation factor", async function () {
      const { manager, mockUsdcOracle, mockCPIOracle, mockWampl } = await loadFixture(
        setupContracts,
      );
      await mockUsdcOracle.mockMethod("latestRoundData()", [
        0,
        usdcOracleFP("1.0"),
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
      expect(r[0]).to.eq(percFP("1.965421260504201680"));
      expect(r[1]).to.eq(true);
    });

    it("should return deviation factor", async function () {
      const { manager, mockUsdcOracle, mockCPIOracle, mockWampl } = await loadFixture(
        setupContracts,
      );
      await mockUsdcOracle.mockMethod("latestRoundData()", [
        0,
        usdcOracleFP("1.0"),
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
      expect(r[0]).to.eq(percFP("0.786168504201680672"));
      expect(r[1]).to.eq(true);
    });

    it("should return max deviation when price is too high", async function () {
      const { manager, mockUsdcOracle, mockCPIOracle, mockWampl, mockVault } = await loadFixture(
        setupContracts,
      );
      await mockVault.mockMethod("getTwap()", [1]);
      await mockUsdcOracle.mockMethod("latestRoundData()", [
        0,
        usdcOracleFP("1.0"),
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
      expect(r[0]).to.eq(percFP("100"));
      expect(r[1]).to.eq(true);
    });
  });

});

