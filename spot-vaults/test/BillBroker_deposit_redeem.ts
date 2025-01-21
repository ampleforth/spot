import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, usdFP, perpFP, lpAmtFP, percFP, priceFP } from "./helpers";

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
    const oracle = new DMock("IPerpPricer");
    await oracle.deploy();
    await oracle.mockMethod("decimals()", [18]);
    await oracle.mockMethod("perpFmvUsdPrice()", [priceFP("1.15"), true]);
    await oracle.mockMethod("usdPrice()", [priceFP("1"), true]);

    const BillBroker = await ethers.getContractFactory("BillBroker");
    const billBroker = await upgrades.deployProxy(
      BillBroker.connect(deployer),
      ["BillBroker LP", "LP token", usd.target, perp.target, oracle.target],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );
    await billBroker.updateFees({
      mintFeePerc: 0n,
      burnFeePerc: 0n,
      perpToUSDSwapFeeFactors: {
        lower: percFP("1"),
        upper: percFP("1"),
      },
      usdToPerpSwapFeeFactors: {
        lower: percFP("1"),
        upper: percFP("1"),
      },
      protocolSwapSharePerc: 0n,
    });
    await usd.mint(await deployer.getAddress(), usdFP("2000"));
    await perp.mint(await deployer.getAddress(), perpFP("2000"));
    await usd.mint(await otherUser.getAddress(), usdFP("2000"));
    await perp.mint(await otherUser.getAddress(), perpFP("2000"));
    return { deployer, otherUser, usd, perp, oracle, billBroker };
  }

  async function assetRatio(billBroker) {
    const r = await billBroker.reserveState.staticCall();
    return billBroker.assetRatio({
      usdBalance: r[0],
      perpBalance: r[1],
      usdPrice: r[2],
      perpPrice: r[3],
    });
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
          mintFeePerc: percFP("0.1"),
          burnFeePerc: 0n,
          perpToUSDSwapFeeFactors: {
            lower: percFP("1"),
            upper: percFP("1"),
          },
          usdToPerpSwapFeeFactors: {
            lower: percFP("1"),
            upper: percFP("1"),
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

        expect(await assetRatio(billBroker)).to.eq(ethers.MaxInt256);

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

        expect(await assetRatio(billBroker)).to.eq(0);

        const r = await billBroker.computeMintAmt.staticCall(0n, perpFP("100"));
        expect(r[0]).to.eq(lpAmtFP("107.5"));
        expect(r[1]).to.eq(0n);
        expect(r[2]).to.eq(perpFP("100"));
      });
    });
  });

  describe("#computeMintAmtWithUSD", function () {
    describe("when usdAmtIn is zero", function () {
      it("should return zero", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        expect(await billBroker.computeMintAmtWithUSD.staticCall(0n)).to.eq(0n);
      });
    });

    describe("when total supply is zero", function () {
      it("should return zero", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        expect(await billBroker.computeMintAmtWithUSD.staticCall(usdFP("100"))).to.eq(0n);
      });
    });

    describe("when fee = 0", function () {
      it("should return the mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("200"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("200"),
          usdFP("115"),
          perpFP("200"),
        );
        expect(await billBroker.computeMintAmtWithUSD.staticCall(usdFP("11.5"))).to.eq(
          lpAmtFP("10.5"),
        );
      });
    });

    describe("when swapFee > 0", function () {
      it("should return the mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("200"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("200"),
          usdFP("115"),
          perpFP("200"),
        );
        await billBroker.updateFees({
          mintFeePerc: 0n,
          burnFeePerc: 0n,
          perpToUSDSwapFeeFactors: {
            lower: percFP("1"),
            upper: percFP("1"),
          },
          usdToPerpSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.15"),
          },
          protocolSwapSharePerc: 0n,
        });
        expect(await billBroker.computeMintAmtWithUSD.staticCall(usdFP("11.5"))).to.eq(
          lpAmtFP("10.3337499847826086956750"),
        );
      });
    });

    describe("when the pool has only perps", function () {
      it("should mint lp tokens", async function () {
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

        expect(await assetRatio(billBroker)).to.eq(0);
        expect(await billBroker.computeMintAmtWithUSD.staticCall(usdFP("115"))).to.eq(
          lpAmtFP("107.5"),
        );
      });
    });
  });

  describe("#computeMintAmtWithPerp", function () {
    describe("when perpAmtIn is zero", function () {
      it("should return zero", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        expect(await billBroker.computeMintAmtWithPerp.staticCall(0n)).to.eq(0n);
      });
    });

    describe("when total supply is zero", function () {
      it("should return zero", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        expect(await billBroker.computeMintAmtWithPerp.staticCall(perpFP("100"))).to.eq(
          0n,
        );
      });
    });

    describe("when fee = 0", function () {
      it("should return the mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("200"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("200"),
          perpFP("100"),
          usdFP("200"),
          perpFP("100"),
        );
        expect(await billBroker.computeMintAmtWithPerp.staticCall(perpFP("10.5"))).to.eq(
          lpAmtFP("11.5"),
        );
      });
    });

    describe("when swapFee > 0", function () {
      it("should return the mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("200"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("200"),
          perpFP("100"),
          usdFP("200"),
          perpFP("100"),
        );
        await billBroker.updateFees({
          mintFeePerc: 0n,
          burnFeePerc: 0n,
          perpToUSDSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.1"),
          },
          usdToPerpSwapFeeFactors: {
            lower: percFP("1"),
            upper: percFP("1"),
          },
          protocolSwapSharePerc: 0n,
        });
        expect(await billBroker.computeMintAmtWithPerp.staticCall(perpFP("10.5"))).to.eq(
          lpAmtFP("11.3284811507845238095375"),
        );
      });
    });

    describe("when the pool has only usd", function () {
      it("should mint lp tokens", async function () {
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

        expect(await assetRatio(billBroker)).to.eq(ethers.MaxInt256);
        expect(await billBroker.computeMintAmtWithPerp.staticCall(perpFP("100"))).to.eq(
          lpAmtFP("107.5"),
        );
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
          mintFeePerc: 0n,
          burnFeePerc: 0n,
          perpToUSDSwapFeeFactors: {
            lower: percFP("1"),
            upper: percFP("1"),
          },
          usdToPerpSwapFeeFactors: {
            lower: percFP("1"),
            upper: percFP("1"),
          },
          protocolSwapSharePerc: 0n,
        });
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await expect(() =>
          billBroker.deposit(usdFP("115"), perpFP("100"), usdFP("115"), perpFP("100")),
        ).to.changeTokenBalance(billBroker, deployer, lpAmtFP("214.99"));
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

        expect(await assetRatio(billBroker)).to.eq(ethers.MaxInt256);

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

        expect(await assetRatio(billBroker)).to.eq(0);

        await perp.approve(billBroker.target, perpFP("100"));
        await expect(() =>
          billBroker.deposit(usdFP("100"), perpFP("100"), 0n, perpFP("100")),
        ).to.changeTokenBalance(billBroker, deployer, lpAmtFP("107.5"));
      });
    });
  });

  describe("#depositUSD", function () {
    describe("when paused", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.pause();
        await expect(billBroker.depositUSD(usdFP("115"), percFP("1"))).to.be.reverted;
      });
    });

    describe("when usdAmtIn is zero", function () {
      it("should return zero", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        const r = await billBroker.depositUSD.staticCall(0n, percFP("1"));
        expect(r).to.eq(0n);
      });
    });

    describe("when assetRatioPre > 1", function () {
      it("should return zero", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("230"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await usd.approve(billBroker.target, usdFP("100"));
        expect(
          await billBroker.depositUSD.staticCall(usdFP("100"), ethers.MaxInt256),
        ).to.eq(0n);
      });
    });

    describe("when assetRatioPost > 1", function () {
      it("should return zero", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("100"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("100"),
          perpFP("100"),
          usdFP("100"),
          perpFP("100"),
        );
        await usd.approve(billBroker.target, usdFP("100"));
        expect(
          await billBroker.depositUSD.staticCall(usdFP("100"), ethers.MaxInt256),
        ).to.eq(0n);
      });
    });

    describe("when assetRatioPre = 1", function () {
      it("should return the mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await usd.approve(billBroker.target, usdFP("1"));
        expect(
          await billBroker.depositUSD.staticCall(usdFP("1"), ethers.MaxInt256),
        ).to.eq(0n);
      });
    });

    describe("when assetRatioPost = 1", function () {
      it("should return the mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("200"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("200"),
          usdFP("115"),
          perpFP("200"),
        );
        await usd.approve(billBroker.target, usdFP("115"));
        expect(
          await billBroker.depositUSD.staticCall(usdFP("115"), ethers.MaxInt256),
        ).to.eq(lpAmtFP("105"));
      });
    });

    describe("when slippage is too high", function () {
      it("should revert asset ratio increases beyond limit", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("200"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("200"),
          usdFP("115"),
          perpFP("200"),
        );

        await usd.approve(billBroker.target, usdFP("10"));
        await expect(
          billBroker.depositUSD(usdFP("10"), percFP("0.50")),
        ).to.be.revertedWithCustomError(billBroker, "SlippageTooHigh");
      });
    });

    describe("successful deposit", function () {
      it("should transfer usd from user", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("200"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("200"),
          usdFP("115"),
          perpFP("200"),
        );

        await usd.approve(billBroker.target, usdFP("10"));
        await expect(() =>
          billBroker.depositUSD(usdFP("10"), percFP("1")),
        ).to.changeTokenBalance(usd, deployer, usdFP("-10"));
      });

      it("should mint lp tokens", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("200"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("200"),
          usdFP("115"),
          perpFP("200"),
        );

        await usd.approve(billBroker.target, usdFP("10"));
        await expect(() =>
          billBroker.depositUSD(usdFP("10"), percFP("1")),
        ).to.changeTokenBalance(
          billBroker,
          deployer,
          lpAmtFP("9.130434782608695652173912"),
        );
        expect(await billBroker.totalSupply()).to.eq(
          lpAmtFP("324.130434782608695652173912"),
        );
      });

      it("should emit DepositUSD", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("200"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("200"),
          usdFP("115"),
          perpFP("200"),
        );
        await usd.approve(billBroker.target, usdFP("10"));
        const r = await billBroker.reserveState.staticCall();
        await expect(billBroker.depositUSD(usdFP("10"), percFP("1")))
          .to.emit(billBroker, "DepositUSD")
          .withArgs(usdFP("10"), r);
        expect(await billBroker.totalSupply()).to.eq(
          lpAmtFP("324.130434782608695652173912"),
        );
      });

      it("should return mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("200"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("200"),
          usdFP("115"),
          perpFP("200"),
        );

        await usd.approve(billBroker.target, usdFP("10"));
        const r = await billBroker.depositUSD.staticCall(usdFP("10"), percFP("1"));
        expect(r).to.eq(lpAmtFP("9.130434782608695652173912"));
      });
    });

    describe("when fee > 0", function () {
      it("should withhold fees and mint lp tokens", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await billBroker.updateFees({
          mintFeePerc: 0n,
          burnFeePerc: 0n,
          perpToUSDSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.5"),
          },
          usdToPerpSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.1"),
          },
          protocolSwapSharePerc: 0n,
        });

        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("200"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("200"),
          usdFP("115"),
          perpFP("200"),
        );

        await usd.approve(billBroker.target, usdFP("10"));
        await expect(() =>
          billBroker.depositUSD(usdFP("10"), percFP("1")),
        ).to.changeTokenBalance(
          billBroker,
          deployer,
          lpAmtFP("8.984877117391304347826085"),
        );

        const r = await billBroker.computeRedemptionAmts.staticCall(
          lpAmtFP("8.984877117391304347826085"),
        );
        expect(r[0]).to.eq(usdFP("3.466549"));
        expect(r[1]).to.eq(perpFP("5.546479327"));
      });

      it("should be roughly equivalent to swap+deposit", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await billBroker.updateFees({
          mintFeePerc: 0n,
          burnFeePerc: 0n,
          perpToUSDSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.5"),
          },
          usdToPerpSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.1"),
          },
          protocolSwapSharePerc: 0n,
        });

        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("200"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("200"),
          usdFP("115"),
          perpFP("200"),
        );

        await usd.approve(billBroker.target, usdFP("10"));
        await perp.approve(billBroker.target, perpFP("10"));
        await billBroker.swapUSDForPerps(usdFP("6.535"), 0n);
        await expect(() =>
          billBroker.deposit(usdFP("3.465"), percFP("10"), 0n, 0n),
        ).to.changeTokenBalance(
          billBroker,
          deployer,
          lpAmtFP("8.980746287077796519521125"),
        );
        const r = await billBroker.computeRedemptionAmts.staticCall(
          lpAmtFP("8.980746287077796519521125"),
        );
        expect(r[0]).to.eq(usdFP("3.464999"));
        expect(r[1]).to.eq(perpFP("5.544098565"));
      });
    });
  });

  describe("#depositPerp", function () {
    describe("when paused", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.pause();
        await expect(billBroker.depositPerp(perpFP("100"), percFP("1"))).to.be.reverted;
      });
    });

    describe("when perpAmtIn is zero", function () {
      it("should return zero", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        const r = await billBroker.depositPerp.staticCall(0n, percFP("1"));
        expect(r).to.eq(0n);
      });
    });

    describe("when assetRatioPre < 1", function () {
      it("should return zero", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("200"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("200"),
          perpFP("100"),
          usdFP("200"),
          perpFP("100"),
        );
        await perp.approve(billBroker.target, perpFP("100"));
        expect(await billBroker.depositPerp.staticCall(perpFP("100"), 0n)).to.eq(0n);
      });
    });

    describe("when assetRatioPost < 1", function () {
      it("should return zero", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("120"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("120"),
          perpFP("100"),
          usdFP("120"),
          perpFP("100"),
        );
        await perp.approve(billBroker.target, perpFP("100"));
        expect(await billBroker.depositPerp.staticCall(perpFP("100"), 0n)).to.eq(0n);
      });
    });

    describe("when assetRatioPre = 1", function () {
      it("should return the mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("115"),
          perpFP("100"),
          usdFP("115"),
          perpFP("100"),
        );
        await perp.approve(billBroker.target, perpFP("1"));
        expect(await billBroker.depositPerp.staticCall(perpFP("1"), 0n)).to.eq(0n);
      });
    });

    describe("when assetRatioPost = 1", function () {
      it("should return the mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("115"));
        await perp.approve(billBroker.target, perpFP("90"));
        await billBroker.deposit(usdFP("115"), perpFP("90"), usdFP("115"), perpFP("90"));
        await perp.approve(billBroker.target, perpFP("10"));
        expect(await billBroker.depositPerp.staticCall(perpFP("10"), 0n)).to.eq(
          lpAmtFP("10.789473684210526315789472"),
        );
      });
    });

    describe("when slippage is too high", function () {
      it("should revert asset ratio reduces below the limit", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("230"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("230"),
          perpFP("100"),
          usdFP("230"),
          perpFP("100"),
        );

        await perp.approve(billBroker.target, perpFP("10"));
        await expect(
          billBroker.depositPerp(perpFP("10"), percFP("1.85")),
        ).to.be.revertedWithCustomError(billBroker, "SlippageTooHigh");
      });
    });

    describe("successful deposit", function () {
      it("should transfer perps from user", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("230"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("230"),
          perpFP("100"),
          usdFP("230"),
          perpFP("100"),
        );

        await perp.approve(billBroker.target, perpFP("10"));
        await expect(() =>
          billBroker.depositPerp(perpFP("10"), percFP("1")),
        ).to.changeTokenBalance(perp, deployer, perpFP("-10"));
      });

      it("should mint lp tokens", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("230"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("230"),
          perpFP("100"),
          usdFP("230"),
          perpFP("100"),
        );

        await perp.approve(billBroker.target, perpFP("10"));
        await expect(() =>
          billBroker.depositPerp(perpFP("10"), percFP("1")),
        ).to.changeTokenBalance(billBroker, deployer, lpAmtFP("11"));
        expect(await billBroker.totalSupply()).to.eq(lpAmtFP("341"));
      });

      it("should emit DepositPerp", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("230"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("230"),
          perpFP("100"),
          usdFP("230"),
          perpFP("100"),
        );

        await perp.approve(billBroker.target, perpFP("10"));
        const r = await billBroker.reserveState.staticCall();
        await expect(billBroker.depositPerp(perpFP("10"), percFP("1")))
          .to.emit(billBroker, "DepositPerp")
          .withArgs(perpFP("10"), r);
        expect(await billBroker.totalSupply()).to.eq(lpAmtFP("341"));
      });

      it("should return mint amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("230"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("230"),
          perpFP("100"),
          usdFP("230"),
          perpFP("100"),
        );

        await perp.approve(billBroker.target, perpFP("10"));
        const r = await billBroker.depositPerp.staticCall(perpFP("10"), percFP("1"));
        expect(r).to.eq(lpAmtFP("11"));
      });
    });

    describe("when fee > 0", function () {
      it("should withhold fees and mint lp tokens", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("230"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("230"),
          perpFP("100"),
          usdFP("230"),
          perpFP("100"),
        );

        await billBroker.updateFees({
          mintFeePerc: 0n,
          burnFeePerc: 0n,
          perpToUSDSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.1"),
          },
          usdToPerpSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.5"),
          },
          protocolSwapSharePerc: 0n,
        });
        await perp.approve(billBroker.target, perpFP("10"));
        await expect(() =>
          billBroker.depositPerp(perpFP("10"), percFP("1")),
        ).to.changeTokenBalance(billBroker, deployer, lpAmtFP("10.825833333315"));

        const r = await billBroker.computeRedemptionAmts.staticCall(
          lpAmtFP("10.825833333315"),
        );
        expect(r[0]).to.eq(usdFP("7.305613"));
        expect(r[1]).to.eq(perpFP("3.493988865"));
      });

      it("should be roughly equivalent to swap+deposit", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await usd.approve(billBroker.target, usdFP("230"));
        await perp.approve(billBroker.target, perpFP("100"));
        await billBroker.deposit(
          usdFP("230"),
          perpFP("100"),
          usdFP("230"),
          perpFP("100"),
        );

        await billBroker.updateFees({
          mintFeePerc: 0n,
          burnFeePerc: 0n,
          perpToUSDSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.1"),
          },
          usdToPerpSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.5"),
          },
          protocolSwapSharePerc: 0n,
        });
        await perp.approve(billBroker.target, perpFP("15"));
        await usd.approve(billBroker.target, usdFP("15"));
        await billBroker.swapPerpsForUSD(perpFP("6"), 0n);
        await expect(() =>
          billBroker.deposit(usdFP("7.30"), percFP("5"), 0n, 0n),
        ).to.changeTokenBalance(
          billBroker,
          deployer,
          lpAmtFP("10.789506096809951964527651"),
        );
        const r = await billBroker.computeRedemptionAmts.staticCall(
          lpAmtFP("10.789506096809951964527651"),
        );
        expect(r[0]).to.eq(usdFP("7.299999"));
        expect(r[1]).to.eq(perpFP("3.465720140"));
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

    describe("when fee > 0", function () {
      it("should withhold and return redemption amounts", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await billBroker.updateFees({
          mintFeePerc: 0n,
          burnFeePerc: percFP("0.1"),
          perpToUSDSwapFeeFactors: {
            lower: percFP("1"),
            upper: percFP("1"),
          },
          usdToPerpSwapFeeFactors: {
            lower: percFP("1"),
            upper: percFP("1"),
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

        expect(await assetRatio(billBroker)).to.eq(ethers.MaxInt256);

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

        expect(await assetRatio(billBroker)).to.eq(0);

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

        expect(await assetRatio(billBroker)).to.eq(ethers.MaxInt256);

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

        expect(await assetRatio(billBroker)).to.eq(0);

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
