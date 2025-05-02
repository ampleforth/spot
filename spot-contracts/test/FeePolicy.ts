import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";

import { toPercFixedPtAmt, toFixedPtAmt } from "./helpers";

let feePolicy: Contract, deployer: Signer, otherUser: Signer;
const toPerc = toPercFixedPtAmt;
const toAmt = toFixedPtAmt;
const toLine = (x1: string, y1: string, x2: string, y2: string) => ({
  x1: toPerc(x1),
  y1: toPerc(y1),
  x2: toPerc(x2),
  y2: toPerc(y2),
});
const toRange = (lower: string, upper: string) => ({
  lower: toPerc(lower),
  upper: toPerc(upper),
});

describe("FeePolicy", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    const FeePolicy = await ethers.getContractFactory("FeePolicy");
    feePolicy = await upgrades.deployProxy(FeePolicy.connect(deployer), [], {
      initializer: "init()",
    });
  });

  describe("#init", function () {
    it("should return the initial parameters", async function () {
      expect(await feePolicy.targetSubscriptionRatio()).to.eq(toPerc("1.5"));

      const f1 = await feePolicy.feeFnDRDown();
      expect(f1[0]).to.eq(toPerc("0.66"));
      expect(f1[1]).to.eq(toPerc("0.25"));
      expect(f1[2]).to.eq(toPerc("0.95"));
      expect(f1[3]).to.eq(toPerc("0"));

      const f2 = await feePolicy.feeFnDRUp();
      expect(f2[0]).to.eq(toPerc("1.05"));
      expect(f2[1]).to.eq(toPerc("0"));
      expect(f2[2]).to.eq(toPerc("1.5"));
      expect(f2[3]).to.eq(toPerc("0.25"));

      const drEq = await feePolicy.drEqZone();
      expect(drEq[0]).to.eq(toPerc("0.95"));
      expect(drEq[1]).to.eq(toPerc("1.05"));

      expect(await feePolicy.perpDebasementLag()).to.eq(30);
      expect(await feePolicy.perpEnrichmentLag()).to.eq(30);

      const l1 = await feePolicy.perpDebasementPercLimits();
      expect(l1[0]).to.eq(toPerc("0.005"));
      expect(l1[1]).to.eq(toPerc("0.025"));

      const l2 = await feePolicy.perpEnrichmentPercLimits();
      expect(l2[0]).to.eq(toPerc("0.005"));
      expect(l2[1]).to.eq(toPerc("0.025"));

      expect(await feePolicy.rebalanceFreqSec()).to.eq(86400);
      expect(await feePolicy.protocolSharePerc()).to.eq(toPerc("0.01"));
      expect(await feePolicy.protocolFeeCollector()).to.eq(await deployer.getAddress());
    });
    it("should return owner", async function () {
      expect(await feePolicy.owner()).to.eq(await deployer.getAddress());
    });
    it("should return decimals", async function () {
      expect(await feePolicy.decimals()).to.eq(8);
    });
  });

  describe("#updateTargetSubscriptionRatio", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(otherUser).updateTargetSubscriptionRatio(toPerc("1.25"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when triggered by owner", function () {
      it("should update the target sr", async function () {
        expect(await feePolicy.targetSubscriptionRatio()).to.eq(toPerc("1.5"));
        await feePolicy.connect(deployer).updateTargetSubscriptionRatio(toPerc("1.25"));
        expect(await feePolicy.targetSubscriptionRatio()).to.eq(toPerc("1.25"));
      });
    });
  });

  describe("#updateFees", function () {
    const VALID_DOWN = toLine("0.0", "1.0", "0.99", "0.0");
    const VALID_UP = toLine("1.01", "0.0", "2.0", "1.0");

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(otherUser).updateFees(VALID_DOWN, VALID_UP)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when parameters are invalid (InvalidFees)", function () {
      it("x1 > x2 for downwards leg", async function () {
        const badDown = toLine("1.1", "1.0", "1.0", "0.0");
        await expect(feePolicy.connect(deployer).updateFees(badDown, VALID_UP)).to.be.revertedWithCustomError(
          feePolicy,
          "InvalidFees",
        );
      });

      it("equilibrium zone crosses 1.0", async function () {
        const badDown = toLine("0.0", "1.0", "1.1", "0.0");
        await expect(feePolicy.connect(deployer).updateFees(badDown, VALID_UP)).to.be.revertedWithCustomError(
          feePolicy,
          "InvalidFees",
        );

        const badUp = toLine("0.9", "0.0", "2.0", "1.0");
        await expect(feePolicy.connect(deployer).updateFees(VALID_DOWN, badUp)).to.be.revertedWithCustomError(
          feePolicy,
          "InvalidFees",
        );
      });

      it("fees not monotonic wrt distance from 1.0", async function () {
        const badDown = toLine("0.0", "0.0", "1.0", "1.0");
        await expect(feePolicy.connect(deployer).updateFees(badDown, VALID_UP)).to.be.revertedWithCustomError(
          feePolicy,
          "InvalidFees",
        );

        const badUp = toLine("1.0", "1.0", "2.0", "0.5");
        await expect(feePolicy.connect(deployer).updateFees(VALID_DOWN, badUp)).to.be.revertedWithCustomError(
          feePolicy,
          "InvalidFees",
        );
      });

      it("fee percentage > 1 (100 %)", async function () {
        await expect(
          feePolicy.connect(deployer).updateFees(toLine("0.0", "1.1", "1.0", "0.1"), VALID_UP),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidFees");
        await expect(
          feePolicy.connect(deployer).updateFees(VALID_DOWN, toLine("1.0", "0", "2.0", "1.1")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidFees");
      });
    });

    describe("when triggered by owner with valid parameters", function () {
      it("should update the fee functions", async function () {
        await feePolicy.connect(deployer).updateFees(VALID_DOWN, VALID_UP);
        const f1 = await feePolicy.feeFnDRDown();
        expect(f1.x1).to.eq(VALID_DOWN.x1);
        expect(f1.y1).to.eq(VALID_DOWN.y1);
        expect(f1.x2).to.eq(VALID_DOWN.x2);
        expect(f1.y2).to.eq(VALID_DOWN.y2);
        const f2 = await feePolicy.feeFnDRUp();
        expect(f2.x1).to.eq(VALID_UP.x1);
        expect(f2.y1).to.eq(VALID_UP.y1);
        expect(f2.x2).to.eq(VALID_UP.x2);
        expect(f2.y2).to.eq(VALID_UP.y2);
      });
    });
  });

  describe("#updateRebalanceConfig", function () {
    const DEBASE_LAG = 30;
    const ENRICH_LAG = 30;
    const DEBASE_RNG = toRange("0.01", "0.05");
    const ENRICH_RNG = toRange("0.01", "0.03");
    const REBAL_FREQ = 86_400;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feePolicy
            .connect(otherUser)
            .updateRebalanceConfig(DEBASE_LAG, ENRICH_LAG, DEBASE_RNG, ENRICH_RNG, REBAL_FREQ),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when range is invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy
            .connect(deployer)
            .updateRebalanceConfig(DEBASE_LAG, ENRICH_LAG, toRange("0.06", "0.05"), ENRICH_RNG, REBAL_FREQ),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidRange");
        await expect(
          feePolicy
            .connect(deployer)
            .updateRebalanceConfig(DEBASE_LAG, ENRICH_LAG, DEBASE_RNG, toRange("0.06", "0.05"), REBAL_FREQ),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidRange");
      });
    });

    describe("when triggered by owner", function () {
      it("should update every field", async function () {
        await feePolicy
          .connect(deployer)
          .updateRebalanceConfig(DEBASE_LAG, ENRICH_LAG, DEBASE_RNG, ENRICH_RNG, REBAL_FREQ);

        const newDebaseLag = await feePolicy.perpDebasementLag();
        const newEnrichLag = await feePolicy.perpEnrichmentLag();
        const newDebaseRng = await feePolicy.perpDebasementPercLimits();
        const newEnrichRng = await feePolicy.perpEnrichmentPercLimits();
        const newFreq = await feePolicy.rebalanceFreqSec();

        expect(newDebaseLag).to.equal(DEBASE_LAG);
        expect(newEnrichLag).to.equal(ENRICH_LAG);
        expect(newDebaseRng.lower).to.equal(DEBASE_RNG.lower);
        expect(newDebaseRng.upper).to.equal(DEBASE_RNG.upper);
        expect(newEnrichRng.lower).to.equal(ENRICH_RNG.lower);
        expect(newEnrichRng.upper).to.equal(ENRICH_RNG.upper);
        expect(newFreq).to.equal(REBAL_FREQ);
      });
    });
  });

  describe("#updateProtocolFeeConfig", function () {
    const VALID_SHARE = toPerc("0.05");
    const OVER_SHARE = toPerc("1.01");

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(otherUser).updateProtocolFeeConfig(VALID_SHARE, await otherUser.getAddress()),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when percentage is > 100 %", function () {
      it("should revert with InvalidPerc", async function () {
        await expect(
          feePolicy.connect(deployer).updateProtocolFeeConfig(OVER_SHARE, await otherUser.getAddress()),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
      });
    });

    describe("when called by owner with valid params", function () {
      it("should update both fields", async function () {
        await feePolicy.connect(deployer).updateProtocolFeeConfig(VALID_SHARE, await otherUser.getAddress());
        expect(await feePolicy.protocolSharePerc()).to.eq(VALID_SHARE);
        expect(await feePolicy.protocolFeeCollector()).to.eq(await otherUser.getAddress());
      });
    });
  });

  describe("fee logic", function () {
    beforeEach(async function () {
      await feePolicy.updateFees(toLine("0.66", "0.5", "0.99", "0"), toLine("1.01", "0.01", "1.5", "0.5"));
    });

    async function cmpFees(dr1, dr2, fees) {
      expect(await feePolicy.computeFeePerc(toPerc(dr1), toPerc(dr2))).to.eq(toPerc(fees));
    }

    describe("when dr is decreasing", function () {
      it("should compute fees as expected", async function () {
        await cmpFees("1.1", "1.01", "0");
        await cmpFees("1.01", "1", "0");
        await cmpFees("1.05", "0.95", "0.01212121");
        await cmpFees("1.01", "0.96", "0.01363636");
        await cmpFees("1.1", "0.99", "0");
        await cmpFees("0.99", "0.95", "0.03030304");
        await cmpFees("0.9", "0.8", "0.21212122");
        await cmpFees("1.2", "0.8", "0.06837121");
        await cmpFees("0.8", "0.75", "0.32575758");
      });
    });

    describe("when dr is increasing", function () {
      it("should compute fees as expected", async function () {
        await cmpFees("0.8", "0.8", "0.01");
        await cmpFees("0.9", "0.99", "0.01");
        await cmpFees("0.9", "1", "0.01");
        await cmpFees("0.95", "1.05", "0.018");
        await cmpFees("0.99", "1.04", "0.019");
        await cmpFees("0.99", "1.1", "0.04681818");
        await cmpFees("1.01", "1.05", "0.03");
        await cmpFees("1.01", "1.25", "0.13");
        await cmpFees("1.25", "1.35", "0.3");
      });
    });
  });

  describe("#computeDeviationRatio", async function () {
    beforeEach(async function () {
      await feePolicy.updateTargetSubscriptionRatio(toPerc("1.25"));
    });

    describe("when deviation = 1.0", function () {
      it("should return 1", async function () {
        const r = await feePolicy["computeDeviationRatio((uint256,uint256,uint256))"]({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("500"),
          seniorTR: 200,
        });
        expect(r).to.eq(toPerc("1"));
      });
    });

    describe("when deviation > 1.0", function () {
      it("should compute dr", async function () {
        const r = await feePolicy["computeDeviationRatio((uint256,uint256,uint256))"]({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("1000"),
          seniorTR: 200,
        });
        expect(r).to.eq(toPerc("2"));
      });
    });

    describe("when deviation < 1.0", function () {
      it("should compute dr", async function () {
        const r = await feePolicy["computeDeviationRatio((uint256,uint256,uint256))"]({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("250"),
          seniorTR: 200,
        });
        expect(r).to.eq(toPerc("0.5"));
      });
    });
  });

  describe("#computeDRNormSeniorTR", function () {
    it("should compute the dr norm ratio", async function () {
      await feePolicy.updateTargetSubscriptionRatio(toPerc("2"));
      expect(await feePolicy.computeDRNormSeniorTR(200)).to.eq(toPerc("0.11111111"));
      expect(await feePolicy.computeDRNormSeniorTR(500)).to.eq(toPerc("0.33333333"));
      expect(await feePolicy.computeDRNormSeniorTR(333)).to.eq(toPerc("0.19976004"));
      expect(await feePolicy.computeDRNormSeniorTR(666)).to.eq(toPerc("0.49925037"));
      expect(await feePolicy.computeDRNormSeniorTR(750)).to.eq(toPerc("0.6"));
    });
  });

  describe("#computeRebalanceAmount", async function () {
    beforeEach(async function () {
      await feePolicy.updateTargetSubscriptionRatio(toPerc("1.25"));
      await feePolicy.connect(deployer).updateRebalanceConfig(1, 1, toRange("0", "10"), toRange("0", "10"), 86400);
    });

    describe("when deviation is within eq range", function () {
      it("should compute rebalance data", async function () {
        await feePolicy.updateFees(toLine("0", "0.5", "0.5", "0"), toLine("2", "0", "10", "0.5"));
        const r1 = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("120"),
          vaultTVL: toAmt("500"),
          seniorTR: 200,
        });
        expect(r1).to.eq(0n);
        const r2 = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("80"),
          vaultTVL: toAmt("500"),
          seniorTR: 200,
        });
        expect(r2).to.eq(0n);
      });
    });

    describe("when deviation = 1.0", function () {
      it("should compute rebalance data", async function () {
        const r = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("500"),
          seniorTR: 200,
        });
        expect(r).to.eq(0n);
      });
    });

    describe("when deviation ~= 1.0", function () {
      it("should compute rebalance data", async function () {
        const r = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("500.001"),
          seniorTR: 200,
        });
        expect(r).to.eq(0n);
      });
    });

    describe("when deviation ~= 1.0", function () {
      it("should compute rebalance data", async function () {
        const r = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("99.999"),
          vaultTVL: toAmt("500"),
          seniorTR: 200,
        });
        expect(r).to.eq(0n);
      });
    });

    describe("enrichment", function () {
      it("should compute rebalance data", async function () {
        const r = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("1000"),
          seniorTR: 200,
        });
        expect(r).to.eq(toAmt("83.333326"));
      });

      it("should compute rebalance data", async function () {
        await feePolicy.connect(deployer).updateRebalanceConfig(1, 2, toRange("0", "10"), toRange("0", "10"), 86400);
        const r = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("1000"),
          seniorTR: 200,
        });
        expect(r).to.eq(toAmt("41.666663"));
      });

      it("should compute rebalance data", async function () {
        await feePolicy.connect(deployer).updateRebalanceConfig(1, 10, toRange("0", "10"), toRange("0.1", "10"), 86400);
        const r = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("1000"),
          seniorTR: 200,
        });
        expect(r).to.eq(toAmt("10"));
      });

      it("should compute rebalance data", async function () {
        await feePolicy.connect(deployer).updateRebalanceConfig(1, 10, toRange("0", "10"), toRange("0", "0.05"), 86400);
        const r = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("1000"),
          seniorTR: 200,
        });
        expect(r).to.eq(toAmt("5"));
      });

      it("should compute rebalance data", async function () {
        await feePolicy.connect(deployer).updateRebalanceConfig(1, 10, toRange("0", "10"), toRange("1", "10"), 86400);
        const r = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("1000"),
          seniorTR: 200,
        });
        expect(r).to.eq(toAmt("83.333326"));
      });
    });

    describe("debasement", function () {
      it("should compute rebalance data", async function () {
        const r = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("1000"),
          vaultTVL: toAmt("2500"),
          seniorTR: 200,
        });
        expect(r).to.eq(toAmt("-416.66669"));
      });

      it("should compute rebalance data", async function () {
        await feePolicy.connect(deployer).updateRebalanceConfig(2, 1, toRange("0", "10"), toRange("0", "10"), 86400);
        const r = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("1000"),
          vaultTVL: toAmt("2500"),
          seniorTR: 200,
        });
        expect(r).to.eq(toAmt("-208.333345"));
      });

      it("should compute rebalance data", async function () {
        await feePolicy
          .connect(deployer)
          .updateRebalanceConfig(10, 1, toRange("0.05", "10"), toRange("0", "10"), 86400);
        const r = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("1000"),
          vaultTVL: toAmt("2500"),
          seniorTR: 200,
        });
        expect(r).to.eq(toAmt("-50"));
      });

      it("should compute rebalance data", async function () {
        await feePolicy.connect(deployer).updateRebalanceConfig(10, 1, toRange("0", "0.03"), toRange("0", "10"), 86400);
        const r = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("1000"),
          vaultTVL: toAmt("2500"),
          seniorTR: 200,
        });
        expect(r).to.eq(toAmt("-30"));
      });

      it("should compute rebalance data", async function () {
        await feePolicy.connect(deployer).updateRebalanceConfig(10, 1, toRange("1", "10"), toRange("0", "10"), 86400);
        const r = await feePolicy.computeRebalanceAmount({
          perpTVL: toAmt("1000"),
          vaultTVL: toAmt("2500"),
          seniorTR: 200,
        });
        expect(r).to.eq(toAmt("-416.66669"));
      });
    });
  });
});
