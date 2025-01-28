import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, usdFP, perpFP, percFP, priceFP } from "./helpers";

describe("BillBroker", function () {
  async function setupContracts() {
    const accounts = await ethers.getSigners();
    const deployer = accounts[0];

    const Token = await ethers.getContractFactory("MockERC20");
    const usd = await Token.deploy();
    await usd.init("USD token", "usd", 6);
    const perp = await Token.deploy();
    await perp.init("Perp token", "perp", 9);
    const oracle = new DMock("IPerpPricer");
    await oracle.deploy();
    await oracle.mockMethod("decimals()", [18]);
    await oracle.mockMethod("perpFmvUsdPrice()", [0, false]);
    await oracle.mockMethod("usdPrice()", [0, false]);

    const BillBroker = await ethers.getContractFactory("BillBroker");
    const billBroker = await upgrades.deployProxy(
      BillBroker.connect(deployer),
      ["BillBroker LP", "LP token", usd.target, perp.target, oracle.target],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );
    return { deployer, usd, perp, oracle, billBroker };
  }

  describe("init", function () {
    it("should set initial values", async function () {
      const { deployer, billBroker, usd, oracle } = await loadFixture(setupContracts);
      expect(await billBroker.usd()).to.eq(usd.target);
      expect(await billBroker.oracle()).to.eq(oracle.target);
      expect(await billBroker.usdUnitAmt()).to.eq(usdFP("1"));
      expect(await billBroker.perpUnitAmt()).to.eq(perpFP("1"));

      expect(await billBroker.owner()).to.eq(await deployer.getAddress());
      expect(await billBroker.keeper()).to.eq(await deployer.getAddress());

      const arHardBound = await billBroker.arHardBound();
      expect(arHardBound.upper).to.eq(ethers.MaxInt256);
      expect(arHardBound.lower).to.eq(0);

      const arSoftBound = await billBroker.arSoftBound();
      expect(arSoftBound.upper).to.eq(ethers.MaxInt256);
      expect(arSoftBound.lower).to.eq(0);

      const fees = await billBroker.fees();
      expect(fees.mintFeePerc).to.eq(0);
      expect(fees.burnFeePerc).to.eq(0);
      expect(fees.perpToUSDSwapFeeFactors.lower).to.eq(percFP("1"));
      expect(fees.perpToUSDSwapFeeFactors.upper).to.eq(percFP("1"));
      expect(fees.usdToPerpSwapFeeFactors.lower).to.eq(percFP("1"));
      expect(fees.usdToPerpSwapFeeFactors.upper).to.eq(percFP("1"));
      expect(fees.protocolSwapSharePerc).to.eq(0);

      expect(await billBroker.usdBalance()).to.eq(0n);
      expect(await billBroker.perpBalance()).to.eq(0n);
    });
  });

  describe("#updateKeeper", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.renounceOwnership();
        await expect(billBroker.updateKeeper(ethers.ZeroAddress)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set address is valid", function () {
      it("should update reference", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.updateKeeper(billBroker.target);
        expect(await billBroker.keeper()).to.eq(billBroker.target);
      });
    });
  });

  describe("#updateOracle", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.renounceOwnership();
        await expect(billBroker.updateOracle(ethers.ZeroAddress)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when oracle is not valid", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        const oracle = new DMock("SpotPricer");
        await oracle.deploy();
        await oracle.mockMethod("decimals()", [17]);
        await expect(
          billBroker.updateOracle(oracle.target),
        ).to.be.revertedWithCustomError(billBroker, "UnexpectedDecimals");
      });
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        const oracle = new DMock("SpotPricer");
        await oracle.deploy();
        await oracle.mockMethod("decimals()", [18]);

        await billBroker.updateOracle(oracle.target);
        expect(await billBroker.oracle()).to.eq(oracle.target);
      });
    });
  });

  describe("#updateFees", function () {
    let fees: any;
    beforeEach(async function () {
      fees = {
        mintFeePerc: percFP("0.005"),
        burnFeePerc: percFP("0.025"),
        perpToUSDSwapFeeFactors: {
          lower: percFP("1.01"),
          upper: percFP("1.1"),
        },
        usdToPerpSwapFeeFactors: {
          lower: percFP("1.02"),
          upper: percFP("1.2"),
        },
        protocolSwapSharePerc: percFP("0.05"),
      };
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.renounceOwnership();
        await expect(billBroker.updateFees(fees)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        fees.mintFeePerc = percFP("1.01");
        await expect(billBroker.updateFees(fees)).to.be.revertedWithCustomError(
          billBroker,
          "InvalidPerc",
        );
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        fees.burnFeePerc = percFP("1.01");
        await expect(billBroker.updateFees(fees)).to.be.revertedWithCustomError(
          billBroker,
          "InvalidPerc",
        );
      });
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        fees.perpToUSDSwapFeeFactors.lower = percFP("0.2");
        fees.perpToUSDSwapFeeFactors.upper = percFP("0.1");
        await expect(billBroker.updateFees(fees)).to.be.revertedWithCustomError(
          billBroker,
          "InvalidPerc",
        );
      });
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        fees.usdToPerpSwapFeeFactors.lower = percFP("0.2");
        fees.usdToPerpSwapFeeFactors.upper = percFP("0.1");
        await expect(billBroker.updateFees(fees)).to.be.revertedWithCustomError(
          billBroker,
          "InvalidPerc",
        );
      });
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        fees.protocolSwapSharePerc = percFP("1.01");
        await expect(billBroker.updateFees(fees)).to.be.revertedWithCustomError(
          billBroker,
          "InvalidPerc",
        );
      });
    });

    describe("when parameters are valid", function () {
      it("should update fees", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.updateFees(fees);
        const f = await billBroker.fees();
        expect(f.mintFeePerc).to.eq(fees.mintFeePerc);
        expect(f.burnFeePerc).to.eq(fees.burnFeePerc);
        expect(f.perpToUSDSwapFeeFactors.lower).to.eq(fees.perpToUSDSwapFeeFactors.lower);
        expect(f.perpToUSDSwapFeeFactors.upper).to.eq(fees.perpToUSDSwapFeeFactors.upper);
        expect(f.usdToPerpSwapFeeFactors.lower).to.eq(fees.usdToPerpSwapFeeFactors.lower);
        expect(f.usdToPerpSwapFeeFactors.upper).to.eq(fees.usdToPerpSwapFeeFactors.upper);
        expect(f.protocolSwapSharePerc).to.eq(fees.protocolSwapSharePerc);
      });
    });
  });

  describe("#updateARBounds", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.renounceOwnership();
        await expect(
          billBroker.updateARBounds(
            [percFP("0.9"), percFP("1.1")],
            [percFP("0.8"), percFP("1.2")],
          ),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when parameters are not valid", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(
          billBroker.updateARBounds(
            [percFP("1.1"), percFP("1.0")],
            [percFP("0.8"), percFP("1.2")],
          ),
        ).to.be.revertedWithCustomError(billBroker, "InvalidARBound");
      });

      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(
          billBroker.updateARBounds(
            [percFP("0.9"), percFP("1.1")],
            [percFP("1.2"), percFP("0.8")],
          ),
        ).to.be.revertedWithCustomError(billBroker, "InvalidARBound");
      });

      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(
          billBroker.updateARBounds(
            [percFP("0.9"), percFP("0.8")],
            [percFP("1.1"), percFP("1.2")],
          ),
        ).to.be.revertedWithCustomError(billBroker, "InvalidARBound");
      });

      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(
          billBroker.updateARBounds(
            [percFP("0.8"), percFP("1.2")],
            [percFP("0.9"), percFP("1.1")],
          ),
        ).to.be.revertedWithCustomError(billBroker, "InvalidARBound");
      });
    });

    describe("when parameters are valid", function () {
      it("should update bound", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.updateARBounds(
          [percFP("0.9"), percFP("1.1")],
          [percFP("0.8"), percFP("1.2")],
        );
        const b1 = await billBroker.arSoftBound();
        expect(b1.lower).to.eq(percFP("0.9"));
        expect(b1.upper).to.eq(percFP("1.1"));

        const b2 = await billBroker.arHardBound();
        expect(b2.lower).to.eq(percFP("0.8"));
        expect(b2.upper).to.eq(percFP("1.2"));
      });
    });
  });

  describe("#pause", function () {
    describe("when triggered by non-keeper", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.updateKeeper(ethers.ZeroAddress);
        await expect(billBroker.pause()).to.be.revertedWithCustomError(
          billBroker,
          "UnauthorizedCall",
        );
      });
    });

    describe("when already paused", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.pause();
        await expect(billBroker.pause()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when valid", function () {
      it("should pause", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.pause();
        expect(await billBroker.paused()).to.eq(true);
      });
    });
  });

  describe("#unpause", function () {
    describe("when triggered by non-keeper", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.pause();
        await billBroker.updateKeeper(ethers.ZeroAddress);
        await expect(billBroker.unpause()).to.be.revertedWithCustomError(
          billBroker,
          "UnauthorizedCall",
        );
      });
    });

    describe("when not paused", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(billBroker.unpause()).to.be.revertedWith("Pausable: not paused");
      });
    });

    describe("when valid", function () {
      it("should unpause", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.pause();
        await billBroker.unpause();
        expect(await billBroker.paused()).to.eq(false);
      });
    });
  });

  describe("#usdPrice", function () {
    describe("when the price is invalid", function () {
      it("should revert", async function () {
        const { billBroker, oracle } = await loadFixture(setupContracts);
        await oracle.mockMethod("usdPrice()", [priceFP("1"), false]);
        await expect(billBroker.usdPrice()).to.be.revertedWithCustomError(
          billBroker,
          "UnreliablePrice",
        );
      });
    });

    describe("when the price is valid", function () {
      it("should return strategy price", async function () {
        const { billBroker, oracle } = await loadFixture(setupContracts);
        await oracle.mockMethod("usdPrice()", [priceFP("1.001"), true]);
        expect(await billBroker.usdPrice.staticCall()).to.eq(priceFP("1.001"));
      });
    });
  });

  describe("#perpPrice", function () {
    describe("when the price is invalid", function () {
      it("should revert", async function () {
        const { billBroker, oracle } = await loadFixture(setupContracts);
        await oracle.mockMethod("perpFmvUsdPrice()", [priceFP("1.17"), false]);
        await expect(billBroker.perpPrice()).to.be.revertedWithCustomError(
          billBroker,
          "UnreliablePrice",
        );
      });
    });

    describe("when the price is valid", function () {
      it("should return strategy price", async function () {
        const { billBroker, oracle } = await loadFixture(setupContracts);
        await oracle.mockMethod("perpFmvUsdPrice()", [priceFP("1.17"), true]);
        expect(await billBroker.perpPrice.staticCall()).to.eq(priceFP("1.17"));
      });
    });
  });

  describe("#usdBalance", function () {
    it("should return the reserve balance", async function () {
      const { billBroker, usd } = await loadFixture(setupContracts);
      await usd.mint(billBroker.target, usdFP("1246"));
      expect(await billBroker.usdBalance()).to.eq(usdFP("1246"));
    });
  });

  describe("#perpBalance", function () {
    it("should return the reserve balance", async function () {
      const { billBroker, perp } = await loadFixture(setupContracts);
      await perp.mint(billBroker.target, perpFP("999"));
      expect(await billBroker.perpBalance()).to.eq(perpFP("999"));
    });
  });

  describe("#reserveState", function () {
    it("should return the reserve state", async function () {
      const { billBroker, perp, usd, oracle } = await loadFixture(setupContracts);
      await usd.mint(billBroker.target, usdFP("115"));
      await perp.mint(billBroker.target, perpFP("100"));
      await oracle.mockMethod("usdPrice()", [priceFP("1"), true]);
      await oracle.mockMethod("perpFmvUsdPrice()", [priceFP("1.3"), true]);
      const r = await billBroker.reserveState.staticCall();
      expect(r[0]).to.eq(usdFP("115"));
      expect(r[1]).to.eq(perpFP("100"));
      expect(r[2]).to.eq(priceFP("1"));
      expect(r[3]).to.eq(priceFP("1.3"));
    });
  });

  describe("#computeUSDToPerpSwapFeeFactor", function () {
    it("should compute the right factor perc", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await billBroker.updateARBounds(
        [percFP("0.75"), percFP("1.25")],
        [percFP("0.25"), percFP("4")],
      );

      await billBroker.updateFees({
        mintFeePerc: 0n,
        burnFeePerc: 0n,
        perpToUSDSwapFeeFactors: {
          lower: percFP("1.025"),
          upper: percFP("1.16"),
        },
        usdToPerpSwapFeeFactors: {
          lower: percFP("1.025"),
          upper: percFP("1.08"),
        },
        protocolSwapSharePerc: 0n,
      });

      await expect(
        billBroker.computeUSDToPerpSwapFeeFactor(percFP("1.5"), percFP("0.5")),
      ).to.be.revertedWithCustomError(billBroker, "InvalidRange");
      await expect(
        billBroker.computeUSDToPerpSwapFeeFactor(percFP("1.25"), percFP("1.249")),
      ).to.be.revertedWithCustomError(billBroker, "InvalidRange");

      await expect(
        billBroker.computeUSDToPerpSwapFeeFactor(percFP("0.75"), percFP("1.26")),
      ).to.be.revertedWithCustomError(billBroker, "UnexpectedRangeDelta");
      await expect(
        billBroker.computeUSDToPerpSwapFeeFactor(percFP("0.5"), percFP("1.5")),
      ).to.be.revertedWithCustomError(billBroker, "UnexpectedRangeDelta");

      expect(
        await billBroker.computeUSDToPerpSwapFeeFactor(percFP("0.1"), percFP("0.26")),
      ).to.eq(percFP("0.84"));
      expect(
        await billBroker.computeUSDToPerpSwapFeeFactor(percFP("0.3"), percFP("0.5")),
      ).to.eq(percFP("0.8955"));
      expect(
        await billBroker.computeUSDToPerpSwapFeeFactor(percFP("0.25"), percFP("1")),
      ).to.eq(percFP("0.963333333333333333"));
      expect(
        await billBroker.computeUSDToPerpSwapFeeFactor(percFP("0.25"), percFP("1.24")),
      ).to.eq(percFP("0.978282828282828282"));
      expect(
        await billBroker.computeUSDToPerpSwapFeeFactor(percFP("0.76"), percFP("1.24")),
      ).to.eq(percFP("1.025"));
      expect(
        await billBroker.computeUSDToPerpSwapFeeFactor(percFP("1.2"), percFP("1.3")),
      ).to.eq(percFP("1.02525"));
      expect(
        await billBroker.computeUSDToPerpSwapFeeFactor(percFP("1.3"), percFP("1.45")),
      ).to.eq(percFP("1.0275"));
      expect(
        await billBroker.computeUSDToPerpSwapFeeFactor(percFP("1.3"), percFP("1.5")),
      ).to.eq(percFP("1.028"));
      expect(
        await billBroker.computeUSDToPerpSwapFeeFactor(percFP("1.3"), percFP("1.501")),
      ).to.eq(percFP("1.02801"));
      expect(
        await billBroker.computeUSDToPerpSwapFeeFactor(percFP("1.3"), percFP("2")),
      ).to.eq(percFP("1.033"));
      expect(
        await billBroker.computeUSDToPerpSwapFeeFactor(percFP("1.5"), percFP("4")),
      ).to.eq(percFP("1.055"));
      expect(
        await billBroker.computeUSDToPerpSwapFeeFactor(percFP("1.3"), percFP("4.01")),
      ).to.eq(percFP("2"));
    });

    describe("Extended coverage for break-point conditions & edge cases", function () {
      let billBroker;

      beforeEach(async () => {
        const fixtures = await loadFixture(setupContracts);
        billBroker = fixtures.billBroker;

        await billBroker.updateARBounds(
          [percFP("0.75"), percFP("1.25")],
          [percFP("0.25"), percFP("4")],
        );

        await billBroker.updateFees({
          mintFeePerc: 0n,
          burnFeePerc: 0n,
          perpToUSDSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.0769"),
          },
          usdToPerpSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.1693"),
          },
          protocolSwapSharePerc: 0n,
        });
      });

      it("Case A: Entire range below arSoftBound.lower => uses fn1 entirely", async () => {
        const result = await billBroker.computeUSDToPerpSwapFeeFactor(
          percFP("0.50"),
          percFP("0.55"),
        );
        expect(result).to.eq(percFP("0.979145"));
      });

      it("Case B: Range straddles arSoftBound.lower => partial weighting fn1/fn2", async () => {
        const result = await billBroker.computeUSDToPerpSwapFeeFactor(
          percFP("0.70"),
          percFP("0.80"),
        );
        expect(result).to.eq(percFP("1.0224525"));
      });

      it("Case C: Range fully within [arSoftBound.lower..arSoftBound.upper] => uses fn2 entirely", async () => {
        const result = await billBroker.computeUSDToPerpSwapFeeFactor(
          percFP("1.0"),
          percFP("1.2"),
        );
        expect(result).to.eq(percFP("1.025"));
      });

      it("Case D: Range straddles arSoftBound.upper => partial weighting fn2/fn3", async () => {
        const result = await billBroker.computeUSDToPerpSwapFeeFactor(
          percFP("1.20"),
          percFP("1.30"),
        );
        expect(result).to.eq(percFP("1.025655909090909091"));
      });

      it("Case E: Entire range above arSoftBound.upper => uses fn3 entirely", async () => {
        const result = await billBroker.computeUSDToPerpSwapFeeFactor(
          percFP("1.5"),
          percFP("3"),
        );
        expect(result).to.eq(percFP("1.077472727272727273"));
      });

      it("Zero-length range at boundary (e.g., arPre=arPost=arSoftBound.lower) => picks boundary side", async () => {
        const result = await billBroker.computeUSDToPerpSwapFeeFactor(
          percFP("0.75"),
          percFP("0.75"),
        );
        expect(result).to.eq(percFP("1.025"));
      });
    });
  });

  describe("#computePerpToUSDSwapFeeFactor", function () {
    it("should compute the right fee factor", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await billBroker.updateARBounds(
        [percFP("0.75"), percFP("1.25")],
        [percFP("0.25"), percFP("4")],
      );

      await billBroker.updateFees({
        mintFeePerc: 0n,
        burnFeePerc: 0n,
        perpToUSDSwapFeeFactors: {
          lower: percFP("1.1"),
          upper: percFP("1.15"),
        },
        usdToPerpSwapFeeFactors: {
          lower: percFP("1.025"),
          upper: percFP("1.2"),
        },
        protocolSwapSharePerc: 0n,
      });

      await expect(
        billBroker.computePerpToUSDSwapFeeFactor(percFP("1.25"), percFP("1.251")),
      ).to.be.revertedWithCustomError(billBroker, "InvalidRange");
      await expect(
        billBroker.computePerpToUSDSwapFeeFactor(percFP("1.5"), percFP("0.5")),
      ).to.be.revertedWithCustomError(billBroker, "UnexpectedRangeDelta");

      expect(
        await billBroker.computePerpToUSDSwapFeeFactor(percFP("4"), percFP("3")),
      ).to.eq(percFP("0.854545454545454545"));

      expect(
        await billBroker.computePerpToUSDSwapFeeFactor(percFP("4"), percFP("1.25")),
      ).to.eq(percFP("0.95"));

      expect(
        await billBroker.computePerpToUSDSwapFeeFactor(percFP("3"), percFP("2")),
      ).to.eq(percFP("0.963636363636363636"));

      expect(
        await billBroker.computePerpToUSDSwapFeeFactor(percFP("2"), percFP("1.5")),
      ).to.eq(percFP("1.045454545454545454"));

      expect(
        await billBroker.computePerpToUSDSwapFeeFactor(percFP("2"), percFP("0.8")),
      ).to.eq(percFP("1.074431818181818181"));

      expect(
        await billBroker.computePerpToUSDSwapFeeFactor(percFP("1.45"), percFP("0.8")),
      ).to.eq(percFP("1.096643356643356643"));

      expect(
        await billBroker.computePerpToUSDSwapFeeFactor(percFP("1.25"), percFP("0.9")),
      ).to.eq(percFP("1.1"));

      expect(
        await billBroker.computePerpToUSDSwapFeeFactor(percFP("0.8"), percFP("0.7")),
      ).to.eq(percFP("1.10125"));

      expect(
        await billBroker.computePerpToUSDSwapFeeFactor(percFP("0.8"), percFP("0.5")),
      ).to.eq(percFP("1.110416666666666666"));

      expect(
        await billBroker.computePerpToUSDSwapFeeFactor(percFP("1.0"), percFP("0.49")),
      ).to.eq(percFP("1.106627450980392156"));
    });

    describe("Extended coverage for break-point conditions & edge cases", function () {
      let billBroker;

      beforeEach(async () => {
        const fixtures = await loadFixture(setupContracts);
        billBroker = fixtures.billBroker;

        await billBroker.updateARBounds(
          [percFP("0.75"), percFP("1.25")],
          [percFP("0.25"), percFP("4")],
        );

        await billBroker.updateFees({
          mintFeePerc: 0n,
          burnFeePerc: 0n,
          perpToUSDSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.0769"),
          },
          usdToPerpSwapFeeFactors: {
            lower: percFP("1.025"),
            upper: percFP("1.1693"),
          },
          protocolSwapSharePerc: 0n,
        });
      });

      it("Case A: Entirely below arSoftBound.lower => uses fn1 for perp->USD swap", async () => {
        const result = await billBroker.computePerpToUSDSwapFeeFactor(
          percFP("0.60"),
          percFP("0.50"),
        );
        expect(result).to.eq(percFP("1.04576"));
      });

      it("Case B: Straddles arSoftBound.lower => partial weighting", async () => {
        const result = await billBroker.computePerpToUSDSwapFeeFactor(
          percFP("0.80"),
          percFP("0.70"),
        );
        expect(result).to.eq(percFP("1.0262975"));
      });

      it("Case C: Fully within [0.75..1.25] => uses middle fn2", async () => {
        const result = await billBroker.computePerpToUSDSwapFeeFactor(
          percFP("1.20"),
          percFP("1.10"),
        );
        expect(result).to.eq(percFP("1.025"));
      });

      it("Case D: Straddles arSoftBound.upper => partial weighting", async () => {
        const result = await billBroker.computePerpToUSDSwapFeeFactor(
          percFP("1.30"),
          percFP("1.20"),
        );
        expect(result).to.eq(percFP("1.024116818181818182"));
      });

      it("Case E: Entirely above arSoftBound.upper => uses fn3", async () => {
        const result = await billBroker.computePerpToUSDSwapFeeFactor(
          percFP("2.50"),
          percFP("2.0"),
        );
        expect(result).to.eq(percFP("0.954345454545454546"));
      });

      it("Zero-length range exactly at boundary => picks boundary side", async () => {
        const result = await billBroker.computePerpToUSDSwapFeeFactor(
          percFP("1.25"),
          percFP("1.25"),
        );
        expect(result).to.eq(percFP("1.025"));
      });
    });
  });
});
