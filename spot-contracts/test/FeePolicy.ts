import { expect, use } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";
import { smock } from "@defi-wonderland/smock";

import { toPercFixedPtAmt, toFixedPtAmt } from "./helpers";
use(smock.matchers);

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
      expect(await feePolicy.targetSubscriptionRatio()).to.eq(toPerc("1.33"));
      expect(await feePolicy.deviationRatioBoundLower()).to.eq(toPerc("0.75"));
      expect(await feePolicy.deviationRatioBoundUpper()).to.eq(toPerc("2"));
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
        expect(await feePolicy.targetSubscriptionRatio()).to.eq(toPerc("1.33"));
        await feePolicy.connect(deployer).updateTargetSubscriptionRatio(toPerc("1.25"));
        expect(await feePolicy.targetSubscriptionRatio()).to.eq(toPerc("1.25"));
      });
    });
  });

  describe("#updateDeviationRatioBounds", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(otherUser).updateDeviationRatioBounds(toPerc("1"), toPerc("1")),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateDeviationRatioBounds(toPerc("1.01"), toPerc("2")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidDRBounds");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateDeviationRatioBounds(toPerc("0.5"), toPerc("0.99")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidDRBounds");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the target sr", async function () {
        expect(await feePolicy.deviationRatioBoundLower()).to.eq(toPerc("0.75"));
        expect(await feePolicy.deviationRatioBoundUpper()).to.eq(toPerc("2"));
        await feePolicy.connect(deployer).updateDeviationRatioBounds(toPerc("0.5"), toPerc("1.5"));
        expect(await feePolicy.deviationRatioBoundLower()).to.eq(toPerc("0.5"));
        expect(await feePolicy.deviationRatioBoundUpper()).to.eq(toPerc("1.5"));
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

  describe("#updatePerpRolloverFees", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(otherUser).updatePerpRolloverFees({
            maxPerpDebasementPerc: toPerc("0.01"),
            m1: toPerc("0.01"),
            m2: toPerc("0.01"),
          }),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when triggered by owner", function () {
      it("should update parameters", async function () {
        await feePolicy.connect(deployer).updatePerpRolloverFees({
          maxPerpDebasementPerc: toPerc("0.01"),
          m1: toPerc("0.02"),
          m2: toPerc("0.03"),
        });
        const p = await feePolicy.perpRolloverFee();
        expect(p.maxPerpDebasementPerc).to.eq(toPerc("0.01"));
        expect(p.m1).to.eq(toPerc("0.02"));
        expect(p.m2).to.eq(toPerc("0.03"));
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

  describe("#updateVaultUnderlyingToPerpSwapFeePerc", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(otherUser).updateVaultUnderlyingToPerpSwapFeePerc(toPerc("0.1")),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateVaultUnderlyingToPerpSwapFeePerc(toPerc("1.01")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the vault burn fees", async function () {
        expect(await feePolicy.computeUnderlyingToPerpVaultSwapFeePerc(toPerc("1.01"), toPerc("1.01"))).to.eq(
          toPerc("1"),
        );
        await feePolicy.connect(deployer).updateVaultUnderlyingToPerpSwapFeePerc(toPerc("0.1"));
        expect(await feePolicy.computeUnderlyingToPerpVaultSwapFeePerc(toPerc("1.01"), toPerc("1.01"))).to.eq(
          toPerc("0.1"),
        );
      });
    });
  });

  describe("#updateVaultPerpToUnderlyingSwapFeePerc", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(otherUser).updateVaultPerpToUnderlyingSwapFeePerc(toPerc("0.1")),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateVaultPerpToUnderlyingSwapFeePerc(toPerc("1.01")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the vault burn fees", async function () {
        expect(await feePolicy.computePerpToUnderlyingVaultSwapFeePerc(toPerc("1"), toPerc("1"))).to.eq(toPerc("1"));
        await feePolicy.connect(deployer).updateVaultPerpToUnderlyingSwapFeePerc(toPerc("0.2"));
        expect(await feePolicy.computePerpToUnderlyingVaultSwapFeePerc(toPerc("1"), toPerc("1"))).to.eq(toPerc("0.2"));
      });
    });
  });

  describe("fee logic", function () {
    beforeEach(async function () {
      await feePolicy.updatePerpMintFees(toPerc("0.025"));
      await feePolicy.updatePerpBurnFees(toPerc("0.035"));
      await feePolicy.updatePerpRolloverFees({
        maxPerpDebasementPerc: toPerc("0.1"),
        m1: toPerc("0.3"),
        m2: toPerc("0.6"),
      });
      await feePolicy.updateVaultUnderlyingToPerpSwapFeePerc(toPerc("0.1"));
      await feePolicy.updateVaultPerpToUnderlyingSwapFeePerc(toPerc("0.15"));
      await feePolicy.updateVaultMintFees(toPerc("0.05"));
      await feePolicy.updateVaultBurnFees(toPerc("0.075"));
      await feePolicy.updateDeviationRatioBounds(toPerc("0.85"), toPerc("1.15"));
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
          await cmpFees("1.05", "0.95", ["0.025", "0.075", "0.1"]);
        });
      });

      describe("when dr2 < ONE < dr1", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("1.01", "0.96", ["0.025", "0.075", "0.1"]);
        });
      });

      describe("when dr2 < ONE < dr1", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("1.1", "0.99", ["0.025", "0.075", "0.1"]);
        });
      });

      describe("when dr2,dr1 < ONE", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("0.99", "0.95", ["0.025", "0.075", "0.1"]);
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
          await cmpFees("0.95", "1.05", ["0.035", "0.05", "0.15"]);
        });
      });

      describe("when dr1 < ONE < dr2", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("0.99", "1.04", ["0.035", "0.05", "0.15"]);
        });
      });

      describe("when dr1 < ONE < dr2", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("0.99", "1.1", ["0.035", "0.05", "0.15"]);
        });
      });

      describe("when ONE < dr1, dr2 < upper", function () {
        it("should compute fees as expected", async function () {
          await cmpFees("1.01", "1.05", ["0.035", "0.05", "0.15"]);
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

    describe("rollover fee", function () {
      it("should compute fees as expected", async function () {
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("0"))).to.eq(toPerc("-0.1"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("0.01"))).to.eq(toPerc("-0.1"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("0.25"))).to.eq(toPerc("-0.1"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("0.5"))).to.eq(toPerc("-0.1"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("0.66"))).to.eq(toPerc("-0.1"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("0.7"))).to.eq(toPerc("-0.09"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("0.8"))).to.eq(toPerc("-0.06"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("0.9"))).to.eq(toPerc("-0.03"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("0.99"))).to.eq(toPerc("-0.003"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("1"))).to.eq("0");
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("1.01"))).to.eq(toPerc("0.006"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("1.05"))).to.eq(toPerc("0.03"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("1.1"))).to.eq(toPerc("0.06"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("1.25"))).to.eq(toPerc("0.15"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("1.5"))).to.eq(toPerc("0.3"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("1.75"))).to.eq(toPerc("0.45"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("2"))).to.eq(toPerc("0.6"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("5"))).to.eq(toPerc("2.4"));
        expect(await feePolicy.computePerpRolloverFeePerc(toPerc("10"))).to.eq(toPerc("5.4"));
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
});
