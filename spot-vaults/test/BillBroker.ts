import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, usdFP, perpFP, percentageFP, priceFP } from "./helpers";

describe("BillBroker", function () {
  async function setupContracts() {
    const accounts = await ethers.getSigners();
    const deployer = accounts[0];

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
    return { deployer, usd, perp, pricingStrategy, billBroker };
  }

  describe("init", function () {
    it("should set initial values", async function () {
      const { deployer, billBroker, usd, pricingStrategy } = await loadFixture(
        setupContracts,
      );
      expect(await billBroker.usd()).to.eq(usd.target);
      expect(await billBroker.pricingStrategy()).to.eq(pricingStrategy.target);
      expect(await billBroker.usdUnitAmt()).to.eq(usdFP("1"));
      expect(await billBroker.perpUnitAmt()).to.eq(perpFP("1"));

      expect(await billBroker.owner()).to.eq(await deployer.getAddress());
      expect(await billBroker.keeper()).to.eq(await deployer.getAddress());

      const arHardBound = await billBroker.arHardBound();
      expect(arHardBound.upper).to.eq(percentageFP("1.25"));
      expect(arHardBound.lower).to.eq(percentageFP("0.75"));

      const arSoftBound = await billBroker.arSoftBound();
      expect(arSoftBound.upper).to.eq(percentageFP("1.1"));
      expect(arSoftBound.lower).to.eq(percentageFP("0.9"));

      const fees = await billBroker.fees();
      expect(fees.mintFeePerc).to.eq(0);
      expect(fees.burnFeePerc).to.eq(0);
      expect(fees.perpToUSDSwapFeePercs.lower).to.eq(percentageFP("1"));
      expect(fees.perpToUSDSwapFeePercs.upper).to.eq(percentageFP("1"));
      expect(fees.usdToPerpSwapFeePercs.lower).to.eq(percentageFP("1"));
      expect(fees.usdToPerpSwapFeePercs.upper).to.eq(percentageFP("1"));
      expect(fees.protocolSwapSharePerc).to.eq(0);

      expect(await billBroker.usdReserve()).to.eq(usdFP("0"));
      expect(await billBroker.perpReserve()).to.eq(perpFP("0"));

      expect(await billBroker.dailyUsdSwapAmtLimit()).to.eq(ethers.MaxUint256);
      expect(await billBroker.lastSwapDayTimestampSec()).to.eq("0");
      expect(await billBroker.todayUsdSwapAmt()).to.eq("0");
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

  describe("#updatePricingStrategy", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.renounceOwnership();
        await expect(
          billBroker.updatePricingStrategy(ethers.ZeroAddress),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when pricing strategy is not valid", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        const pricingStrategy = new DMock("SpotAppraiser");
        await pricingStrategy.deploy();
        await pricingStrategy.mockMethod("decimals()", [17]);
        await expect(
          billBroker.updatePricingStrategy(pricingStrategy.target),
        ).to.be.revertedWithCustomError(billBroker, "UnexpectedDecimals");
      });
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        const pricingStrategy = new DMock("SpotAppraiser");
        await pricingStrategy.deploy();
        await pricingStrategy.mockMethod("decimals()", [18]);

        await billBroker.updatePricingStrategy(pricingStrategy.target);
        expect(await billBroker.pricingStrategy()).to.eq(pricingStrategy.target);
      });
    });
  });

  describe("#updateFees", function () {
    let fees: any;
    beforeEach(async function () {
      fees = {
        mintFeePerc: percentageFP("0.005"),
        burnFeePerc: percentageFP("0.025"),
        perpToUSDSwapFeePercs: {
          lower: percentageFP("0.01"),
          upper: percentageFP("0.1"),
        },
        usdToPerpSwapFeePercs: {
          lower: percentageFP("0.02"),
          upper: percentageFP("0.2"),
        },
        protocolSwapSharePerc: percentageFP("0.05"),
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
        fees.mintFeePerc = percentageFP("1.01");
        await expect(billBroker.updateFees(fees)).to.be.revertedWithCustomError(
          billBroker,
          "InvalidPerc",
        );
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        fees.burnFeePerc = percentageFP("1.01");
        await expect(billBroker.updateFees(fees)).to.be.revertedWithCustomError(
          billBroker,
          "InvalidPerc",
        );
      });
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        fees.perpToUSDSwapFeePercs.lower = percentageFP("0.2");
        fees.perpToUSDSwapFeePercs.upper = percentageFP("0.1");
        await expect(billBroker.updateFees(fees)).to.be.revertedWithCustomError(
          billBroker,
          "InvalidPerc",
        );
      });
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        fees.usdToPerpSwapFeePercs.lower = percentageFP("0.2");
        fees.usdToPerpSwapFeePercs.upper = percentageFP("0.1");
        await expect(billBroker.updateFees(fees)).to.be.revertedWithCustomError(
          billBroker,
          "InvalidPerc",
        );
      });
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        fees.protocolSwapSharePerc = percentageFP("1.01");
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

  describe("#updateARHardBound", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.renounceOwnership();
        await expect(
          billBroker.updateARHardBound([percentageFP("0.9"), percentageFP("1.1")]),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when parameters are not valid", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(
          billBroker.updateARHardBound([percentageFP("1.01"), percentageFP("1.1")]),
        ).to.be.revertedWithCustomError(billBroker, "InvalidARBound");
      });

      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(
          billBroker.updateARHardBound([percentageFP("0.99"), percentageFP("0.999")]),
        ).to.be.revertedWithCustomError(billBroker, "InvalidARBound");
      });

      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(
          billBroker.updateARHardBound([percentageFP("1.01"), percentageFP("0.999")]),
        ).to.be.revertedWithCustomError(billBroker, "InvalidARBound");
      });
    });

    describe("when parameters are valid", function () {
      it("should update bound", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.updateARHardBound([percentageFP("0.5"), percentageFP("1.5")]);
        const b = await billBroker.arHardBound();
        expect(b.lower).to.eq(percentageFP("0.5"));
        expect(b.upper).to.eq(percentageFP("1.5"));
      });
    });
  });

  describe("#updateARSoftBound", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.renounceOwnership();
        await expect(
          billBroker.updateARSoftBound([percentageFP("0.9"), percentageFP("1.1")]),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when parameters are not valid", function () {
      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(
          billBroker.updateARSoftBound([percentageFP("1.01"), percentageFP("1.1")]),
        ).to.be.revertedWithCustomError(billBroker, "InvalidARBound");
      });

      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(
          billBroker.updateARSoftBound([percentageFP("0.99"), percentageFP("0.999")]),
        ).to.be.revertedWithCustomError(billBroker, "InvalidARBound");
      });

      it("should revert", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await expect(
          billBroker.updateARSoftBound([percentageFP("1.01"), percentageFP("0.999")]),
        ).to.be.revertedWithCustomError(billBroker, "InvalidARBound");
      });
    });

    describe("when parameters are valid", function () {
      it("should update bound", async function () {
        const { billBroker } = await loadFixture(setupContracts);
        await billBroker.updateARSoftBound([percentageFP("0.75"), percentageFP("1.25")]);
        const b = await billBroker.arSoftBound();
        expect(b.lower).to.eq(percentageFP("0.75"));
        expect(b.upper).to.eq(percentageFP("1.25"));
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
        const { billBroker, pricingStrategy } = await loadFixture(setupContracts);
        await pricingStrategy.mockMethod("usdPrice()", [priceFP("1"), false]);
        await expect(billBroker.usdPrice()).to.be.revertedWithCustomError(
          billBroker,
          "UnreliablePrice",
        );
      });
    });

    describe("when the price is valid", function () {
      it("should return strategy price", async function () {
        const { billBroker, pricingStrategy } = await loadFixture(setupContracts);
        await pricingStrategy.mockMethod("usdPrice()", [priceFP("1.001"), true]);
        expect(await billBroker.usdPrice.staticCall()).to.eq(priceFP("1.001"));
      });
    });
  });

  describe("#perpPrice", function () {
    describe("when the price is invalid", function () {
      it("should revert", async function () {
        const { billBroker, pricingStrategy } = await loadFixture(setupContracts);
        await pricingStrategy.mockMethod("perpPrice()", [priceFP("1.17"), false]);
        await expect(billBroker.perpPrice()).to.be.revertedWithCustomError(
          billBroker,
          "UnreliablePrice",
        );
      });
    });

    describe("when the price is valid", function () {
      it("should return strategy price", async function () {
        const { billBroker, pricingStrategy } = await loadFixture(setupContracts);
        await pricingStrategy.mockMethod("perpPrice()", [priceFP("1.17"), true]);
        expect(await billBroker.perpPrice.staticCall()).to.eq(priceFP("1.17"));
      });
    });
  });

  describe("#usdReserve", function () {
    it("should return the reserve balance", async function () {
      const { billBroker, usd } = await loadFixture(setupContracts);
      await usd.mint(billBroker.target, usdFP("1246"));
      expect(await billBroker.usdReserve()).to.eq(usdFP("1246"));
    });
  });

  describe("#perpReserve", function () {
    it("should return the reserve balance", async function () {
      const { billBroker, perp } = await loadFixture(setupContracts);
      await perp.mint(billBroker.target, perpFP("999"));
      expect(await billBroker.perpReserve()).to.eq(perpFP("999"));
    });
  });

  describe("#reserveState", function () {
    it("should return the reserve state", async function () {
      const { billBroker, perp, usd, pricingStrategy } = await loadFixture(
        setupContracts,
      );
      await usd.mint(billBroker.target, usdFP("115"));
      await perp.mint(billBroker.target, perpFP("100"));
      await pricingStrategy.mockMethod("usdPrice()", [priceFP("1"), true]);
      await pricingStrategy.mockMethod("perpPrice()", [priceFP("1.3"), true]);
      const r = {
        usdReserve: await billBroker.usdReserve(),
        perpReserve: await billBroker.perpReserve(),
        usdPrice: await billBroker.usdPrice.staticCall(),
        perpPrice: await billBroker.perpPrice.staticCall(),
      };
      expect(r.usdReserve).to.eq(usdFP("115"));
      expect(r.perpReserve).to.eq(perpFP("100"));
      expect(r.usdPrice).to.eq(priceFP("1"));
      expect(r.perpPrice).to.eq(priceFP("1.3"));
    });
  });

  describe("#computeUSDToPerpSwapFeePerc", function () {
    it("should compute the right fee perc", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await billBroker.updateARHardBound([percentageFP("0.5"), percentageFP("1.5")]);
      await billBroker.updateARSoftBound([percentageFP("0.75"), percentageFP("1.25")]);

      await billBroker.updateFees({
        mintFeePerc: percentageFP("0"),
        burnFeePerc: percentageFP("0"),
        perpToUSDSwapFeePercs: {
          lower: percentageFP("0"),
          upper: percentageFP("0"),
        },
        usdToPerpSwapFeePercs: {
          lower: percentageFP("0.05"),
          upper: percentageFP("1.5"),
        },
        protocolSwapSharePerc: percentageFP("0"),
      });

      await expect(
        billBroker.computeUSDToPerpSwapFeePerc(percentageFP("1.5"), percentageFP("0.5")),
      ).to.be.revertedWithCustomError(billBroker, "UnexpectedARDelta");
      await expect(
        billBroker.computeUSDToPerpSwapFeePerc(
          percentageFP("1.25"),
          percentageFP("1.249"),
        ),
      ).to.be.revertedWithCustomError(billBroker, "UnexpectedARDelta");

      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(
          percentageFP("0.25"),
          percentageFP("1.2"),
        ),
      ).to.eq(percentageFP("0.05"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(
          percentageFP("0.25"),
          percentageFP("1.25"),
        ),
      ).to.eq(percentageFP("0.05"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(
          percentageFP("1.2"),
          percentageFP("1.3"),
        ),
      ).to.eq(percentageFP("0.1225"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(
          percentageFP("1.3"),
          percentageFP("1.45"),
        ),
      ).to.eq(percentageFP("0.775"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(
          percentageFP("1.3"),
          percentageFP("1.5"),
        ),
      ).to.eq(percentageFP("0.92"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(
          percentageFP("0.5"),
          percentageFP("1.5"),
        ),
      ).to.eq(percentageFP("0.23125"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(
          percentageFP("1.3"),
          percentageFP("1.501"),
        ),
      ).to.eq(percentageFP("1"));
      expect(
        await billBroker.computeUSDToPerpSwapFeePerc(
          percentageFP("1.3"),
          percentageFP("2"),
        ),
      ).to.eq(percentageFP("1"));
    });
  });

  describe("#computePerpToUSDSwapFeePerc", function () {
    it("should compute the right fee perc", async function () {
      const { billBroker } = await loadFixture(setupContracts);
      await billBroker.updateARHardBound([percentageFP("0.5"), percentageFP("1.5")]);
      await billBroker.updateARSoftBound([percentageFP("0.75"), percentageFP("1.25")]);

      await billBroker.updateFees({
        mintFeePerc: percentageFP("0"),
        burnFeePerc: percentageFP("0"),
        perpToUSDSwapFeePercs: {
          lower: percentageFP("0.1"),
          upper: percentageFP("0.5"),
        },
        usdToPerpSwapFeePercs: {
          lower: percentageFP("0"),
          upper: percentageFP("0"),
        },
        protocolSwapSharePerc: percentageFP("0"),
      });

      await expect(
        billBroker.computePerpToUSDSwapFeePerc(percentageFP("0.5"), percentageFP("1.5")),
      ).to.be.revertedWithCustomError(billBroker, "UnexpectedARDelta");
      await expect(
        billBroker.computePerpToUSDSwapFeePerc(
          percentageFP("1.25"),
          percentageFP("1.251"),
        ),
      ).to.be.revertedWithCustomError(billBroker, "UnexpectedARDelta");

      expect(
        await billBroker.computePerpToUSDSwapFeePerc(
          percentageFP("2"),
          percentageFP("0.8"),
        ),
      ).to.eq(percentageFP("0.1"));
      expect(
        await billBroker.computePerpToUSDSwapFeePerc(
          percentageFP("1.45"),
          percentageFP("0.8"),
        ),
      ).to.eq(percentageFP("0.1"));
      expect(
        await billBroker.computePerpToUSDSwapFeePerc(
          percentageFP("0.8"),
          percentageFP("0.7"),
        ),
      ).to.eq(percentageFP("0.12"));
      expect(
        await billBroker.computePerpToUSDSwapFeePerc(
          percentageFP("0.8"),
          percentageFP("0.5"),
        ),
      ).to.eq(percentageFP("0.266666666666666666"));
      expect(
        await billBroker.computePerpToUSDSwapFeePerc(
          percentageFP("1.5"),
          percentageFP("0.5"),
        ),
      ).to.eq(percentageFP("0.15"));
      expect(
        await billBroker.computePerpToUSDSwapFeePerc(
          percentageFP("1.0"),
          percentageFP("0.49"),
        ),
      ).to.eq(percentageFP("1"));
    });
  });
});
