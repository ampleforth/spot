import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";

import { toPercFixedPtAmt, toFixedPtAmt } from "./helpers";

let feePolicy: Contract, deployer: Signer, otherUser: Signer;
const toPerc = toPercFixedPtAmt;
const toAmt = toFixedPtAmt;

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

      const s1 = await feePolicy.drHardBound();
      expect(s1[0]).to.eq(toPerc("0.75"));
      expect(s1[1]).to.eq(toPerc("2"));

      const s2 = await feePolicy.drSoftBound();
      expect(s2[0]).to.eq(toPerc("0.9"));
      expect(s2[1]).to.eq(toPerc("1.25"));

      expect(await feePolicy.perpMintFeePerc()).to.eq(0n);
      expect(await feePolicy.perpBurnFeePerc()).to.eq(0n);
      expect(await feePolicy.vaultMintFeePerc()).to.eq(0n);
      expect(await feePolicy.vaultBurnFeePerc()).to.eq(0n);

      const fm = await feePolicy.flashMintFeePercs();
      expect(fm[0]).to.eq(toPerc("1"));
      expect(fm[1]).to.eq(toPerc("1"));
      const fr = await feePolicy.flashRedeemFeePercs();
      expect(fr[0]).to.eq(toPerc("1"));
      expect(fr[1]).to.eq(toPerc("1"));
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

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateTargetSubscriptionRatio(toPerc("0.5")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidTargetSRBounds");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateTargetSubscriptionRatio(toPerc("2.1")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidTargetSRBounds");
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

  describe("#updateDRBounds", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(otherUser).updateDRBounds([toPerc("1"), toPerc("1")], [toPerc("1"), toPerc("1")]),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateDRBounds([toPerc("0.9"), toPerc("2")], [toPerc("0.75"), toPerc("1.5")]),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidDRBounds");
        await expect(
          feePolicy.connect(deployer).updateDRBounds([toPerc("0.5"), toPerc("2")], [toPerc("2"), toPerc("1.5")]),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidDRBounds");
        await expect(
          feePolicy.connect(deployer).updateDRBounds([toPerc("0.5"), toPerc("2")], [toPerc("0.75"), toPerc("0.6")]),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidDRBounds");
        await expect(
          feePolicy.connect(deployer).updateDRBounds([toPerc("0.5"), toPerc("2")], [toPerc("0.75"), toPerc("2.5")]),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidDRBounds");
      });
    });

    describe("when triggered by owner", function () {
      it("should update dr hard bounds", async function () {
        await feePolicy.connect(deployer).updateDRBounds([toPerc("0.5"), toPerc("2")], [toPerc("0.75"), toPerc("1.5")]);
        const s1 = await feePolicy.drHardBound();
        expect(s1[0]).to.eq(toPerc("0.5"));
        expect(s1[1]).to.eq(toPerc("2"));
        const s2 = await feePolicy.drSoftBound();
        expect(s2[0]).to.eq(toPerc("0.75"));
        expect(s2[1]).to.eq(toPerc("1.5"));
      });
    });
  });

  describe("#updatePerpMintFees", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(otherUser).updatePerpMintFees(toPerc("0.01"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(deployer).updatePerpMintFees(toPerc("1.01"))).to.be.revertedWithCustomError(
          feePolicy,
          "InvalidPerc",
        );
      });
    });

    describe("when triggered by owner", function () {
      it("should update the mint fees", async function () {
        expect(await feePolicy.computePerpMintFeePerc()).to.eq("0");
        await feePolicy.connect(deployer).updatePerpMintFees(toPerc("0.01"));
        expect(await feePolicy.computePerpMintFeePerc()).to.eq(toPerc("0.01"));
      });
    });
  });

  describe("#updatePerpBurnFees", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(otherUser).updatePerpBurnFees(toPerc("0.01"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(deployer).updatePerpBurnFees(toPerc("1.01"))).to.be.revertedWithCustomError(
          feePolicy,
          "InvalidPerc",
        );
      });
    });

    describe("when triggered by owner", function () {
      it("should update the burn fees", async function () {
        expect(await feePolicy.computePerpBurnFeePerc()).to.eq("0");
        await feePolicy.connect(deployer).updatePerpBurnFees(toPerc("0.01"));
        expect(await feePolicy.computePerpBurnFeePerc()).to.eq(toPerc("0.01"));
      });
    });
  });

  describe("#updateVaultMintFees", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(otherUser).updateVaultMintFees(toPerc("0.01"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(deployer).updateVaultMintFees(toPerc("1.01"))).to.be.revertedWithCustomError(
          feePolicy,
          "InvalidPerc",
        );
      });
    });

    describe("when triggered by owner", function () {
      beforeEach(async function () {});
      it("should update the vault mint fees", async function () {
        expect(await feePolicy.computeVaultMintFeePerc()).to.eq("0");
        await feePolicy.connect(deployer).updateVaultMintFees(toPerc("0.025"));
        expect(await feePolicy.computeVaultMintFeePerc()).to.eq(toPerc("0.025"));
      });
    });
  });

  describe("#updateVaultBurnFees", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(otherUser).updateVaultBurnFees(toPerc("0.01"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(deployer).updateVaultBurnFees(toPerc("1.01"))).to.be.revertedWithCustomError(
          feePolicy,
          "InvalidPerc",
        );
      });
    });

    describe("when triggered by owner", function () {
      it("should update the vault burn fees", async function () {
        expect(await feePolicy.computeVaultBurnFeePerc()).to.eq("0");
        await feePolicy.connect(deployer).updateVaultBurnFees(toPerc("0.025"));
        expect(await feePolicy.computeVaultBurnFeePerc()).to.eq(toPerc("0.025"));
      });
    });
  });

  describe("#updateFlashFees", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(otherUser).updateFlashFees([toPerc("0.1"), toPerc("0.2")], [toPerc("0.15"), toPerc("0.5")]),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateFlashFees([toPerc("1.1"), toPerc("0.2")], [toPerc("0.15"), toPerc("0.5")]),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
        await expect(
          feePolicy.connect(deployer).updateFlashFees([toPerc("0.1"), toPerc("1.2")], [toPerc("0.15"), toPerc("0.5")]),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
        await expect(
          feePolicy.connect(deployer).updateFlashFees([toPerc("0.1"), toPerc("0.2")], [toPerc("1.15"), toPerc("0.5")]),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
        await expect(
          feePolicy.connect(deployer).updateFlashFees([toPerc("0.1"), toPerc("0.2")], [toPerc("0.15"), toPerc("1.5")]),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the flash fees", async function () {
        await feePolicy
          .connect(deployer)
          .updateFlashFees([toPerc("0.1"), toPerc("0.2")], [toPerc("0.15"), toPerc("0.5")]);
        const m = await feePolicy.flashMintFeePercs();
        expect(m[0]).to.eq(toPerc("0.1"));
        expect(m[1]).to.eq(toPerc("0.2"));
        const r = await feePolicy.flashRedeemFeePercs();
        expect(r[0]).to.eq(toPerc("0.15"));
        expect(r[1]).to.eq(toPerc("0.5"));
      });
    });
  });

  describe("#updateRebalanceLag", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(otherUser).updateRebalanceLag(29, 29)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when value is invalid", function () {
      it("should update parameters", async function () {
        await expect(feePolicy.connect(deployer).updateRebalanceLag(5, 29)).to.be.revertedWithCustomError(
          feePolicy,
          "ValueTooLow",
        );
        await expect(feePolicy.connect(deployer).updateRebalanceLag(29, 5)).to.be.revertedWithCustomError(
          feePolicy,
          "ValueTooLow",
        );
      });
    });

    describe("when triggered by owner", function () {
      it("should update parameters", async function () {
        await feePolicy.connect(deployer).updateRebalanceLag(29, 29);
        expect(await feePolicy.debasementLag()).to.eq(29);
        expect(await feePolicy.enrichmentLag()).to.eq(29);
      });
    });
  });

  describe("#updateProtocolSharePerc", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(otherUser).updateProtocolSharePerc(toPerc("0.05"), toPerc("0.15")),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when value is invalid", function () {
      it("should update parameters", async function () {
        await expect(
          feePolicy.connect(deployer).updateProtocolSharePerc(0, toPerc("1.05")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
        await expect(
          feePolicy.connect(deployer).updateProtocolSharePerc(toPerc("1.05"), 0),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
      });
    });

    describe("when triggered by owner", function () {
      it("should update parameters", async function () {
        await feePolicy.connect(deployer).updateProtocolSharePerc(toPerc("0.05"), toPerc("0.15"));
        expect(await feePolicy.debasementProtocolSharePerc()).to.eq(toPerc("0.05"));
        expect(await feePolicy.enrichmentProtocolSharePerc()).to.eq(toPerc("0.15"));
      });
    });
  });
  describe("fee logic", function () {
    beforeEach(async function () {
      await feePolicy.updatePerpMintFees(toPerc("0.025"));
      await feePolicy.updatePerpBurnFees(toPerc("0.035"));
      await feePolicy.updateFlashFees([toPerc("0.1"), toPerc("0.2")], [toPerc("0.15"), toPerc("0.5")]);
      await feePolicy.updateVaultMintFees(toPerc("0.05"));
      await feePolicy.updateVaultBurnFees(toPerc("0.075"));
      await feePolicy.updateDRBounds([toPerc("0.85"), toPerc("1.15")], [toPerc("0.999"), toPerc("1.001")]);
    });

    describe("when dr is decreasing", function () {
      async function cmpFees(dr1, dr2, fees) {
        // perp mint, vault burn and swap u2p
        expect(await feePolicy.computePerpMintFeePerc()).to.eq(toPerc(fees[0]));
        expect(await feePolicy.computeVaultBurnFeePerc()).to.eq(toPerc(fees[1]));
        expect(await feePolicy.computeUnderlyingToPerpVaultSwapFeePerc(toPerc(dr1), toPerc(dr2))).to.eq(
          toPerc(fees[2]),
        );
      }

      describe("when ONE < dr2, dr1", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("1.1", "1.01", ["0.025", "0.075", "0.1"]);
        });
      });

      describe("when ONE <= dr2, dr1", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("1.01", "1", ["0.025", "0.075", "0.1"]);
        });
      });

      describe("when dr2 < ONE < dr1", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("1.05", "0.95", ["0.025", "0.075", "0.10805704"]);
        });
      });

      describe("when dr2 < ONE < dr1", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("1.01", "0.96", ["0.025", "0.075", "0.11020804"]);
        });
      });

      describe("when dr2 < ONE < dr1", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("1.1", "0.99", ["0.025", "0.075", "0.10024710"]);
        });
      });

      describe("when dr2,dr1 < ONE", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("0.99", "0.95", ["0.025", "0.075", "0.11946308"]);
        });
      });

      describe("when dr2 < lower < dr1 < ONE", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("0.9", "0.8", ["0.025", "0.075", "1"]);
        });
      });

      describe("when dr2 < lower < ONE < dr1", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("1.2", "0.8", ["0.025", "0.075", "1"]);
        });
      });

      describe("when dr2,dr1 < lower", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("0.8", "0.75", ["0.025", "0.075", "1"]);
        });
      });
    });

    describe("when dr is increasing", function () {
      async function cmpFees(dr1, dr2, fees) {
        // perp burn, vault mint and swap p2u
        expect(await feePolicy.computePerpBurnFeePerc()).to.eq(toPerc(fees[0]));
        expect(await feePolicy.computeVaultMintFeePerc()).to.eq(toPerc(fees[1]));
        expect(await feePolicy.computePerpToUnderlyingVaultSwapFeePerc(toPerc(dr1), toPerc(dr2))).to.eq(
          toPerc(fees[2]),
        );
      }

      describe("when dr1, dr2 < ONE", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("0.9", "0.99", ["0.035", "0.05", "0.15"]);
        });
      });

      describe("when dr1, dr2 <= ONE", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("0.9", "1", ["0.035", "0.05", "0.15"]);
        });
      });

      describe("when dr1 < ONE < dr2", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("0.95", "1.05", ["0.035", "0.05", "0.17819966"]);
        });
      });

      describe("when dr1 < ONE < dr2", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("0.99", "1.04", ["0.035", "0.05", "0.18572818"]);
        });
      });

      describe("when dr1 < ONE < dr2", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("0.99", "1.1", ["0.035", "0.05", "0.25464764"]);
        });
      });

      describe("when ONE < dr1, dr2 < upper", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("1.01", "1.05", ["0.035", "0.05", "0.2181208"]);
        });
      });

      describe("when ONE < dr1 < upper < dr2", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("1.01", "1.25", ["0.035", "0.05", "1"]);
        });
      });

      describe("when dr1 < ONE < upper < dr2", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("1.01", "1.25", ["0.035", "0.05", "1"]);
        });
      });

      describe("when upper < dr1, dr2", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("1.25", "1.35", ["0.035", "0.05", "1"]);
        });
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

  describe("#computePerpEquilibriumPerc", async function () {
    beforeEach(async function () {
      await feePolicy.updateTargetSubscriptionRatio(toPerc("1.25"));
    });

    describe("when deviation = 1.0", function () {
      it("should return 1", async function () {
        const r = await feePolicy.computePerpEquilibriumPerc({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("500"),
          seniorTR: 200,
        });
        expect(r[0]).to.eq(true);
        expect(r[1]).to.eq(0n);
      });
    });

    describe("when deviation > 1.0", function () {
      it("should compute dr", async function () {
        const r = await feePolicy.computePerpEquilibriumPerc({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("1000"),
          seniorTR: 200,
        });
        expect(r[0]).to.eq(false);
        expect(r[1]).to.eq(toPerc("0.83333333"));
      });
    });

    describe("when deviation < 1.0", function () {
      it("should compute dr", async function () {
        const r = await feePolicy.computePerpEquilibriumPerc({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("250"),
          seniorTR: 200,
        });
        expect(r[0]).to.eq(true);
        expect(r[1]).to.eq(toPerc("0.41666666"));
      });
    });
  });

  describe("#computeRebalanceData", async function () {
    beforeEach(async function () {
      await feePolicy.updateTargetSubscriptionRatio(toPerc("1.25"));
      await feePolicy.updateProtocolSharePerc(toPerc("0.05"), toPerc("0.1"));
      await feePolicy.updateRebalanceLag(100, 100);
    });

    describe("when deviation = 1.0", function () {
      it("should return 1", async function () {
        const r = await feePolicy.computeRebalanceData({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("500"),
          seniorTR: 200,
        });
        expect(r[0]).to.eq(true);
        expect(r[1]).to.eq(0n);
        expect(r[2]).to.eq(0n);
      });
    });

    describe("when deviation > 1.0", function () {
      it("should compute dr", async function () {
        const r = await feePolicy.computeRebalanceData({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("1000"),
          seniorTR: 200,
        });
        expect(r[0]).to.eq(false);
        expect(r[1]).to.eq(toFixedPtAmt("0.7499997"));
        expect(r[2]).to.eq(toFixedPtAmt("0.0833333"));
      });
    });

    describe("when enrichment rate is very high", function () {
      it("should compute dr", async function () {
        const r = await feePolicy.computeRebalanceData({
          perpTVL: toAmt("1000"),
          vaultTVL: toAmt("100000"),
          seniorTR: 200,
        });
        expect(r[0]).to.eq(false);
        expect(r[1]).to.eq(toFixedPtAmt("9"));
        expect(r[2]).to.eq(toFixedPtAmt("1"));
      });
    });

    describe("when deviation < 1.0", function () {
      it("should compute dr", async function () {
        const r = await feePolicy.computeRebalanceData({
          perpTVL: toAmt("1000"),
          vaultTVL: toAmt("2500"),
          seniorTR: 200,
        });
        expect(r[0]).to.eq(true);
        expect(r[1]).to.eq(toFixedPtAmt("3.958327"));
        expect(r[2]).to.eq(toFixedPtAmt("0.208333"));
      });
    });

    describe("when debasement rate is very high", function () {
      it("should compute dr", async function () {
        await feePolicy.updateRebalanceLag(30, 100);
        const r = await feePolicy.computeRebalanceData({
          perpTVL: toAmt("10000"),
          vaultTVL: toAmt("250"),
          seniorTR: 200,
        });
        expect(r[0]).to.eq(true);
        expect(r[1]).to.eq(toFixedPtAmt("95"));
        expect(r[2]).to.eq(toFixedPtAmt("5"));
      });
    });
  });
});
