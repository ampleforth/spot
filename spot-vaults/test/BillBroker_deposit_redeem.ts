import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, usdFP, perpFP, lpAmtFP, percentageFP, priceFP } from "./helpers";

describe("BillBroker", function () {
  async function setupContracts() {
    const accounts = await ethers.getSigners();
    const deployer = accounts[0];
    const otherUser = accounts[1];

    const Token = await ethers.getContractFactory("MockERC20");
    const usd = await Token.deploy();
    await usd.init("USD token", "usd", 6);
    const perp = await Token.deploy();
    await perp.init("Perp token", "perp", 9);
    const pricingStrategy = new DMock("SpotAppraiser");
    await pricingStrategy.deploy();
    await pricingStrategy.mockMethod("decimals()", [18]);
    await pricingStrategy.mockMethod("perpPrice()", [priceFP("1.15"), true]);
    await pricingStrategy.mockMethod("usdPrice()", [priceFP("1"), true]);

    const BillBroker = await ethers.getContractFactory("BillBroker");
    const billBroker = await upgrades.deployProxy(
      BillBroker.connect(deployer),
      ["BillBroker LP", "LP token", usd.target, perp.target, pricingStrategy.target],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );
    await billBroker.updateFees({
      mintFeePerc: 0n,
      burnFeePerc: 0n,
      perpToUSDSwapFeePercs: {
        lower: 0n,
        upper: 0n,
      },
      usdToPerpSwapFeePercs: {
        lower: 0n,
        upper: 0n,
      },
      protocolSwapSharePerc: 0n,
    });
    await usd.mint(await deployer.getAddress(), usdFP("2000"));
    await perp.mint(await deployer.getAddress(), perpFP("2000"));
    await usd.mint(await otherUser.getAddress(), usdFP("2000"));
    await perp.mint(await otherUser.getAddress(), perpFP("2000"));
    return { deployer, otherUser, usd, perp, pricingStrategy, billBroker };
  }

  describe("#computeMintAmt", function () {
    describe("when amounts available are zero", function () {
      it("should return zero", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        const r = await billBroker.computeMintAmt.staticCall(0n, 0n);
        expect(r[0]).to.eq(0n);
        expect(r[1]).to.eq(0n);
        expect(r[2]).to.eq(0n);
      });
    });

    describe("first mint", function () {
      it("should compute mint amount", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        const r = await billBroker.computeMintAmt.staticCall(usdFP("115"), perpFP("100"));
        expect(r[0]).to.eq(lpAmtFP("215"));
        expect(r[1]).to.eq(usdFP("115"));
        expect(r[2]).to.eq(perpFP("100"));
      });
    });

    describe("when supply > 0 and minting in the right ratio", function () {
      it("should compute mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        const r = await billBroker.computeMintAmt.staticCall(usdFP("230"), perpFP("200"));
        expect(r[0]).to.eq(lpAmtFP("430"));
        expect(r[1]).to.eq(usdFP("230"));
        expect(r[2]).to.eq(perpFP("200"));
      });
    });

    describe("when supply > 0 and minting ratio is different", function () {
      it("should compute mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        const r = await billBroker.computeMintAmt.staticCall(usdFP("230"), perpFP("100"));
        expect(r[0]).to.eq(lpAmtFP("215"));
        expect(r[1]).to.eq(usdFP("115"));
        expect(r[2]).to.eq(perpFP("100"));
      });
    });

    describe("when supply > 0 and minting ratio is different", function () {
      it("should compute mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        const r = await billBroker.computeMintAmt.staticCall(usdFP("50"), perpFP("100"));
        expect(r[0]).to.eq(lpAmtFP("93.478260869565217391304347"));
        expect(r[1]).to.eq(usdFP("50"));
        expect(r[2]).to.eq(perpFP("43.478260869"));
      });
    });

    describe("when fee > 0", async function () {
      it("should compute mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await billBroker.updateFees({
          mintFeePerc: percentageFP("0.1"),
          burnFeePerc: 0n,
          perpToUSDSwapFeePercs: {
            lower: 0n,
            upper: 0n,
          },
          usdToPerpSwapFeePercs: {
            lower: 0n,
            upper: 0n,
          },
          protocolSwapSharePerc: 0n,
        });
        const r = await billBroker.computeMintAmt.staticCall(usdFP("115"), perpFP("100"));
        expect(r[0]).to.eq(lpAmtFP("193.5"));
        expect(r[1]).to.eq(usdFP("115"));
        expect(r[2]).to.eq(perpFP("100"));
      });
    });

    describe("when the pool has only usd", function () {
      it("should compute mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );

        await usd.approve(billBroker.target, usdFP("115"));
        await billBroker.swapUSDForPerps(usdFP("115"), 0n);
        expect(await perp.balanceOf(billBroker.target)).to.eq(0n);

        const s = await billBroker.reserveState.staticCall();
        expect(
          await billBroker.assetRatio({
            usdBalance: s[0],
            perpBalance: s[1],
            usdPrice: s[2],
            perpPrice: s[3],
          }),
        ).to.eq(ethers.MaxUint256);

        const r = await billBroker.computeMintAmt.staticCall(usdFP("100"), 0n);
        expect(r[0]).to.eq(lpAmtFP("93.478260869565217391304347"));
        expect(r[1]).to.eq(usdFP("100"));
        expect(r[2]).to.eq(0n);
      });
    });

    describe("when the pool has only perps", function () {
      it("should compute mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );

        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.swapPerpsForUSD(perpFP("100"), 0n);
        expect(await usd.balanceOf(billBroker.target)).to.eq(0n);

        const s = await billBroker.reserveState.staticCall();
        expect(
          await billBroker.assetRatio({
            usdBalance: s[0],
            perpBalance: s[1],
            usdPrice: s[2],
            perpPrice: s[3],
          }),
        ).to.eq(0);

        const r = await billBroker.computeMintAmt.staticCall(0n, perpFP("100"));
        expect(r[0]).to.eq(lpAmtFP("107.5"));
        expect(r[1]).to.eq(0n);
        expect(r[2]).to.eq(perpFP("100"));
      });
    });
  });

  describe("#deposit", function () {
    describe("when paused", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.pause();
        await expect(
          billBroker.deposit(usdFP("115"), perpFP("100"), usdFP("115"), perpFP("100")),
        ).to.be.reverted;
      });
    });

    describe("when amounts available are zero", function () {
      it("should return zero", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        const r = await billBroker.deposit.staticCall(0n, 0n, 0n, 0n);
        expect(r).to.eq(0n);
      });
    });

    describe("when slippage is too high", function () {
      it("should revert", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await expect(
          billBroker.deposit(usdFP("100"), perpFP("100"), usdFP("120"), perpFP("100")),
        ).to.be.revertedWithCustomError(billBroker, "SlippageTooHigh");
      });

      it("should revert", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("100"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("100"),
          perpFP("100"),
          usdFP("100"),
          perpFP("100"),
        );
        await expect(
          billBroker.deposit(usdFP("100"), perpFP("115"), usdFP("100"), perpFP("115")),
        ).to.be.revertedWithCustomError(billBroker, "SlippageTooHigh");
      });
    });

    describe("first deposit", function () {
      it("should transfer usd from user", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await expect(() =>
          billBroker.deposit(usdFP("115"), perpFP("100"), usdFP("115"), perpFP("100")),
        ).to.changeTokenBalance(usd, deployer, usdFP("-115"));
      });

      it("should transfer perps from user", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await expect(() =>
          billBroker.deposit(usdFP("115"), perpFP("100"), usdFP("115"), perpFP("100")),
        ).to.changeTokenBalance(perp, deployer, perpFP("-100"));
      });

      it("should mint lp tokens", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await expect(() =>
          billBroker.deposit(usdFP("115"), perpFP("100"), usdFP("115"), perpFP("100")),
        ).to.changeTokenBalance(billBroker, deployer, lpAmtFP("214.99"));
        expect(await billBroker.totalSupply()).to.eq(lpAmtFP("215"));
      });

      it("should return mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        const r = await billBroker.deposit.staticCall(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        expect(r).to.eq(lpAmtFP("214.99"));
      });
    });

    describe("subsequent deposits", function () {
      it("should transfer usd from user", async function () {
        const { billBroker, usd, perp, otherUser } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await usd.connect(otherUser).approve(billBroker.target, usdFP("100"));
        await perp.connect(otherUser).approve(billBroker.target, perpFP("100"));
        await expect(() =>
          billBroker
            .connect(otherUser)
            .deposit(usdFP("23"), perpFP("100"), usdFP("20"), perpFP("20")),
        ).to.changeTokenBalance(usd, otherUser, usdFP("-23"));
      });

      it("should transfer perps from user", async function () {
        const { billBroker, usd, perp, otherUser } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await usd.connect(otherUser).approve(billBroker.target, usdFP("100"));
        await perp.connect(otherUser).approve(billBroker.target, perpFP("100"));
        await expect(() =>
          billBroker
            .connect(otherUser)
            .deposit(usdFP("23"), perpFP("100"), usdFP("20"), perpFP("20")),
        ).to.changeTokenBalance(perp, otherUser, perpFP("-20"));
      });

      it("should mint lp tokens", async function () {
        const { billBroker, usd, perp, otherUser } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await usd.connect(otherUser).approve(billBroker.target, usdFP("100"));
        await perp.connect(otherUser).approve(billBroker.target, perpFP("100"));
        await expect(() =>
          billBroker
            .connect(otherUser)
            .deposit(usdFP("23"), perpFP("100"), usdFP("20"), perpFP("20")),
        ).to.changeTokenBalance(billBroker, otherUser, lpAmtFP("43"));
        expect(await billBroker.totalSupply()).to.eq(lpAmtFP("258"));
      });

      it("should return mint amount", async function () {
        const { billBroker, usd, perp, otherUser } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await usd.connect(otherUser).approve(billBroker.target, usdFP("100"));
        await perp.connect(otherUser).approve(billBroker.target, perpFP("100"));
        const r = await billBroker
          .connect(otherUser)
          .deposit.staticCall(usdFP("23"), perpFP("100"), usdFP("20"), perpFP("20"));
        expect(r).to.eq(lpAmtFP("43"));
      });
    });

    describe("when fee > 0", function () {
      it("should withhold fees and mint lp tokens", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await billBroker.updateFees({
          mintFeePerc: percentageFP("0.1"),
          burnFeePerc: 0n,
          perpToUSDSwapFeePercs: {
            lower: 0n,
            upper: 0n,
          },
          usdToPerpSwapFeePercs: {
            lower: 0n,
            upper: 0n,
          },
          protocolSwapSharePerc: 0n,
        });
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await expect(() =>
          billBroker.deposit(usdFP("115"), perpFP("100"), usdFP("115"), perpFP("100")),
        ).to.changeTokenBalance(billBroker, deployer, lpAmtFP("193.49"));
      });
    });

    describe("when the pool has only usd", function () {
      it("should mint lp tokens", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );

        await usd.approve(billBroker.target, usdFP("115"));
        await billBroker.swapUSDForPerps(usdFP("115"), 0n);
        expect(await perp.balanceOf(billBroker.target)).to.eq(0n);

        const s = await billBroker.reserveState.staticCall();
        expect(
          await billBroker.assetRatio({
            usdBalance: s[0],
            perpBalance: s[1],
            usdPrice: s[2],
            perpPrice: s[3],
          }),
        ).to.eq(ethers.MaxUint256);

        await usd.approve(billBroker.target, usdFP("115"));
        await expect(() =>
          billBroker.deposit(usdFP("100"), 0n, usdFP("100"), 0n),
        ).to.changeTokenBalance(
          billBroker,
          deployer,
          lpAmtFP("93.478260869565217391304347"),
        );
      });
    });

    describe("when the pool has only perps", function () {
      it("should mint lp tokens", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );

        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.swapPerpsForUSD(perpFP("100"), 0n);
        expect(await usd.balanceOf(billBroker.target)).to.eq(0n);

        const s = await billBroker.reserveState.staticCall();
        expect(
          await billBroker.assetRatio({
            usdBalance: s[0],
            perpBalance: s[1],
            usdPrice: s[2],
            perpPrice: s[3],
          }),
        ).to.eq(0);

        await perp.approve(billBroker.target, perpFP("100"));
        await expect(() =>
          billBroker.deposit(usdFP("100"), perpFP("100"), 0n, perpFP("100")),
        ).to.changeTokenBalance(billBroker, deployer, lpAmtFP("107.5"));
      });
    });
  });

  describe("#computeRedemptionAmts", function () {
    describe("when burn amount is zero", function () {
      it("should return zero", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        const r = await billBroker.computeRedemptionAmts.staticCall(0n);
        expect(r[0]).to.eq(0n);
        expect(r[1]).to.eq(0n);
      });
    });

    describe("when supply is zero", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(billBroker.computeRedemptionAmts.staticCall(lpAmtFP("100"))).to.be
          .reverted;
      });
    });

    describe("when redeeming partial supply", function () {
      it("should return redemption amounts", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        const r = await billBroker.computeRedemptionAmts.staticCall(lpAmtFP("100"));
        expect(r[0]).to.eq(usdFP("53.488372"));
        expect(r[1]).to.eq(perpFP("46.511627906"));
      });
    });

    describe("when redeeming entire supply", function () {
      it("should return redemption amounts", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        const r = await billBroker.computeRedemptionAmts.staticCall(lpAmtFP("215"));
        expect(r[0]).to.eq(usdFP("115"));
        expect(r[1]).to.eq(perpFP("100"));
      });
    });

    describe("when fee is zero", function () {
      it("should withhold and return redemption amounts", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await billBroker.updateFees({
          mintFeePerc: 0n,
          burnFeePerc: percentageFP("0.1"),
          perpToUSDSwapFeePercs: {
            lower: 0n,
            upper: 0n,
          },
          usdToPerpSwapFeePercs: {
            lower: 0n,
            upper: 0n,
          },
          protocolSwapSharePerc: 0n,
        });
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        const r = await billBroker.computeRedemptionAmts.staticCall(lpAmtFP("215"));
        expect(r[0]).to.eq(usdFP("103.5"));
        expect(r[1]).to.eq(perpFP("90"));
      });
    });

    describe("when the pool has only usd", function () {
      it("should return redemption amounts", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );

        await usd.approve(billBroker.target, usdFP("115"));
        await billBroker.swapUSDForPerps(usdFP("115"), 0n);
        expect(await perp.balanceOf(billBroker.target)).to.eq(0n);

        const s = await billBroker.reserveState.staticCall();
        expect(
          await billBroker.assetRatio({
            usdBalance: s[0],
            perpBalance: s[1],
            usdPrice: s[2],
            perpPrice: s[3],
          }),
        ).to.eq(ethers.MaxUint256);

        const r = await billBroker.computeRedemptionAmts.staticCall(lpAmtFP("100"));
        expect(r[0]).to.eq(usdFP("106.976744"));
        expect(r[1]).to.eq(0n);
      });
    });

    describe("when the pool has only perps", function () {
      it("should return redemption amounts", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );

        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.swapPerpsForUSD(perpFP("100"), 0n);
        expect(await usd.balanceOf(billBroker.target)).to.eq(0n);

        const s = await billBroker.reserveState.staticCall();
        expect(
          await billBroker.assetRatio({
            usdBalance: s[0],
            perpBalance: s[1],
            usdPrice: s[2],
            perpPrice: s[3],
          }),
        ).to.eq(0);

        const r = await billBroker.computeRedemptionAmts.staticCall(lpAmtFP("100"));
        expect(r[0]).to.eq(0n);
        expect(r[1]).to.eq(perpFP("93.023255813"));
      });
    });
  });

  describe("#redeem", function () {
    describe("when paused", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.pause();
        await expect(billBroker.redeem.staticCall(0n)).to.be.reverted;
      });
    });

    describe("when burn amount is zero", function () {
      it("should return zero", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        const r = await billBroker.redeem.staticCall(0n);
        expect(r[0]).to.eq(0n);
        expect(r[1]).to.eq(0n);
      });
    });

    describe("when burning more than balance", function () {
      it("should return zero", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await expect(billBroker.redeem.staticCall(lpAmtFP("1000"))).to.be.reverted;
      });
    });

    describe("on partial redemption", function () {
      it("should burn lp tokens", async function () {
        const { billBroker, usd, perp, otherUser } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await billBroker.transfer(await otherUser.getAddress(), lpAmtFP("101"));
        await expect(() =>
          billBroker.connect(otherUser).redeem(lpAmtFP("100")),
        ).to.changeTokenBalance(billBroker, otherUser, lpAmtFP("-100"));
        expect(await billBroker.balanceOf(await otherUser.getAddress())).to.eq(
          lpAmtFP("1"),
        );
        expect(await billBroker.totalSupply()).to.eq(lpAmtFP("115"));
      });

      it("should not change other balances", async function () {
        const { billBroker, usd, perp, deployer, otherUser } = await loadFixture(
          setupContracts,
        );
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await billBroker.transfer(await otherUser.getAddress(), lpAmtFP("101"));
        await expect(() =>
          billBroker.connect(otherUser).redeem(lpAmtFP("100")),
        ).to.changeTokenBalance(billBroker, deployer, 0n);
      });

      it("should return returned amounts", async function () {
        const { billBroker, usd, perp, otherUser } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await billBroker.transfer(await otherUser.getAddress(), lpAmtFP("101"));
        const r = await billBroker.connect(otherUser).redeem.staticCall(lpAmtFP("100"));
        expect(r[0]).to.eq(usdFP("53.488372"));
        expect(r[1]).to.eq(perpFP("46.511627906"));
      });

      it("should transfer usd to user", async function () {
        const { billBroker, usd, perp, otherUser } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await billBroker.transfer(await otherUser.getAddress(), lpAmtFP("101"));
        await expect(() =>
          billBroker.connect(otherUser).redeem(lpAmtFP("100")),
        ).to.changeTokenBalance(usd, otherUser, usdFP("53.488372"));
      });

      it("should transfer perps to user", async function () {
        const { billBroker, usd, perp, otherUser } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await billBroker.transfer(await otherUser.getAddress(), lpAmtFP("101"));
        await expect(() =>
          billBroker.connect(otherUser).redeem(lpAmtFP("100")),
        ).to.changeTokenBalance(perp, otherUser, perpFP("46.511627906"));
      });
    });

    describe("on complete redemption", function () {
      it("should burn lp tokens", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await expect(() => billBroker.redeem(lpAmtFP("214.99"))).to.changeTokenBalance(
          billBroker,
          deployer,
          lpAmtFP("-214.99"),
        );
        expect(await billBroker.balanceOf(await deployer.getAddress())).to.eq(0n);
        expect(await billBroker.totalSupply()).to.eq(lpAmtFP("0.01"));
      });

      it("should return returned amounts", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        const r = await billBroker.redeem.staticCall(lpAmtFP("214.99"));
        expect(r[0]).to.eq(usdFP("114.994651"));
        expect(r[1]).to.eq(perpFP("99.995348837"));
      });

      it("should transfer usd to user", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await expect(() => billBroker.redeem(lpAmtFP("214.99"))).to.changeTokenBalance(
          usd,
          deployer,
          usdFP("114.994651"),
        );
      });

      it("should transfer perps to user", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await expect(() => billBroker.redeem(lpAmtFP("214.99"))).to.changeTokenBalance(
          perp,
          deployer,
          perpFP("99.995348837"),
        );
      });
    });

    describe("when the pool has only usd", function () {
      it("should burn lp tokens", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );

        await usd.approve(billBroker.target, usdFP("115"));
        await billBroker.swapUSDForPerps(usdFP("115"), 0n);
        expect(await perp.balanceOf(billBroker.target)).to.eq(0n);

        const s = await billBroker.reserveState.staticCall();
        expect(
          await billBroker.assetRatio({
            usdBalance: s[0],
            perpBalance: s[1],
            usdPrice: s[2],
            perpPrice: s[3],
          }),
        ).to.eq(ethers.MaxUint256);

        const perpBal = await perp.balanceOf(await deployer.getAddress());
        await expect(() => billBroker.redeem(lpAmtFP("100"))).to.changeTokenBalance(
          usd,
          deployer,
          usdFP("106.976744"),
        );
        const perpBal_ = await perp.balanceOf(await deployer.getAddress());
        expect(perpBal_ - perpBal).to.eq(0n);
      });
    });

    describe("when the pool has only perps", function () {
      it("should burn lp tokens", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );

        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.swapPerpsForUSD(perpFP("100"), 0n);
        expect(await usd.balanceOf(billBroker.target)).to.eq(0n);

        const s = await billBroker.reserveState.staticCall();
        expect(
          await billBroker.assetRatio({
            usdBalance: s[0],
            perpBalance: s[1],
            usdPrice: s[2],
            perpPrice: s[3],
          }),
        ).to.eq(0);

        const usdBal = await usd.balanceOf(await deployer.getAddress());
        await expect(() => billBroker.redeem(lpAmtFP("100"))).to.changeTokenBalance(
          perp,
          deployer,
          perpFP("93.023255813"),
        );
        const usdBal_ = await usd.balanceOf(await deployer.getAddress());
        expect(usdBal_ - usdBal).to.eq(0n);
      });
    });
  });
});
