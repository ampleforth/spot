import { ethers, upgrades } from "hardhat";
import { Contract } from "ethers";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, usdFP, perpFP, priceFP, percFP } from "./helpers";

async function updateFees(billBroker: Contract, fees: any) {
  const currentFees = await billBroker.fees();
  await billBroker.updateFees({
    ...{
      mintFeePerc: currentFees[0],
      burnFeePerc: currentFees[1],
      perpToUSDSwapFeePercs: {
        lower: currentFees[2][0],
        upper: currentFees[2][1],
      },
      usdToPerpSwapFeePercs: {
        lower: currentFees[3][0],
        upper: currentFees[3][1],
      },
      protocolSwapSharePerc: currentFees[4],
    },
    ...fees,
  });
}

async function checkUSDToPerpSwapAmt(
  billBroker: Contract,
  usdAmtIn: BigInt,
  reserveState: any,
  amoutsOut: any,
) {
  const r = await billBroker[
    "computeUSDToPerpSwapAmt(uint256,(uint256,uint256,uint256,uint256))"
  ](usdAmtIn, reserveState);
  expect(r[0]).to.eq(amoutsOut[0]);
  expect(r[1]).to.eq(amoutsOut[1]);
  expect(r[2]).to.eq(amoutsOut[2]);
}

async function checkPerpToUSDSwapAmt(
  billBroker: Contract,
  perpAmtIn: BigInt,
  reserveState: any,
  amoutsOut: any,
) {
  const r = await billBroker[
    "computePerpToUSDSwapAmt(uint256,(uint256,uint256,uint256,uint256))"
  ](perpAmtIn, reserveState);
  expect(r[0]).to.eq(amoutsOut[0]);
  expect(r[1]).to.eq(amoutsOut[1]);
  expect(r[2]).to.eq(amoutsOut[2]);
}

async function reserveState(billBroker: Contract) {
  const r = await billBroker.reserveState.staticCall();
  return {
    usdBalance: r[0],
    perpBalance: r[1],
    usdPrice: r[2],
    perpPrice: r[3],
  };
}

async function assetRatio(billBroker: Contract) {
  return billBroker.assetRatio(await reserveState(billBroker));
}

