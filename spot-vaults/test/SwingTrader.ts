import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, perpFP, percFP, priceFP, stLPAmtFP, nowTS, TimeHelpers } from "./helpers";

describe("SwingTrader", function () {
  async function setupContracts() {
    const accounts = await ethers.getSigners();
    const deployer = accounts[0];
    const otherUser = accounts[1];
    const deployerAddress = await deployer.getAddress();

    const Token = await ethers.getContractFactory("MockERC20");
    const underlying = await Token.deploy();
    await underlying.init("Underlying token", "underlying", 9);
    await underlying.mint(deployerAddress, perpFP("100"));

    const Perp = await ethers.getContractFactory("MockPerp");
    const perp = await Perp.deploy();
    await perp.init("Perp token", "perp", 9);
    await perp.mint(deployerAddress, perpFP("100"));
    await perp.setTVL(perpFP("110"));

    const oracle = new DMock("IPerpPricer");
    await oracle.deploy();
    await oracle.mockMethod("decimals()", [18]);
    await oracle.mockMethod("perpUsdPrice()", [0, false]);
    await oracle.mockMethod("underlyingUsdPrice()", [0, false]);

    const SwingTrader = await ethers.getContractFactory("SwingTrader");
    const swingTrader = await upgrades.deployProxy(
      SwingTrader.connect(deployer),
      ["SwingTrader LP", "LP token", underlying.target, perp.target, oracle.target],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );
    return {
      deployer,
      deployerAddress,
      otherUser,
      perp,
      underlying,
      oracle,
      swingTrader,
    };
  }

  describe("init", function () {
    it("should set initial values", async function () {
      const { deployerAddress, swingTrader, underlying, perp, oracle } =
        await loadFixture(setupContracts);
      expect(await swingTrader.underlying()).to.eq(underlying.target);
      expect(await swingTrader.perp()).to.eq(perp.target);

      const t = await swingTrader.tradingBand();
      expect(t[0]).to.eq(percFP("0.95"));
      expect(t[1]).to.eq(percFP("1.05"));
      expect(await swingTrader.redemptionWaitTimeSec()).to.eq(86400 * 28);
      expect(await swingTrader.arbTolerancePerc()).to.eq(percFP("0.025"));

      const perpSellLimit = await swingTrader.perpSellLimit();
      expect(perpSellLimit[0]).to.eq(0);
      expect(perpSellLimit[1]).to.eq(0);

      const underlyingSellLimit = await swingTrader.underlyingSellLimit();
      expect(underlyingSellLimit[0]).to.eq(0);
      expect(underlyingSellLimit[1]).to.eq(0);

      const dailyVolume = await swingTrader.dailyVolume();
      expect(dailyVolume[0]).to.eq(0);
      expect(dailyVolume[1]).to.eq(0);
      expect(dailyVolume[2]).to.eq(0);

      expect(await swingTrader.oracle()).to.eq(oracle.target);
      expect(await swingTrader.owner()).to.eq(deployerAddress);
      expect(await swingTrader.keeper()).to.eq(deployerAddress);

      expect(await swingTrader.underlyingBalance()).to.eq(0);
      expect(await swingTrader.perpBalance()).to.eq(0);
    });
  });

  describe("#updateKeeper", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await swingTrader.renounceOwnership();
        await expect(swingTrader.updateKeeper(ethers.ZeroAddress)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set address is valid", function () {
      it("should update reference", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await swingTrader.updateKeeper(swingTrader.target);
        expect(await swingTrader.keeper()).to.eq(swingTrader.target);
      });
    });
  });

  describe("#updateOracle", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await swingTrader.renounceOwnership();
        await expect(swingTrader.updateOracle(ethers.ZeroAddress)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when oracle is not valid", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        const oracle = new DMock("SpotPricer");
        await oracle.deploy();
        await oracle.mockMethod("decimals()", [17]);
        await expect(
          swingTrader.updateOracle(oracle.target),
        ).to.be.revertedWithCustomError(swingTrader, "UnexpectedDecimals");
      });
    });

    it("should update", async function () {
      const { swingTrader } = await loadFixture(setupContracts);
      const oracle = new DMock("SpotPricer");
      await oracle.deploy();
      await oracle.mockMethod("decimals()", [18]);

      await swingTrader.updateOracle(oracle.target);
      expect(await swingTrader.oracle()).to.eq(oracle.target);
    });
  });

  describe("#pause", function () {
    describe("when triggered by non-keeper", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await swingTrader.updateKeeper(ethers.ZeroAddress);
        await expect(swingTrader.pause()).to.be.revertedWithCustomError(
          swingTrader,
          "UnauthorizedCall",
        );
      });
    });

    describe("when already paused", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await swingTrader.pause();
        await expect(swingTrader.pause()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when valid", function () {
      it("should pause", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await swingTrader.pause();
        expect(await swingTrader.paused()).to.eq(true);
      });
    });
  });

  describe("#unpause", function () {
    describe("when triggered by non-keeper", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await swingTrader.pause();
        await swingTrader.updateKeeper(ethers.ZeroAddress);
        await expect(swingTrader.unpause()).to.be.revertedWithCustomError(
          swingTrader,
          "UnauthorizedCall",
        );
      });
    });

    describe("when not paused", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await expect(swingTrader.unpause()).to.be.revertedWith("Pausable: not paused");
      });
    });

    describe("when valid", function () {
      it("should unpause", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await swingTrader.pause();
        await swingTrader.unpause();
        expect(await swingTrader.paused()).to.eq(false);
      });
    });
  });

  describe("#updateRedemptionWaitTimeSec", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await swingTrader.renounceOwnership();
        await expect(swingTrader.updateRedemptionWaitTimeSec(0)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when wait time too high", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await expect(
          swingTrader.updateRedemptionWaitTimeSec(86400 * 200),
        ).to.be.revertedWithCustomError(swingTrader, "WaittimeTooHigh");
      });
    });

    it("should update", async function () {
      const { swingTrader } = await loadFixture(setupContracts);
      await swingTrader.updateRedemptionWaitTimeSec(0);
      expect(await swingTrader.redemptionWaitTimeSec()).to.eq(0);
    });
  });

  describe("#updateTradingConfig", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await swingTrader.renounceOwnership();
        await expect(
          swingTrader.updateTradingConfig(
            [percFP("0.95"), percFP("1.05")],
            percFP("0.05"),
          ),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when range is invalid", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await expect(
          swingTrader.updateTradingConfig(
            [percFP("1.2"), percFP("1.05")],
            percFP("0.05"),
          ),
        ).to.be.revertedWithCustomError(swingTrader, "InvalidRange");
      });
    });

    it("should update", async function () {
      const { swingTrader } = await loadFixture(setupContracts);
      await swingTrader.updateTradingConfig(
        [percFP("0.95"), percFP("1.05")],
        percFP("0.05"),
      );
      const b = await swingTrader.tradingBand();
      expect(b[0]).to.eq(percFP("0.95"));
      expect(b[1]).to.eq(percFP("1.05"));
      expect(await swingTrader.arbTolerancePerc()).to.eq(percFP("0.05"));
    });
  });

  describe("#updateDailySwapLimit", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await swingTrader.renounceOwnership();
        await expect(
          swingTrader.updateDailySwapLimit(
            [perpFP("10000"), percFP("0.05")],
            [perpFP("5000"), percFP("0.1")],
          ),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
    it("should update", async function () {
      const { swingTrader } = await loadFixture(setupContracts);
      await swingTrader.updateDailySwapLimit(
        [perpFP("10000"), percFP("0.05")],
        [perpFP("5000"), percFP("0.1")],
      );
      const underlyingSellLimit = await swingTrader.underlyingSellLimit();
      expect(underlyingSellLimit[0]).to.eq(perpFP("10000"));
      expect(underlyingSellLimit[1]).to.eq(percFP("0.05"));
      const perpSellLimit = await swingTrader.perpSellLimit();
      expect(perpSellLimit[0]).to.eq(perpFP("5000"));
      expect(perpSellLimit[1]).to.eq(percFP("0.1"));
    });
  });

  describe("#computeMintAmtWithUnderlying", function () {
    describe("when supply is zero", function () {
      it("should return mint amt", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        const r = await swingTrader.computeMintAmtWithUnderlying.staticCall(
          perpFP("1000"),
        );
        expect(r[0]).to.eq(stLPAmtFP("1000"));
        expect(r[1]).to.eq(true);
      });
    });

    describe("when supply > zero", function () {
      it("should return mint amt", async function () {
        const { swingTrader, underlying, perp } = await loadFixture(setupContracts);
        await underlying.approve(swingTrader.target, perpFP("100"));
        await swingTrader.depositUnderlying(perpFP("100"));
        await perp.approve(swingTrader.target, perpFP("50"));
        await swingTrader.depositPerp(perpFP("50"));
        await perp.setTVL(perpFP("120"));
        const r = await swingTrader.computeMintAmtWithUnderlying.staticCall(
          perpFP("1000"),
        );
        expect(r[0]).to.eq(stLPAmtFP("968.75"));
        expect(r[1]).to.eq(false);
      });
    });
  });

  describe("#computeMintAmtWithPerp", function () {
    describe("when supply is zero", function () {
      it("should return zero", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        expect(await swingTrader.computeMintAmtWithPerp.staticCall(perpFP("1000"))).to.eq(
          0,
        );
      });
    });

    describe("when supply > zero", function () {
      it("should return mint amt", async function () {
        const { swingTrader, underlying, perp } = await loadFixture(setupContracts);
        await underlying.approve(swingTrader.target, perpFP("100"));
        await swingTrader.depositUnderlying(perpFP("100"));
        await perp.approve(swingTrader.target, perpFP("50"));
        await swingTrader.depositPerp(perpFP("50"));
        await perp.setTVL(perpFP("120"));
        expect(await swingTrader.computeMintAmtWithPerp.staticCall(perpFP("1000"))).to.eq(
          stLPAmtFP("1162.5"),
        );
      });
    });
  });

  describe("#computePerpToUnderlyingSwapAmt", function () {
    describe("when market rate is not valid", function () {
      it("should compute the swap amt", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        expect(
          await swingTrader.computePerpToUnderlyingSwapAmt.staticCall(perpFP("100")),
        ).to.eq(perpFP("104.761904761"));
      });
    });

    describe("when market rate is valid", function () {
      describe("when market rate is higher than exchange rate", function () {
        it("should compute the swap amt", async function () {
          const { swingTrader, oracle } = await loadFixture(setupContracts);
          await oracle.mockMethod("perpUsdPrice()", [priceFP("1.5"), true]);
          await oracle.mockMethod("underlyingUsdPrice()", [priceFP("1.2"), true]);
          expect(
            await swingTrader.computePerpToUnderlyingSwapAmt.staticCall(perpFP("100")),
          ).to.eq(perpFP("104.761904761"));
        });
      });
      describe("when market rate is lower than exchange rate", function () {
        it("should compute the swap amt", async function () {
          const { swingTrader, oracle } = await loadFixture(setupContracts);
          await oracle.mockMethod("perpUsdPrice()", [priceFP("0.75"), true]);
          await oracle.mockMethod("underlyingUsdPrice()", [priceFP("1.2"), true]);
          expect(
            await swingTrader.computePerpToUnderlyingSwapAmt.staticCall(perpFP("100")),
          ).to.eq(perpFP("64.102564102"));
        });
      });
    });
  });

  describe("#computeUnderlyingToPerpSwapAmt", function () {
    describe("when market rate is not valid", function () {
      it("should compute the swap amt", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        expect(
          await swingTrader.computeUnderlyingToPerpSwapAmt.staticCall(perpFP("100")),
        ).to.eq(perpFP("86.363636363"));
      });
    });

    describe("when market rate is valid", function () {
      describe("when market rate is higher than exchange rate", function () {
        it("should compute the swap amt", async function () {
          const { swingTrader, oracle } = await loadFixture(setupContracts);
          await oracle.mockMethod("perpUsdPrice()", [priceFP("1.5"), true]);
          await oracle.mockMethod("underlyingUsdPrice()", [priceFP("1.2"), true]);
          expect(
            await swingTrader.computeUnderlyingToPerpSwapAmt.staticCall(perpFP("100")),
          ).to.eq(perpFP("82"));
        });
      });
      describe("when market rate is lower than exchange rate", function () {
        it("should compute the swap amt", async function () {
          const { swingTrader, oracle } = await loadFixture(setupContracts);
          await oracle.mockMethod("perpUsdPrice()", [priceFP("0.75"), true]);
          await oracle.mockMethod("underlyingUsdPrice()", [priceFP("1.2"), true]);
          expect(
            await swingTrader.computeUnderlyingToPerpSwapAmt.staticCall(perpFP("100")),
          ).to.eq(perpFP("86.363636363"));
        });
      });
    });
  });

  describe("#getMarketRate", function () {
    describe("when perp rate is invalid", function () {
      it("should return 0", async function () {
        const { swingTrader, oracle } = await loadFixture(setupContracts);
        await oracle.mockMethod("perpUsdPrice()", [priceFP("0.75"), false]);
        await oracle.mockMethod("underlyingUsdPrice()", [priceFP("1.2"), true]);
        const p = await swingTrader.getMarketRate.staticCall();
        expect(p[0]).to.eq(0);
        expect(p[1]).to.eq(false);
      });
    });
    describe("when underlying rate is invalid", function () {
      it("should return 0", async function () {
        const { swingTrader, oracle } = await loadFixture(setupContracts);
        await oracle.mockMethod("perpUsdPrice()", [priceFP("0.75"), true]);
        await oracle.mockMethod("underlyingUsdPrice()", [priceFP("1.2"), false]);
        const p = await swingTrader.getMarketRate.staticCall();
        expect(p[0]).to.eq(0);
        expect(p[1]).to.eq(false);
      });
    });

    it("should market rate", async function () {
      const { swingTrader, oracle } = await loadFixture(setupContracts);
      await oracle.mockMethod("perpUsdPrice()", [priceFP("1.3"), true]);
      await oracle.mockMethod("underlyingUsdPrice()", [priceFP("1.2"), true]);
      const p = await swingTrader.getMarketRate.staticCall();
      expect(p[0]).to.eq(priceFP("0.923076923076923076"));
      expect(p[1]).to.eq(true);
    });
  });

  describe("#depositUnderlying", function () {
    describe("when amount is zero", function () {
      it("should be a no-op", async function () {
        const { swingTrader, underlying, deployer } = await loadFixture(setupContracts);
        await expect(() => swingTrader.depositUnderlying(0)).to.changeTokenBalance(
          underlying,
          deployer,
          0,
        );
      });
    });

    describe("when supply is zero", function () {
      it("should transfer underlying from user", async function () {
        const { swingTrader, underlying, deployer } = await loadFixture(setupContracts);
        await underlying.approve(swingTrader.target, perpFP("100"));
        await expect(() =>
          swingTrader.depositUnderlying(perpFP("100")),
        ).to.changeTokenBalance(underlying, deployer, perpFP("-100"));
      });

      it("should mint lp tokens", async function () {
        const { swingTrader, underlying, deployer } = await loadFixture(setupContracts);
        await underlying.approve(swingTrader.target, perpFP("100"));
        await expect(() =>
          swingTrader.depositUnderlying(perpFP("100")),
        ).to.changeTokenBalance(swingTrader, deployer, stLPAmtFP("99.999"));
        expect(await swingTrader.totalSupply()).to.eq(stLPAmtFP("100"));
      });
    });

    describe("when supply > zero", function () {
      it("should transfer underlying from user", async function () {
        const { swingTrader, underlying, deployer, otherUser, deployerAddress } =
          await loadFixture(setupContracts);
        await underlying.approve(swingTrader.target, perpFP("100"));
        await swingTrader.depositUnderlying(perpFP("100"));
        await underlying.mint(deployerAddress, perpFP("100"));
        await underlying.transfer(swingTrader.target, perpFP("50"));
        await underlying.transfer(await otherUser.getAddress(), perpFP("50"));
        await underlying.connect(otherUser).approve(swingTrader.target, perpFP("50"));
        await expect(() =>
          swingTrader.connect(otherUser).depositUnderlying(perpFP("50")),
        ).to.changeTokenBalances(underlying, [otherUser, deployer], [perpFP("-50"), 0]);
      });

      it("should mint lp tokens", async function () {
        const { swingTrader, underlying, deployer, otherUser, deployerAddress } =
          await loadFixture(setupContracts);
        await underlying.approve(swingTrader.target, perpFP("100"));
        await swingTrader.depositUnderlying(perpFP("100"));
        await underlying.mint(deployerAddress, perpFP("100"));
        await underlying.transfer(swingTrader.target, perpFP("50"));
        await underlying.transfer(await otherUser.getAddress(), perpFP("50"));
        await underlying.connect(otherUser).approve(swingTrader.target, perpFP("50"));
        await expect(() =>
          swingTrader.connect(otherUser).depositUnderlying(perpFP("50")),
        ).to.changeTokenBalances(
          swingTrader,
          [otherUser, deployer],
          [stLPAmtFP("33.333333333333333"), 0],
        );
        expect(await swingTrader.totalSupply()).to.eq(stLPAmtFP("133.333333333333333"));
      });
    });
  });

  describe("#depositPerp", function () {
    describe("when amount is zero", function () {
      it("should be a no-op", async function () {
        const { swingTrader, perp, deployer } = await loadFixture(setupContracts);
        await expect(() => swingTrader.depositPerp(0)).to.changeTokenBalance(
          perp,
          deployer,
          0,
        );
      });
    });

    describe("when supply is zero", function () {
      it("should be a no-op", async function () {
        const { swingTrader, perp, deployer } = await loadFixture(setupContracts);
        await perp.approve(swingTrader.target, perpFP("100"));
        await expect(() => swingTrader.depositPerp(perpFP("100"))).to.changeTokenBalance(
          perp,
          deployer,
          0,
        );
        expect(await swingTrader.totalSupply()).to.eq(0);
      });
    });

    describe("when supply > zero", function () {
      it("should transfer perp from user", async function () {
        const { swingTrader, underlying, perp, deployer, otherUser } = await loadFixture(
          setupContracts,
        );
        await underlying.approve(swingTrader.target, perpFP("100"));
        await swingTrader.depositUnderlying(perpFP("100"));
        await perp.transfer(swingTrader.target, perpFP("50"));
        await perp.transfer(await otherUser.getAddress(), perpFP("50"));
        await perp.connect(otherUser).approve(swingTrader.target, perpFP("50"));
        await expect(() =>
          swingTrader.connect(otherUser).depositPerp(perpFP("50")),
        ).to.changeTokenBalances(perp, [otherUser, deployer], [perpFP("-50"), 0]);
      });

      it("should mint lp tokens", async function () {
        const { swingTrader, underlying, perp, deployer, otherUser } = await loadFixture(
          setupContracts,
        );
        await underlying.approve(swingTrader.target, perpFP("100"));
        await swingTrader.depositUnderlying(perpFP("100"));
        await perp.transfer(swingTrader.target, perpFP("50"));
        await perp.transfer(await otherUser.getAddress(), perpFP("50"));
        await perp.connect(otherUser).approve(swingTrader.target, perpFP("50"));
        await expect(() =>
          swingTrader.connect(otherUser).depositPerp(perpFP("50")),
        ).to.changeTokenBalances(
          swingTrader,
          [otherUser, deployer],
          [stLPAmtFP("35.483870967741935"), 0],
        );
        expect(await swingTrader.totalSupply()).to.eq(stLPAmtFP("135.483870967741935"));
      });
    });
  });

  describe("#requestRedeem", function () {
    describe("when amount is zero", function () {
      it("should be a no-op", async function () {
        const { swingTrader, deployer } = await loadFixture(setupContracts);
        await expect(() => swingTrader.requestRedeem(0)).to.changeTokenBalances(
          swingTrader,
          [deployer, swingTrader],
          [0, 0],
        );
      });
    });
    it("should take custody of tokens and add redemption request", async function () {
      const { swingTrader, underlying, perp, deployer, deployerAddress } =
        await loadFixture(setupContracts);
      await underlying.approve(swingTrader.target, perpFP("100"));
      await swingTrader.depositUnderlying(perpFP("100"));
      await perp.approve(swingTrader.target, perpFP("50"));
      await swingTrader.depositPerp(perpFP("50"));

      await expect(() =>
        swingTrader.requestRedeem(stLPAmtFP("33")),
      ).to.changeTokenBalances(
        swingTrader,
        [deployer, swingTrader],
        [stLPAmtFP("-33"), stLPAmtFP("33")],
      );

      expect(await swingTrader.getRedemptionRequestCount(deployerAddress)).to.eq(1);
      const r = await swingTrader.getRedemptionRequest(deployerAddress, 0);
      expect(r[0]).to.eq(stLPAmtFP("33"));
      expect(r[1]).to.lte(nowTS() + 86400 * 29);
    });

    describe("when there are too many active requests", function () {
      it("should revert", async function () {
        const { swingTrader, underlying, perp } = await loadFixture(setupContracts);
        await underlying.approve(swingTrader.target, perpFP("100"));
        await swingTrader.depositUnderlying(perpFP("100"));
        await perp.approve(swingTrader.target, perpFP("50"));
        await swingTrader.depositPerp(perpFP("50"));
        for (let i = 0; i < 32; i++) {
          await swingTrader.requestRedeem(stLPAmtFP("1"));
        }
        await expect(
          swingTrader.requestRedeem(stLPAmtFP("1")),
        ).to.be.revertedWithCustomError(swingTrader, "TooManyRedemptionRequests");
      });
    });
  });

  describe("#execRedeem", function () {
    async function setupRedeem() {
      const { swingTrader, underlying, perp, deployer, deployerAddress } =
        await loadFixture(setupContracts);
      await underlying.approve(swingTrader.target, perpFP("100"));
      await swingTrader.depositUnderlying(perpFP("100"));
      await perp.approve(swingTrader.target, perpFP("50"));
      await swingTrader.depositPerp(perpFP("50"));
      return { swingTrader, underlying, perp, deployer, deployerAddress };
    }
    describe("when lock is active", function () {
      it("should not redeem tokens", async function () {
        const { swingTrader, deployer, deployerAddress } = await setupRedeem();
        await swingTrader.requestRedeem(stLPAmtFP("25"));
        expect(await swingTrader.computeBurnableAmt(deployerAddress)).to.eq(0);
        await expect(() => swingTrader.execRedeem()).to.changeTokenBalances(
          swingTrader,
          [deployer, swingTrader],
          [0, 0],
        );
      });
    });

    describe("when lock has expired", function () {
      it("should burn lp tokens", async function () {
        const { swingTrader, deployer, deployerAddress } = await setupRedeem();
        await swingTrader.requestRedeem(stLPAmtFP("15.5"));

        await TimeHelpers.increaseTime(30 * 86400);
        expect(await swingTrader.computeBurnableAmt(deployerAddress)).to.eq(
          stLPAmtFP("15.5"),
        );
        await expect(() => swingTrader.execRedeem()).to.changeTokenBalances(
          swingTrader,
          [deployer, swingTrader],
          [0, stLPAmtFP("-15.5")],
        );
        expect(await swingTrader.computeBurnableAmt(deployerAddress)).to.eq(0);
        expect(await swingTrader.getRedemptionRequestCount(deployerAddress)).to.eq(0);
        expect(await swingTrader.totalSupply()).to.eq(stLPAmtFP("139.5"));
      });

      it("should redeem underlying", async function () {
        const { swingTrader, underlying, deployer } = await setupRedeem();
        await swingTrader.requestRedeem(stLPAmtFP("15.5"));

        await TimeHelpers.increaseTime(30 * 86400);
        await expect(() => swingTrader.execRedeem()).to.changeTokenBalances(
          underlying,
          [deployer, swingTrader],
          [perpFP("10"), perpFP("-10")],
        );
      });

      it("should redeem perp", async function () {
        const { swingTrader, perp, deployer } = await setupRedeem();
        await swingTrader.requestRedeem(stLPAmtFP("15.5"));

        await TimeHelpers.increaseTime(30 * 86400);
        await expect(() => swingTrader.execRedeem()).to.changeTokenBalances(
          perp,
          [deployer, swingTrader],
          [perpFP("5"), perpFP("-5")],
        );
      });
    });

    describe("when redeeming multiple requests", function () {
      it("should burn lp tokens", async function () {
        const { swingTrader, deployer, deployerAddress } = await setupRedeem();
        for (let i = 0; i < 5; i++) {
          await swingTrader.requestRedeem(stLPAmtFP(`${5 + i}`));
          await TimeHelpers.increaseTime(7 * 86400);
        }

        expect(await swingTrader.computeBurnableAmt(deployerAddress)).to.eq(
          stLPAmtFP("11"),
        );
        await expect(() => swingTrader.execRedeem()).to.changeTokenBalances(
          swingTrader,
          [deployer, swingTrader],
          [0, stLPAmtFP("-11")],
        );
        expect(await swingTrader.computeBurnableAmt(deployerAddress)).to.eq(0);
        expect(await swingTrader.getRedemptionRequestCount(deployerAddress)).to.eq(3);
        expect(await swingTrader.totalSupply()).to.eq(stLPAmtFP("144"));

        const r0 = await swingTrader.getRedemptionRequest(deployerAddress, 0);
        const r1 = await swingTrader.getRedemptionRequest(deployerAddress, 1);
        const r2 = await swingTrader.getRedemptionRequest(deployerAddress, 2);
        expect(r2[0]).to.eq(stLPAmtFP("7"));
        expect(r0[0]).to.eq(stLPAmtFP("8"));
        expect(r1[0]).to.eq(stLPAmtFP("9"));
      });

      it("should redeem underlying", async function () {
        const { swingTrader, underlying, deployer } = await setupRedeem();
        for (let i = 0; i < 5; i++) {
          await swingTrader.requestRedeem(stLPAmtFP(`${5 + i}`));
          await TimeHelpers.increaseTime(7 * 86400);
        }

        await expect(() => swingTrader.execRedeem()).to.changeTokenBalances(
          underlying,
          [deployer, swingTrader],
          [perpFP("7.096774193"), perpFP("-7.096774193")],
        );
      });

      it("should redeem perp", async function () {
        const { swingTrader, perp, deployer } = await setupRedeem();
        for (let i = 0; i < 5; i++) {
          await swingTrader.requestRedeem(stLPAmtFP(`${5 + i}`));
          await TimeHelpers.increaseTime(7 * 86400);
        }

        await expect(() => swingTrader.execRedeem()).to.changeTokenBalances(
          perp,
          [deployer, swingTrader],
          [perpFP("3.548387096"), perpFP("-3.548387096")],
        );
      });
    });
  });

  describe("#swapUnderlyingForPerps", function () {
    async function setupSwap() {
      const { swingTrader, underlying, perp, deployer } = await loadFixture(
        setupContracts,
      );
      await underlying.approve(swingTrader.target, perpFP("100"));
      await swingTrader.depositUnderlying(perpFP("50"));
      await perp.transfer(swingTrader.target, perpFP("50"));
      return { swingTrader, underlying, perp, deployer };
    }
    describe("when amount is zero", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await expect(
          swingTrader.swapUnderlyingForPerps(0, 0),
        ).to.be.revertedWithCustomError(swingTrader, "UnacceptableSwap");
      });
    });

    describe("when slippage too high", function () {
      it("should revert", async function () {
        const { swingTrader } = await setupSwap();
        await expect(
          swingTrader.swapUnderlyingForPerps(perpFP("10"), perpFP("20")),
        ).to.be.revertedWithCustomError(swingTrader, "SlippageTooHigh");
      });
    });

    describe("when abs swap limit is reached", function () {
      it("should transfer revert", async function () {
        const { swingTrader } = await setupSwap();

        await swingTrader.updateDailySwapLimit([0, 0], [perpFP("8"), percFP("0.5")]);
        await expect(
          swingTrader.swapUnderlyingForPerps(perpFP("10"), 0),
        ).to.be.revertedWithCustomError(swingTrader, "SwapLimitExceeded");
      });
    });

    describe("when perc swap limit is reached", function () {
      it("should transfer revert", async function () {
        const { swingTrader } = await setupSwap();

        await swingTrader.updateDailySwapLimit([0, 0], [perpFP("12"), percFP("0.01")]);
        await expect(
          swingTrader.swapUnderlyingForPerps(perpFP("10"), 0),
        ).to.be.revertedWithCustomError(swingTrader, "SwapLimitExceeded");
      });
    });

    describe("when swap is valid", function () {
      it("should transfer underlying tokens from the user", async function () {
        const { swingTrader, underlying, deployer } = await setupSwap();

        await swingTrader.updateDailySwapLimit([0, 0], [perpFP("100"), percFP("0.5")]);
        await expect(() =>
          swingTrader.swapUnderlyingForPerps(perpFP("10"), 0),
        ).to.changeTokenBalances(
          underlying,
          [deployer, swingTrader],
          [perpFP("-10"), perpFP("10")],
        );
      });
      it("should transfer perp tokens to the user", async function () {
        const { swingTrader, perp, deployer } = await setupSwap();

        await swingTrader.updateDailySwapLimit([0, 0], [perpFP("100"), percFP("0.5")]);
        await expect(() =>
          swingTrader.swapUnderlyingForPerps(perpFP("10"), 0),
        ).to.changeTokenBalances(
          perp,
          [deployer, swingTrader],
          [perpFP("8.636363636"), perpFP("-8.636363636")],
        );
      });

      it("should update volumes", async function () {
        const { swingTrader } = await setupSwap();

        await swingTrader.updateDailySwapLimit([0, 0], [perpFP("100"), percFP("0.5")]);
        const ts = await nowTS();
        const d = await swingTrader.dailyVolume();
        expect(d[0]).to.lte(ts);
        expect(d[2]).to.eq(0);
        await swingTrader.swapUnderlyingForPerps(perpFP("10"), 0);
        const d_ = await swingTrader.dailyVolume();
        expect(d_[0]).to.eq(ts - (ts % 86400));
        expect(d_[2]).to.eq(perpFP("8.636363636"));
      });
    });

    describe("when abs swap limit time has surpassed", function () {
      it("should reset swap limit", async function () {
        const { swingTrader } = await setupSwap();

        await swingTrader.updateDailySwapLimit([0, 0], [perpFP("10"), percFP("0.5")]);
        await swingTrader.swapUnderlyingForPerps(perpFP("10"), 0);

        await expect(
          swingTrader.swapUnderlyingForPerps(perpFP("10"), perpFP("8.5")),
        ).to.be.revertedWithCustomError(swingTrader, "SwapLimitExceeded");

        await TimeHelpers.increaseTime(86400);

        const d = await swingTrader.dailyVolume();
        expect(d[2]).to.eq(perpFP("8.636363636"));

        await expect(swingTrader.swapUnderlyingForPerps(perpFP("5"), perpFP("3"))).not.to
          .be.reverted;
        const d_ = await swingTrader.dailyVolume();
        expect(d_[0] - d[0]).to.eq(86400);
        expect(d_[2]).to.eq(perpFP("4.318181818"));
      });
    });
  });

  describe("#swapPerpsForUnderlying", function () {
    async function setupSwap() {
      const { swingTrader, underlying, perp, deployer } = await loadFixture(
        setupContracts,
      );
      await underlying.approve(swingTrader.target, perpFP("50"));
      await swingTrader.depositUnderlying(perpFP("50"));
      await perp.transfer(swingTrader.target, perpFP("50"));
      await perp.approve(swingTrader.target, perpFP("50"));
      return { swingTrader, underlying, perp, deployer };
    }
    describe("when amount is zero", function () {
      it("should revert", async function () {
        const { swingTrader } = await loadFixture(setupContracts);
        await expect(
          swingTrader.swapPerpsForUnderlying(0, 0),
        ).to.be.revertedWithCustomError(swingTrader, "UnacceptableSwap");
      });
    });

    describe("when slippage too high", function () {
      it("should revert", async function () {
        const { swingTrader } = await setupSwap();
        await expect(
          swingTrader.swapPerpsForUnderlying(perpFP("10"), perpFP("20")),
        ).to.be.revertedWithCustomError(swingTrader, "SlippageTooHigh");
      });
    });

    describe("when abs swap limit is reached", function () {
      it("should transfer revert", async function () {
        const { swingTrader } = await setupSwap();
        await swingTrader.updateDailySwapLimit([perpFP("8"), percFP("0.5")], [0, 0]);
        await expect(
          swingTrader.swapPerpsForUnderlying(perpFP("10"), 0),
        ).to.be.revertedWithCustomError(swingTrader, "SwapLimitExceeded");
      });
    });

    describe("when perc swap limit is reached", function () {
      it("should transfer revert", async function () {
        const { swingTrader } = await setupSwap();
        await swingTrader.updateDailySwapLimit([perpFP("12"), percFP("0.01")], [0, 0]);
        await expect(
          swingTrader.swapPerpsForUnderlying(perpFP("10"), 0),
        ).to.be.revertedWithCustomError(swingTrader, "SwapLimitExceeded");
      });
    });

    describe("when swap is valid", function () {
      it("should transfer perp tokens from the user", async function () {
        const { swingTrader, perp, deployer } = await setupSwap();
        await swingTrader.updateDailySwapLimit([perpFP("100"), percFP("0.5")], [0, 0]);
        await expect(() =>
          swingTrader.swapPerpsForUnderlying(perpFP("10"), 0),
        ).to.changeTokenBalances(
          perp,
          [deployer, swingTrader],
          [perpFP("-10"), perpFP("10")],
        );
      });
      it("should transfer underlying tokens to the user", async function () {
        const { swingTrader, underlying, deployer } = await setupSwap();
        await swingTrader.updateDailySwapLimit([perpFP("100"), percFP("0.5")], [0, 0]);
        await expect(() =>
          swingTrader.swapPerpsForUnderlying(perpFP("10"), 0),
        ).to.changeTokenBalances(
          underlying,
          [deployer, swingTrader],
          [perpFP("10.476190476"), perpFP("-10.476190476")],
        );
      });

      it("should update volumes", async function () {
        const { swingTrader } = await setupSwap();
        await swingTrader.updateDailySwapLimit([perpFP("100"), percFP("0.5")], [0, 0]);
        const ts = await nowTS();
        const d = await swingTrader.dailyVolume();
        expect(d[0]).to.lte(ts);
        expect(d[1]).to.eq(0);
        await swingTrader.swapPerpsForUnderlying(perpFP("10"), 0);
        const d_ = await swingTrader.dailyVolume();
        expect(d_[0]).to.eq(ts - (ts % 86400));
        expect(d_[1]).to.eq(perpFP("10.476190476"));
      });
    });

    describe("when abs swap limit time has surpassed", function () {
      it("should reset swap limit", async function () {
        const { swingTrader } = await setupSwap();

        await swingTrader.updateDailySwapLimit([perpFP("11"), percFP("0.5")], [0, 0]);
        await swingTrader.swapPerpsForUnderlying(perpFP("10"), 0);

        await expect(
          swingTrader.swapPerpsForUnderlying(perpFP("10"), 0),
        ).to.be.revertedWithCustomError(swingTrader, "SwapLimitExceeded");

        await TimeHelpers.increaseTime(86400);

        const d = await swingTrader.dailyVolume();
        expect(d[1]).to.eq(perpFP("10.476190476"));

        await expect(swingTrader.swapPerpsForUnderlying(perpFP("5"), perpFP("3"))).not.to
          .be.reverted;
        const d_ = await swingTrader.dailyVolume();
        expect(d_[0] - d[0]).to.eq(86400);
        expect(d_[1]).to.eq(perpFP("5.238095238"));
      });
    });
  });
});
