import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, usdFP, perpFP, lpAmtFP, percentageFP } from "./helpers";

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
    await pricingStrategy.mockMethod("perpPrice()", [0, false]);
    await pricingStrategy.mockMethod("usdPrice()", [0, false]);

    const BillBroker = await ethers.getContractFactory("BillBroker");
    const billBroker = await upgrades.deployProxy(
      BillBroker.connect(deployer),
      ["BillBroker LP", "LP token", usd.target, perp.target, pricingStrategy.target],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );
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
        const r = await billBroker.computeMintAmt.staticCall(usdFP("0"), perpFP("0"));
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
        const r = await billBroker.deposit.staticCall(
          usdFP("0"),
          perpFP("0"),
          usdFP("0"),
          perpFP("0"),
        );
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
        ).to.changeTokenBalance(billBroker, deployer, lpAmtFP("215"));
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
        expect(r).to.eq(lpAmtFP("215"));
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
        ).to.changeTokenBalance(billBroker, deployer, lpAmtFP("193.5"));
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
        await expect(() => billBroker.redeem(lpAmtFP("215"))).to.changeTokenBalance(
          billBroker,
          deployer,
          lpAmtFP("-215"),
        );
        expect(await billBroker.balanceOf(await deployer.getAddress())).to.eq(0n);
        expect(await billBroker.totalSupply()).to.eq(0n);
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
        const r = await billBroker.redeem.staticCall(lpAmtFP("215"));
        expect(r[0]).to.eq(usdFP("115"));
        expect(r[1]).to.eq(perpFP("100"));
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
        await expect(() => billBroker.redeem(lpAmtFP("215"))).to.changeTokenBalance(
          usd,
          deployer,
          usdFP("115"),
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
        await expect(() => billBroker.redeem(lpAmtFP("215"))).to.changeTokenBalance(
          perp,
          deployer,
          perpFP("100"),
        );
      });
    });
  });
});
