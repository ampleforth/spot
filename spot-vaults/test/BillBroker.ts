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
      expect(arHardBound.upper).to.eq(ethers.MaxUint256);
      expect(arHardBound.lower).to.eq(0n);

      const arSoftBound = await billBroker.arSoftBound();
      expect(arSoftBound.upper).to.eq(ethers.MaxUint256);
      expect(arSoftBound.lower).to.eq(0n);

      const fees = await billBroker.fees();
      expect(fees.mintFeePerc).to.eq(0);
      expect(fees.burnFeePerc).to.eq(0);
      expect(fees.perpToUSDSwapFeePercs.lower).to.eq(percFP("1"));
      expect(fees.perpToUSDSwapFeePercs.upper).to.eq(percFP("1"));
      expect(fees.usdToPerpSwapFeePercs.lower).to.eq(percFP("1"));
      expect(fees.usdToPerpSwapFeePercs.upper).to.eq(percFP("1"));
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
        perpToUSDSwapFeePercs: {
          lower: percFP("0.01"),
          upper: percFP("0.1"),
        },
        usdToPerpSwapFeePercs: {
          lower: percFP("0.02"),
          upper: percFP("0.2"),
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
        fees.perpToUSDSwapFeePercs.lower = percFP("0.2");
        fees.perpToUSDSwapFeePercs.upper = percFP("0.1");
        await expect(billBroker.updateFees(fees)).to.be.revertedWithCustomError(
          billBroker,
          "InvalidPerc",
        );
      });
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        fees.usdToPerpSwapFeePercs.lower = percFP("0.2");
        fees.usdToPerpSwapFeePercs.upper = percFP("0.1");
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
        expect(f.perpToUSDSwapFeePercs.lower).to.eq(fees.perpToUSDSwapFeePercs.lower);
        expect(f.perpToUSDSwapFeePercs.upper).to.eq(fees.perpToUSDSwapFeePercs.upper);
        expect(f.usdToPerpSwapFeePercs.lower).to.eq(fees.usdToPerpSwapFeePercs.lower);
        expect(f.usdToPerpSwapFeePercs.upper).to.eq(fees.usdToPerpSwapFeePercs.upper);
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

  describe("#computeUSDToPerpSwapFeePerc", function () {
    it("should compute the right fee perc", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await billBroker.updateARBounds(
        [percFP("0.75"), percFP("1.25")],
        [percFP("0.5"), percFP("1.5")],
      );

      await billBroker.updateFees({
        mintFeePerc: 0n,
        burnFeePerc: 0n,
        perpToUSDSwapFeePercs: {
          lower: 0n,
          upper: 0n,
        },
        usdToPerpSwapFeePercs: {
          lower: percFP("0.05"),
          upper: percFP("1.5"),
        },
        protocolSwapSharePerc: 0n,
      });

      await expect(
        billBroker.computeUSDToPerpSwapFeePerc(percFP("1.5"), percFP("0.5")),
      ).to.be.revertedWithCustomError(billBroker, "UnexpectedARDelta");
      await expect(
        billBroker.computeUSDToPerpSwapFeePerc(percFP("1.25"), percFP("1.249")),
      ).to.be.revertedWithCustomError(billBroker, "UnexpectedARDelta");

      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(percFP("0.25"), percFP("1.2")),
      ).to.eq(percFP("0.05"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(percFP("0.25"), percFP("1.25")),
      ).to.eq(percFP("0.05"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(percFP("1.2"), percFP("1.3")),
      ).to.eq(percFP("0.1225"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(percFP("1.3"), percFP("1.45")),
      ).to.eq(percFP("0.775"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(percFP("1.3"), percFP("1.5")),
      ).to.eq(percFP("0.92"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(percFP("0.5"), percFP("1.5")),
      ).to.eq(percFP("0.23125"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(percFP("1.3"), percFP("1.501")),
      ).to.eq(percFP("1"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(percFP("1.3"), percFP("2")),
      ).to.eq(percFP("1"));
    });

    it("should compute the right fee perc when outside bounds", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await billBroker.updateARBounds(
        [percFP("0.75"), percFP("1.25")],
        [percFP("0"), percFP("10")],
      );

      await billBroker.updateFees({
        mintFeePerc: 0n,
        burnFeePerc: 0n,
        perpToUSDSwapFeePercs: {
          lower: 0n,
          upper: 0n,
        },
        usdToPerpSwapFeePercs: {
          lower: percFP("1.01"),
          upper: percFP("2"),
        },
        protocolSwapSharePerc: 0n,
      });

      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(percFP("1"), percFP("1.25")),
      ).to.eq(percFP("1"));
    });
  });

  describe("#computePerpToUSDSwapFeePerc", function () {
    it("should compute the right fee perc", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await billBroker.updateARBounds(
        [percFP("0.75"), percFP("1.25")],
        [percFP("0.5"), percFP("1.5")],
      );

      await billBroker.updateFees({
        mintFeePerc: 0n,
        burnFeePerc: 0n,
        perpToUSDSwapFeePercs: {
          lower: percFP("0.1"),
          upper: percFP("0.5"),
        },
        usdToPerpSwapFeePercs: {
          lower: 0n,
          upper: 0n,
        },
        protocolSwapSharePerc: 0n,
      });

      await expect(
        billBroker.computePerpToUSDSwapFeePerc(percFP("0.5"), percFP("1.5")),
      ).to.be.revertedWithCustomError(billBroker, "UnexpectedARDelta");
      await expect(
        billBroker.computePerpToUSDSwapFeePerc(percFP("1.25"), percFP("1.251")),
      ).to.be.revertedWithCustomError(billBroker, "UnexpectedARDelta");

      expect(
        await billBroker.computePerpToUSDSwapFeePerc(percFP("2"), percFP("0.8")),
      ).to.eq(percFP("0.1"));
      expect(
        await billBroker.computePerpToUSDSwapFeePerc(percFP("1.45"), percFP("0.8")),
      ).to.eq(percFP("0.1"));
      expect(
        await billBroker.computePerpToUSDSwapFeePerc(percFP("0.8"), percFP("0.7")),
      ).to.eq(percFP("0.12"));
      expect(
        await billBroker.computePerpToUSDSwapFeePerc(percFP("0.8"), percFP("0.5")),
      ).to.eq(percFP("0.266666666666666666"));
      expect(
        await billBroker.computePerpToUSDSwapFeePerc(percFP("1.5"), percFP("0.5")),
      ).to.eq(percFP("0.15"));
      expect(
        await billBroker.computePerpToUSDSwapFeePerc(percFP("1.0"), percFP("0.49")),
      ).to.eq(percFP("1"));
    });

    it("should compute the right fee perc when outside bounds", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await billBroker.updateARBounds(
        [percFP("0.75"), percFP("1.25")],
        [percFP("0"), percFP("10")],
      );

      await billBroker.updateFees({
        mintFeePerc: 0n,
        burnFeePerc: 0n,
        perpToUSDSwapFeePercs: {
          lower: percFP("1.01"),
          upper: percFP("2"),
        },
        usdToPerpSwapFeePercs: {
          lower: 0n,
          upper: 0n,
        },
        protocolSwapSharePerc: 0n,
      });

      expect(
        await billBroker.computePerpToUSDSwapFeePerc(percFP("1.25"), percFP("1.11")),
      ).to.eq(percFP("1"));
    });
  });
});