describe("BillBroker", function () {
  async function setupContracts() {
    const accounts = await ethers.getSigners();
    const deployer = accounts[0];
    const feeCollector = accounts[1];

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
    await oracle.mockMethod("perpBeta()", [percFP("1"), true]);

    const BillBroker = await ethers.getContractFactory("BillBroker");
    const billBroker = await upgrades.deployProxy(
      BillBroker.connect(deployer),
      ["BillBroker LP", "LP token", usd.target, perp.target, oracle.target],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );
    await updateFees(billBroker, {
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
    await billBroker.updateARBounds(
      [percFP("0.9"), percFP("1.1")],
      [percFP("0.75"), percFP("1.25")],
    );

    await usd.mint(billBroker.target, usdFP("115000"));
    await perp.mint(billBroker.target, perpFP("100000"));
    await usd.mint(await deployer.getAddress(), usdFP("250000"));
    await perp.mint(await deployer.getAddress(), perpFP("250000"));
    await usd.approve(billBroker.target, usdFP("25000"));
    await perp.approve(billBroker.target, perpFP("25000"));

    const r = await reserveState(billBroker);
    expect(r.usdBalance).to.eq(usdFP("115000"));
    expect(r.perpBalance).to.eq(perpFP("100000"));
    expect(r.usdPrice).to.eq(priceFP("1"));
    expect(r.perpPrice).to.eq(priceFP("1.15"));

    return { deployer, feeCollector, usd, perp, oracle, billBroker };
  }

  describe("#computeUSDToPerpSwapAmt", function () {
    it("should return the perp amount and fees", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await checkUSDToPerpSwapAmt(
        billBroker,
        usdFP("115"),
        [usdFP("115000"), perpFP("100000"), priceFP("1"), priceFP("1.15")],
        [perpFP("100"), 0n, 0n],
      );
    });

    it("should return the perp amount and fees", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await checkUSDToPerpSwapAmt(
        billBroker,
        usdFP("100"),
        [usdFP("110000"), perpFP("100000"), priceFP("1"), priceFP("1")],
        [perpFP("100"), 0n, 0n],
      );
    });

    it("should return the perp amount and fees", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await checkUSDToPerpSwapAmt(
        billBroker,
        usdFP("11111"),
        [usdFP("100000"), perpFP("100000"), priceFP("1"), priceFP("1")],
        [perpFP("11111"), 0n, 0n],
      );
    });

    it("should return the perp amount and fees", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await checkUSDToPerpSwapAmt(
        billBroker,
        usdFP("11112"),
        [usdFP("100000"), perpFP("100000"), priceFP("1"), priceFP("1")],

        [0n, 0n, 0n],
      );
    });

    it("should return the perp amount and fees", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await checkUSDToPerpSwapAmt(
        billBroker,
        usdFP("100"),
        [usdFP("100000"), perpFP("100000"), priceFP("1"), priceFP("0.9")],
        [perpFP("111.111111"), 0n, 0n],
      );
    });

    describe("when fees are set", async function () {
      it("should return the perp amount and fees", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        await checkUSDToPerpSwapAmt(
          billBroker,
          usdFP("115"),
          [usdFP("115000"), perpFP("100000"), priceFP("1"), priceFP("1.15")],
          [perpFP("95"), perpFP("5"), 0n],
        );
      });

      it("should return the perp amount and fees", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        await checkUSDToPerpSwapAmt(
          billBroker,
          usdFP("100"),
          [usdFP("100000"), perpFP("100000"), priceFP("1"), priceFP("1")],
          [perpFP("95"), perpFP("5"), 0n],
        );
      });

      it("should return the perp amount and fees", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        await checkUSDToPerpSwapAmt(
          billBroker,
          usdFP("100"),
          [usdFP("100000"), perpFP("100000"), priceFP("1"), priceFP("0.9")],
          [perpFP("101.460470381"), perpFP("9.650640619"), 0n],
        );
      });

      it("should return the perp amount and fees", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        await checkUSDToPerpSwapAmt(
          billBroker,
          usdFP("10000"),
          [usdFP("100000"), perpFP("100000"), priceFP("1"), priceFP("1")],
          [perpFP("8491.666666667"), perpFP("1508.333333333"), 0n],
        );
      });

      it("should return the perp amount and fees", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        await checkUSDToPerpSwapAmt(
          billBroker,
          usdFP("20000"),
          [usdFP("100000"), perpFP("100000"), priceFP("1"), priceFP("1")],

          [0n, 0n, 0n],
        );
      });
    });

    describe("when protocol fees are set", async function () {
      it("should return the perp amount and fees", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        await checkUSDToPerpSwapAmt(
          billBroker,
          usdFP("115"),
          [usdFP("115000"), perpFP("100000"), priceFP("1"), priceFP("1.15")],
          [perpFP("95"), perpFP("4.5"), perpFP("0.5")],
        );
      });
    });

    describe("when the pool has only usd", function () {
      it("should revert", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);

        await billBroker.updateARBounds([0n, ethers.MaxUint256], [0n, ethers.MaxUint256]);
        await usd.approve(billBroker.target, usdFP("115000"));
        await billBroker.swapUSDForPerps(usdFP("115000"), 0n);
        expect(await perp.balanceOf(billBroker.target)).to.eq(0n);

        await expect(
          billBroker[
            "computeUSDToPerpSwapAmt(uint256,(uint256,uint256,uint256,uint256))"
          ](usdFP("100"), [usdFP("100000"), 0n, priceFP("1"), priceFP("1")]),
        ).to.be.reverted;
      });
    });

    describe("when the pool has only perps", function () {
      it("should return the swap amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);

        await billBroker.updateARBounds([0n, ethers.MaxUint256], [0n, ethers.MaxUint256]);
        await perp.approve(billBroker.target, perpFP("100000"));
        await billBroker.swapPerpsForUSD(perpFP("100000"), 0n);
        expect(await usd.balanceOf(billBroker.target)).to.eq(0n);

        await checkUSDToPerpSwapAmt(
          billBroker,
          usdFP("100"),
          [0n, perpFP("100000"), priceFP("1"), priceFP("1")],
          [perpFP("100"), 0n, 0n],
        );
      });
    });
  });

  describe("#computePerpToUSDSwapAmt", function () {
    it("should return the perp amount and fees", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await checkPerpToUSDSwapAmt(
        billBroker,
        perpFP("100"),
        [usdFP("115000"), perpFP("100000"), priceFP("1"), priceFP("1.15")],
        [usdFP("115"), 0n, 0n],
      );
    });

    it("should return the perp amount and fees", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await checkPerpToUSDSwapAmt(
        billBroker,
        perpFP("100"),
        [usdFP("110000"), perpFP("100000"), priceFP("1"), priceFP("1")],
        [usdFP("100"), 0n, 0n],
      );
    });

    it("should return the perp amount and fees", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await checkPerpToUSDSwapAmt(
        billBroker,
        perpFP("14285"),
        [usdFP("100000"), perpFP("100000"), priceFP("1"), priceFP("1")],
        [usdFP("14285"), 0n, 0n],
      );
    });

    it("should return the perp amount and fees", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await checkPerpToUSDSwapAmt(
        billBroker,
        perpFP("14286"),
        [usdFP("100000"), perpFP("100000"), priceFP("1"), priceFP("1")],
        [0n, 0n, 0n],
      );
    });

    it("should return the perp amount and fees", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await checkPerpToUSDSwapAmt(
        billBroker,
        perpFP("100"),
        [usdFP("100000"), perpFP("100000"), priceFP("1"), priceFP("0.9")],
        [usdFP("90"), 0n, 0n],
      );
    });

    describe("when fees are set", async function () {
      it("should return the perp amount and fees", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        await checkPerpToUSDSwapAmt(
          billBroker,
          perpFP("100"),
          [usdFP("115000"), perpFP("100000"), priceFP("1"), priceFP("1.15")],
          [usdFP("103.5"), usdFP("11.5"), 0n],
        );
      });

      it("should return the perp amount and fees", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        await checkPerpToUSDSwapAmt(
          billBroker,
          perpFP("100"),
          [usdFP("110000"), perpFP("100000"), priceFP("1"), priceFP("1")],
          [usdFP("90"), usdFP("10"), 0n],
        );
      });

      it("should return the perp amount and fees", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        await checkPerpToUSDSwapAmt(
          billBroker,
          perpFP("14285"),
          [usdFP("100000"), perpFP("100000"), priceFP("1"), priceFP("1")],
          [usdFP("11142.474991"), usdFP("3142.525009"), 0n],
        );
      });

      it("should return the perp amount and fees", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        await checkPerpToUSDSwapAmt(
          billBroker,
          perpFP("14286"),
          [usdFP("100000"), perpFP("100000"), priceFP("1"), priceFP("1")],

          [0n, 0n, 0n],
        );
      });

      it("should return the perp amount and fees", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        await checkPerpToUSDSwapAmt(
          billBroker,
          perpFP("100"),
          [usdFP("100000"), perpFP("100000"), priceFP("1"), priceFP("0.9")],
          [usdFP("81"), usdFP("9"), 0n],
        );
      });
    });

    describe("when protocol fees are set", async function () {
      it("should return the perp amount and fees", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        await checkPerpToUSDSwapAmt(
          billBroker,
          perpFP("100"),
          [usdFP("110000"), perpFP("100000"), priceFP("1"), priceFP("1")],
          [usdFP("90"), usdFP("9"), usdFP("1")],
        );
      });
    });

    describe("when the pool has only usd", function () {
      it("should return the swap amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await billBroker.updateARBounds([0n, ethers.MaxUint256], [0n, ethers.MaxUint256]);
        await usd.approve(billBroker.target, usdFP("115000"));
        await billBroker.swapUSDForPerps(usdFP("115000"), 0n);
        expect(await perp.balanceOf(billBroker.target)).to.eq(0n);

        await checkPerpToUSDSwapAmt(
          billBroker,
          perpFP("100"),
          [usdFP("100000"), 0n, priceFP("1"), priceFP("1")],
          [usdFP("100"), 0n, 0n],
        );
      });
    });

    describe("when the pool has only perps", function () {
      it("should return the swap amount", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await billBroker.updateARBounds([0n, ethers.MaxUint256], [0n, ethers.MaxUint256]);
        await perp.approve(billBroker.target, perpFP("100000"));
        await billBroker.swapPerpsForUSD(perpFP("100000"), 0n);
        expect(await usd.balanceOf(billBroker.target)).to.eq(0n);

        await expect(
          billBroker[
            "computePerpToUSDSwapAmt(uint256,(uint256,uint256,uint256,uint256))"
          ](perpFP("100"), [0n, perpFP("100000"), priceFP("1"), priceFP("1")]),
        ).to.be.reverted;
      });
    });
  });

  describe("#swapUSDForPerps", function () {
    describe("when paused", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.pause();
        await expect(billBroker.swapUSDForPerps(usdFP("115"), perpFP("90"))).to.be
          .reverted;
      });
    });
    describe("when swap amount is zero", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(billBroker.swapUSDForPerps(0n, 0n)).to.be.revertedWithCustomError(
          billBroker,
          "UnacceptableSwap",
        );
      });
    });

    describe("when slippage is too high", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(
          billBroker.swapUSDForPerps(usdFP("115"), perpFP("100.01")),
        ).to.be.revertedWithCustomError(billBroker, "SlippageTooHigh");
      });
    });

    describe("when oracle price is unreliable", function () {
      it("should revert", async function () {
        const { billBroker, oracle } = await loadFixture(setupContracts);
        await oracle.mockMethod("perpFmvUsdPrice()", [0n, false]);
        await expect(
          billBroker.swapUSDForPerps(usdFP("115"), perpFP("100")),
        ).to.be.revertedWithCustomError(billBroker, "UnreliablePrice");
      });
      it("should revert", async function () {
        const { billBroker, oracle } = await loadFixture(setupContracts);
        await oracle.mockMethod("usdPrice()", [0n, false]);
        await expect(
          billBroker.swapUSDForPerps(usdFP("115"), perpFP("100")),
        ).to.be.revertedWithCustomError(billBroker, "UnreliablePrice");
      });
    });

    describe("stable swap", function () {
      it("should transfer usd from the user", async function () {
        const { billBroker, deployer, usd } = await loadFixture(setupContracts);
        await expect(() =>
          billBroker.swapUSDForPerps(usdFP("115"), perpFP("100")),
        ).to.changeTokenBalance(usd, deployer, usdFP("-115"));
      });
      it("should transfer perps to the user", async function () {
        const { billBroker, deployer, perp } = await loadFixture(setupContracts);
        await expect(() =>
          billBroker.swapUSDForPerps(usdFP("115"), perpFP("100")),
        ).to.changeTokenBalance(perp, deployer, perpFP("100"));
      });
      it("should increase the reserve ar", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        expect(await assetRatio(billBroker)).to.eq(percFP("1"));
        await billBroker.swapUSDForPerps(usdFP("115"), perpFP("100"));
        expect(await assetRatio(billBroker)).to.eq(percFP("1.002002002002002002"));
      });
      it("should update the reserve", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.swapUSDForPerps(usdFP("115"), perpFP("100"));
        const r = await reserveState(billBroker);
        expect(r.usdBalance).to.eq(usdFP("115115"));
        expect(r.perpBalance).to.eq(perpFP("99900"));
      });

      it("should emit SwapUSDForPerps", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        const r = await billBroker.reserveState.staticCall();
        await expect(billBroker.swapUSDForPerps(usdFP("115"), perpFP("100")))
          .to.emit(billBroker, "SwapUSDForPerps")
          .withArgs(usdFP("115"), r);
      });
    });

    describe("stable swap with fees", function () {
      it("should transfer usd from the user", async function () {
        const { billBroker, deployer, usd } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        await expect(() =>
          billBroker.swapUSDForPerps(usdFP("115"), perpFP("95")),
        ).to.changeTokenBalance(usd, deployer, usdFP("-115"));
      });
      it("should transfer perps to the user", async function () {
        const { billBroker, deployer, perp } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        await expect(() =>
          billBroker.swapUSDForPerps(usdFP("115"), perpFP("95")),
        ).to.changeTokenBalance(perp, deployer, perpFP("95"));
      });
      it("should increase the reserve ar", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        expect(await assetRatio(billBroker)).to.eq(percFP("1"));
        await billBroker.swapUSDForPerps(usdFP("115"), perpFP("95"));
        expect(await assetRatio(billBroker)).to.eq(percFP("1.001951854261548471"));
      });
      it("should update the reserve", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        await billBroker.swapUSDForPerps(usdFP("115"), perpFP("95"));
        const r = await reserveState(billBroker);
        expect(r.usdBalance).to.eq(usdFP("115115"));
        expect(r.perpBalance).to.eq(perpFP("99905"));
      });
      it("should emit SwapUSDForPerps", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        const r = await billBroker.reserveState.staticCall();
        await expect(billBroker.swapUSDForPerps(usdFP("115"), perpFP("95")))
          .to.emit(billBroker, "SwapUSDForPerps")
          .withArgs(usdFP("115"), r);
      });
    });

    describe("stable swap with protocol fees", function () {
      it("should transfer usd from the user", async function () {
        const { billBroker, deployer, usd } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        await expect(() =>
          billBroker.swapUSDForPerps(usdFP("115"), perpFP("95")),
        ).to.changeTokenBalance(usd, deployer, usdFP("-115"));
      });
      it("should transfer perps to the user", async function () {
        const { billBroker, deployer, feeCollector, perp } = await loadFixture(
          setupContracts,
        );
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        await billBroker
          .connect(deployer)
          .transferOwnership(await feeCollector.getAddress());
        await expect(() =>
          billBroker.swapUSDForPerps(usdFP("115"), perpFP("95")),
        ).to.changeTokenBalance(perp, deployer, perpFP("95"));
      });
      it("should transfer protocol fee to the owner", async function () {
        const { billBroker, perp, feeCollector } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        await billBroker.transferOwnership(await feeCollector.getAddress());
        await expect(() =>
          billBroker.swapUSDForPerps(usdFP("115"), perpFP("95")),
        ).to.changeTokenBalance(perp, feeCollector, perpFP("0.5"));
      });
      it("should increase the reserve ar", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        expect(await assetRatio(billBroker)).to.eq(percFP("1"));
        await billBroker.swapUSDForPerps(usdFP("115"), perpFP("95"));
        expect(await assetRatio(billBroker)).to.eq(percFP("1.001956868809713276"));
      });
      it("should update the reserve", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        await billBroker.swapUSDForPerps(usdFP("115"), perpFP("95"));
        const r = await reserveState(billBroker);
        expect(r.usdBalance).to.eq(usdFP("115115"));
        expect(r.perpBalance).to.eq(perpFP("99904.5"));
      });
      it("should emit SwapUSDForPerps", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        const r = await billBroker.reserveState.staticCall();
        await expect(billBroker.swapUSDForPerps(usdFP("115"), perpFP("95")))
          .to.emit(billBroker, "SwapUSDForPerps")
          .withArgs(usdFP("115"), r);
      });
    });

    describe("when swap amount pushes system outside soft bound", async function () {
      it("should transfer usd from the user", async function () {
        const { billBroker, deployer, usd } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        await expect(() =>
          billBroker.swapUSDForPerps(usdFP("3795"), perpFP("3130")),
        ).to.changeTokenBalance(usd, deployer, usdFP("-3795"));
      });
      it("should transfer perps to the user", async function () {
        const { billBroker, deployer, perp } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        await expect(() =>
          billBroker.swapUSDForPerps(usdFP("3795"), perpFP("3130")),
        ).to.changeTokenBalance(perp, deployer, perpFP("3135"));
      });

      it("should increase the reserve ar", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        expect(await assetRatio(billBroker)).to.eq(percFP("1"));
        await billBroker.swapUSDForPerps(usdFP("3795"), perpFP("3130"));
        expect(await assetRatio(billBroker)).to.eq(percFP("1.066432664016930779"));
      });
      it("should update the reserve", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        await billBroker.swapUSDForPerps(usdFP("3795"), perpFP("3130"));
        const r = await reserveState(billBroker);
        expect(r.usdBalance).to.eq(usdFP("118795"));
        expect(r.perpBalance).to.eq(perpFP("96865"));
      });
      it("should emit SwapUSDForPerps", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        const r = await billBroker.reserveState.staticCall();
        await expect(billBroker.swapUSDForPerps(usdFP("3795"), perpFP("3130")))
          .to.emit(billBroker, "SwapUSDForPerps")
          .withArgs(usdFP("3795"), r);
      });
    });

    describe("when swap amount pushes system outside hard bound", async function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.updateARBounds(
          [percFP("0.8"), percFP("1")],
          [percFP("0.75"), percFP("1.05")],
        );
        await updateFees(billBroker, {
          usdToPerpSwapFeePercs: {
            lower: percFP("0.05"),
            upper: percFP("0.5"),
          },
        });
        await expect(
          billBroker.swapUSDForPerps(usdFP("5000"), perpFP("4000")),
        ).to.be.revertedWithCustomError(billBroker, "UnacceptableSwap");
      });
    });

    describe("when the pool has only usd", function () {
      it("should revert", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await billBroker.updateARBounds([0n, ethers.MaxUint256], [0n, ethers.MaxUint256]);
        await usd.approve(billBroker.target, usdFP("115000"));
        await billBroker.swapUSDForPerps(usdFP("115000"), 0n);
        expect(await perp.balanceOf(billBroker.target)).to.eq(0n);

        await usd.approve(billBroker.target, usdFP("115"));
        await expect(billBroker.swapUSDForPerps(usdFP("115"), perpFP("0"))).to.be
          .reverted;
      });
    });

    describe("when the pool has only perps", function () {
      it("should execute swap", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await billBroker.updateARBounds([0n, ethers.MaxUint256], [0n, ethers.MaxUint256]);
        await perp.approve(billBroker.target, perpFP("100000"));
        await billBroker.swapPerpsForUSD(perpFP("100000"), 0n);
        expect(await usd.balanceOf(billBroker.target)).to.eq(0n);

        await usd.approve(billBroker.target, usdFP("115"));
        await expect(() =>
          billBroker.swapUSDForPerps(usdFP("115"), perpFP("0")),
        ).to.changeTokenBalance(perp, deployer, perpFP("100"));
      });
    });
  });

  describe("#swapPerpsForUSD", function () {
    describe("when paused", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.pause();
        await expect(billBroker.swapPerpsForUSD(perpFP("100"), usdFP("100"))).to.be
          .reverted;
      });
    });
    describe("when swap amount is zero", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(billBroker.swapPerpsForUSD(0n, 0n)).to.be.revertedWithCustomError(
          billBroker,
          "UnacceptableSwap",
        );
      });
    });

    describe("when slippage is too high", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(
          billBroker.swapPerpsForUSD(perpFP("100"), usdFP("116")),
        ).to.be.revertedWithCustomError(billBroker, "SlippageTooHigh");
      });
    });

    describe("when oracle price is unreliable", function () {
      it("should revert", async function () {
        const { billBroker, oracle } = await loadFixture(setupContracts);
        await oracle.mockMethod("perpFmvUsdPrice()", [0n, false]);
        await expect(
          billBroker.swapPerpsForUSD(perpFP("115"), usdFP("100")),
        ).to.be.revertedWithCustomError(billBroker, "UnreliablePrice");
      });
      it("should revert", async function () {
        const { billBroker, oracle } = await loadFixture(setupContracts);
        await oracle.mockMethod("usdPrice()", [0n, false]);
        await expect(
          billBroker.swapPerpsForUSD(perpFP("115"), usdFP("100")),
        ).to.be.revertedWithCustomError(billBroker, "UnreliablePrice");
      });
    });

    describe("stable swap", function () {
      it("should transfer perps from the user", async function () {
        const { billBroker, deployer, perp } = await loadFixture(setupContracts);
        await expect(() =>
          billBroker.swapPerpsForUSD(perpFP("100"), usdFP("115")),
        ).to.changeTokenBalance(perp, deployer, perpFP("-100"));
      });
      it("should transfer usd to the user", async function () {
        const { billBroker, deployer, usd } = await loadFixture(setupContracts);
        await expect(() =>
          billBroker.swapPerpsForUSD(perpFP("100"), usdFP("115")),
        ).to.changeTokenBalance(usd, deployer, usdFP("115"));
      });

      it("should decrease the reserve ar", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        expect(await assetRatio(billBroker)).to.eq(percFP("1"));
        await billBroker.swapPerpsForUSD(perpFP("100"), usdFP("115"));
        expect(await assetRatio(billBroker)).to.eq(percFP("0.998001998001998001"));
      });
      it("should update the reserve", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.swapPerpsForUSD(perpFP("100"), usdFP("115"));
        const r = await reserveState(billBroker);
        expect(r.usdBalance).to.eq(usdFP("114885"));
        expect(r.perpBalance).to.eq(perpFP("100100"));
      });
      it("should emit SwapPerpsForUSD", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        const r = await billBroker.reserveState.staticCall();
        await expect(billBroker.swapPerpsForUSD(perpFP("100"), usdFP("115")))
          .to.emit(billBroker, "SwapPerpsForUSD")
          .withArgs(perpFP("100"), r);
      });
    });

    describe("stable swap with fees", function () {
      it("should transfer perps from the user", async function () {
        const { billBroker, deployer, perp } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        await expect(() =>
          billBroker.swapPerpsForUSD(perpFP("100"), usdFP("103")),
        ).to.changeTokenBalance(perp, deployer, perpFP("-100"));
      });
      it("should transfer usd to the user", async function () {
        const { billBroker, deployer, usd } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        await expect(() =>
          billBroker.swapPerpsForUSD(perpFP("100"), usdFP("103")),
        ).to.changeTokenBalance(usd, deployer, usdFP("103.5"));
      });
      it("should increase the reserve ar", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        expect(await assetRatio(billBroker)).to.eq(percFP("1"));
        await billBroker.swapPerpsForUSD(perpFP("100"), usdFP("103"));
        expect(await assetRatio(billBroker)).to.eq(percFP("0.998101898101898101"));
      });
      it("should update the reserve", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        await billBroker.swapPerpsForUSD(perpFP("100"), usdFP("103"));
        const r = await reserveState(billBroker);
        expect(r.usdBalance).to.eq(usdFP("114896.5"));
        expect(r.perpBalance).to.eq(perpFP("100100"));
      });
      it("should emit SwapPerpsForUSD", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        const r = await billBroker.reserveState.staticCall();
        await expect(billBroker.swapPerpsForUSD(perpFP("100"), usdFP("103")))
          .to.emit(billBroker, "SwapPerpsForUSD")
          .withArgs(perpFP("100"), r);
      });
    });

    describe("stable swap with protocol fees", function () {
      it("should transfer perps from the user", async function () {
        const { billBroker, deployer, perp } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        await expect(() =>
          billBroker.swapPerpsForUSD(perpFP("100"), usdFP("103")),
        ).to.changeTokenBalance(perp, deployer, perpFP("-100"));
      });
      it("should transfer usd to the user", async function () {
        const { billBroker, deployer, usd, feeCollector } = await loadFixture(
          setupContracts,
        );
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        await billBroker.transferOwnership(await feeCollector.getAddress());
        await expect(() =>
          billBroker.swapPerpsForUSD(perpFP("100"), usdFP("103")),
        ).to.changeTokenBalance(usd, deployer, usdFP("103.5"));
      });
      it("should transfer protocol fee to the owner", async function () {
        const { billBroker, usd, feeCollector } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        await billBroker.transferOwnership(await feeCollector.getAddress());
        await expect(() =>
          billBroker.swapPerpsForUSD(perpFP("100"), usdFP("103")),
        ).to.changeTokenBalance(usd, feeCollector, usdFP("1.15"));
      });
      it("should increase the reserve ar", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        expect(await assetRatio(billBroker)).to.eq(percFP("1"));
        await billBroker.swapPerpsForUSD(perpFP("100"), usdFP("103"));
        expect(await assetRatio(billBroker)).to.eq(percFP("0.998091908091908091"));
      });
      it("should update the reserve", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        await billBroker.swapPerpsForUSD(perpFP("100"), usdFP("103"));
        const r = await reserveState(billBroker);
        expect(r.usdBalance).to.eq(usdFP("114895.35"));
        expect(r.perpBalance).to.eq(perpFP("100100"));
      });
      it("should emit SwapPerpsForUSD", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        const r = await billBroker.reserveState.staticCall();
        await expect(billBroker.swapPerpsForUSD(perpFP("100"), usdFP("103")))
          .to.emit(billBroker, "SwapPerpsForUSD")
          .withArgs(perpFP("100"), r);
      });
    });

    describe("when swap pushes system outside soft bound", function () {
      it("should transfer perps from the user", async function () {
        const { billBroker, deployer, perp } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        await expect(() =>
          billBroker.swapPerpsForUSD(perpFP("3600"), usdFP("3700")),
        ).to.changeTokenBalance(perp, deployer, perpFP("-3600"));
      });
      it("should transfer usd to the user", async function () {
        const { billBroker, deployer, usd } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        await expect(() =>
          billBroker.swapPerpsForUSD(perpFP("3600"), usdFP("3000")),
        ).to.changeTokenBalance(usd, deployer, usdFP("3726"));
      });
      it("should decrease the reserve ar", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        expect(await assetRatio(billBroker)).to.eq(percFP("1"));
        await billBroker.swapPerpsForUSD(perpFP("3600"), usdFP("3700"));
        expect(await assetRatio(billBroker)).to.eq(percFP("0.933976833976833976"));
      });
      it("should update the reserve", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        await billBroker.swapPerpsForUSD(perpFP("3600"), usdFP("3700"));
        const r = await reserveState(billBroker);
        expect(r.usdBalance).to.eq(usdFP("111274"));
        expect(r.perpBalance).to.eq(perpFP("103600"));
      });
    });

    describe("when swap pushes system outside hard bound", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.updateARBounds(
          [percFP("1"), percFP("1.1")],
          [percFP("0.95"), percFP("1.25")],
        );
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
        });
        await expect(
          billBroker.swapPerpsForUSD(perpFP("5000"), usdFP("4000")),
        ).to.be.revertedWithCustomError(billBroker, "UnacceptableSwap");
      });
      it("should emit SwapPerpsForUSD", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await updateFees(billBroker, {
          perpToUSDSwapFeePercs: {
            lower: percFP("0.1"),
            upper: percFP("0.5"),
          },
          protocolSwapSharePerc: percFP("0.1"),
        });
        const r = await billBroker.reserveState.staticCall();
        await expect(billBroker.swapPerpsForUSD(perpFP("5000"), usdFP("4000")))
          .to.emit(billBroker, "SwapPerpsForUSD")
          .withArgs(perpFP("5000"), r);
      });
    });

    describe("when the pool has only usd", function () {
      it("should execute swap", async function () {
        const { billBroker, usd, perp, deployer } = await loadFixture(setupContracts);
        await billBroker.updateARBounds([0n, ethers.MaxUint256], [0n, ethers.MaxUint256]);
        await usd.approve(billBroker.target, usdFP("115000"));
        await billBroker.swapUSDForPerps(usdFP("115000"), 0n);
        expect(await perp.balanceOf(billBroker.target)).to.eq(0n);

        await perp.approve(billBroker.target, perpFP("100"));
        await expect(() =>
          billBroker.swapPerpsForUSD(perpFP("100"), usdFP("0")),
        ).to.changeTokenBalance(usd, deployer, usdFP("115"));
      });
    });

    describe("when the pool has only perps", function () {
      it("should revert", async function () {
        const { billBroker, usd, perp } = await loadFixture(setupContracts);
        await billBroker.updateARBounds([0n, ethers.MaxUint256], [0n, ethers.MaxUint256]);
        await perp.approve(billBroker.target, perpFP("100000"));
        await billBroker.swapPerpsForUSD(perpFP("100000"), 0n);
        expect(await usd.balanceOf(billBroker.target)).to.eq(0n);

        await perp.approve(billBroker.target, perpFP("100"));
        await expect(billBroker.swapPerpsForUSD(perpFP("100"), usdFP("0"))).to.be
          .reverted;
      });
    });
  });
});
