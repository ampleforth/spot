import { expect, use } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";
import { smock } from "@defi-wonderland/smock";

import { toPercFixedPtAmt, toFixedPtAmt } from "./helpers";
use(smock.matchers);

let feePolicy: Contract, deployer: Signer, otherUser: Signer;

describe("FeePolicy", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    const factory = await ethers.getContractFactory("FeePolicy");
    feePolicy = await factory.deploy();
    await feePolicy.init();
  });

  describe("#init", function () {
    it("should return the initial parameters", async function () {
      expect(await feePolicy.targetSubscriptionRatio()).to.eq(toPercFixedPtAmt("1.33"));
      expect(await feePolicy.deviationRatioBoundLower()).to.eq(toPercFixedPtAmt("0.75"));
      expect(await feePolicy.deviationRatioBoundUpper()).to.eq(toPercFixedPtAmt("2"));
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
        await expect(
          feePolicy.connect(otherUser).updateTargetSubscriptionRatio(toPercFixedPtAmt("1.25")),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateTargetSubscriptionRatio(toPercFixedPtAmt("0.5")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidTargetSRBounds");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateTargetSubscriptionRatio(toPercFixedPtAmt("2.1")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidTargetSRBounds");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the target sr", async function () {
        expect(await feePolicy.targetSubscriptionRatio()).to.eq(toPercFixedPtAmt("1.33"));
        await feePolicy.connect(deployer).updateTargetSubscriptionRatio(toPercFixedPtAmt("1.25"));
        expect(await feePolicy.targetSubscriptionRatio()).to.eq(toPercFixedPtAmt("1.25"));
      });
    });
  });

  describe("#updateDeviationRatioBounds", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(otherUser).updateDeviationRatioBounds(toPercFixedPtAmt("1"), toPercFixedPtAmt("1")),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateDeviationRatioBounds(toPercFixedPtAmt("1.01"), toPercFixedPtAmt("2")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidDRBounds");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateDeviationRatioBounds(toPercFixedPtAmt("0.5"), toPercFixedPtAmt("0.99")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidDRBounds");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the target sr", async function () {
        expect(await feePolicy.deviationRatioBoundLower()).to.eq(toPercFixedPtAmt("0.75"));
        expect(await feePolicy.deviationRatioBoundUpper()).to.eq(toPercFixedPtAmt("2"));
        await feePolicy.connect(deployer).updateDeviationRatioBounds(toPercFixedPtAmt("0.5"), toPercFixedPtAmt("1.5"));
        expect(await feePolicy.deviationRatioBoundLower()).to.eq(toPercFixedPtAmt("0.5"));
        expect(await feePolicy.deviationRatioBoundUpper()).to.eq(toPercFixedPtAmt("1.5"));
      });
    });
  });

  describe("#updatePerpMintFees", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(otherUser).updatePerpMintFees(toPercFixedPtAmt("0.01"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updatePerpMintFees(toPercFixedPtAmt("1.01")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the mint fees", async function () {
        expect(await feePolicy.computePerpMintFeePerc(toPercFixedPtAmt("1"))).to.eq("0");
        await feePolicy.connect(deployer).updatePerpMintFees(toPercFixedPtAmt("0.01"));
        expect(await feePolicy.computePerpMintFeePerc(toPercFixedPtAmt("1"))).to.eq(toPercFixedPtAmt("0.01"));
      });
    });
  });

  describe("#updatePerpBurnFees", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(otherUser).updatePerpBurnFees(toPercFixedPtAmt("0.01"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updatePerpBurnFees(toPercFixedPtAmt("1.01")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the burn fees", async function () {
        expect(await feePolicy.computePerpBurnFeePerc(toPercFixedPtAmt("1.01"))).to.eq("0");
        await feePolicy.connect(deployer).updatePerpBurnFees(toPercFixedPtAmt("0.01"));
        expect(await feePolicy.computePerpBurnFeePerc(toPercFixedPtAmt("1.01"))).to.eq(toPercFixedPtAmt("0.01"));
      });
    });
  });

  describe("#updatePerpRolloverFees", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(otherUser).updatePerpRolloverFees({
            lower: toPercFixedPtAmt("-0.01"),
            upper: toPercFixedPtAmt("0.01"),
            growth: toPercFixedPtAmt("3"),
          }),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updatePerpRolloverFees({
            lower: toPercFixedPtAmt("-0.011"),
            upper: toPercFixedPtAmt("0.01"),
            growth: toPercFixedPtAmt("3"),
          }),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidSigmoidAsymptotes");
      });
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updatePerpRolloverFees({
            lower: toPercFixedPtAmt("-0.01"),
            upper: toPercFixedPtAmt("0.011"),
            growth: toPercFixedPtAmt("3"),
          }),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidSigmoidAsymptotes");
      });

      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updatePerpRolloverFees({
            lower: toPercFixedPtAmt("0.02"),
            upper: toPercFixedPtAmt("0.01"),
            growth: toPercFixedPtAmt("3"),
          }),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidSigmoidAsymptotes");
      });
    });

    describe("when triggered by owner", function () {
      it("should update parameters", async function () {
        expect(await feePolicy.computePerpRolloverFeePerc(toPercFixedPtAmt("1"))).to.eq(0);
        expect(await feePolicy.computePerpRolloverFeePerc(toPercFixedPtAmt("10"))).to.eq(
          toPercFixedPtAmt("0.00769230"),
        );
        expect(await feePolicy.computePerpRolloverFeePerc("0")).to.eq(toPercFixedPtAmt("-0.00245837"));

        await feePolicy.connect(deployer).updatePerpRolloverFees({
          lower: toPercFixedPtAmt("-0.009"),
          upper: toPercFixedPtAmt("0.009"),
          growth: toPercFixedPtAmt("3"),
        });

        expect(await feePolicy.computePerpRolloverFeePerc(toPercFixedPtAmt("1"))).to.eq(0);
        expect(await feePolicy.computePerpRolloverFeePerc(toPercFixedPtAmt("10"))).to.eq(toPercFixedPtAmt("0.009"));
        expect(await feePolicy.computePerpRolloverFeePerc("0")).to.eq(toPercFixedPtAmt("-0.007"));
      });
    });
  });

  describe("#updateVaultMintFees", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(otherUser).updateVaultMintFees(toPercFixedPtAmt("0.01"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateVaultMintFees(toPercFixedPtAmt("1.01")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
      });
    });

    describe("when triggered by owner", function () {
      beforeEach(async function () {});
      it("should update the vault mint fees", async function () {
        expect(await feePolicy.computeVaultMintFeePerc(toPercFixedPtAmt("1.01"))).to.eq("0");
        await feePolicy.connect(deployer).updateVaultMintFees(toPercFixedPtAmt("0.025"));
        expect(await feePolicy.computeVaultMintFeePerc(toPercFixedPtAmt("1.01"))).to.eq(toPercFixedPtAmt("0.025"));
      });
    });
  });

  describe("#updateVaultBurnFees", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(otherUser).updateVaultBurnFees(toPercFixedPtAmt("0.01"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateVaultBurnFees(toPercFixedPtAmt("1.01")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the vault burn fees", async function () {
        expect(await feePolicy.computeVaultBurnFeePerc(toPercFixedPtAmt("0"))).to.eq("0");
        await feePolicy.connect(deployer).updateVaultBurnFees(toPercFixedPtAmt("0.025"));
        expect(await feePolicy.computeVaultBurnFeePerc(toPercFixedPtAmt("0"))).to.eq(toPercFixedPtAmt("0.025"));
      });
    });
  });

  describe("#updateVaultDeploymentFees", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feePolicy.connect(otherUser).updateVaultDeploymentFees(toFixedPtAmt("25"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when triggered by owner", function () {
      it("should update the vault deployment fee", async function () {
        expect(await feePolicy.computeVaultDeploymentFee()).to.eq("0");
        await feePolicy.connect(deployer).updateVaultDeploymentFees(toFixedPtAmt("25"));
        expect(await feePolicy.computeVaultDeploymentFee()).to.eq(toFixedPtAmt("25"));
      });
    });
  });

  describe("#updateVaultUnderlyingToPerpSwapFeePerc", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(otherUser).updateVaultUnderlyingToPerpSwapFeePerc(toPercFixedPtAmt("0.1")),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateVaultUnderlyingToPerpSwapFeePerc(toPercFixedPtAmt("1.01")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the vault burn fees", async function () {
        const _f = await feePolicy.computeUnderlyingToPerpSwapFeePercs(toPercFixedPtAmt("1.01"));
        expect(_f[0]).to.eq("0");
        expect(_f[1]).to.eq(toPercFixedPtAmt("1"));
        await feePolicy.connect(deployer).updateVaultUnderlyingToPerpSwapFeePerc(toPercFixedPtAmt("0.1"));
        const f = await feePolicy.computeUnderlyingToPerpSwapFeePercs(toPercFixedPtAmt("1.01"));
        expect(f[0]).to.eq("0");
        expect(f[1]).to.eq(toPercFixedPtAmt("0.1"));
      });
    });
  });

  describe("#updateVaultPerpToUnderlyingSwapFeePerc", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(otherUser).updateVaultPerpToUnderlyingSwapFeePerc(toPercFixedPtAmt("0.1")),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          feePolicy.connect(deployer).updateVaultPerpToUnderlyingSwapFeePerc(toPercFixedPtAmt("1.01")),
        ).to.be.revertedWithCustomError(feePolicy, "InvalidPerc");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the vault burn fees", async function () {
        const _f = await feePolicy.computePerpToUnderlyingSwapFeePercs(toPercFixedPtAmt("1"));
        expect(_f[0]).to.eq("0");
        expect(_f[1]).to.eq(toPercFixedPtAmt("1"));
        await feePolicy.connect(deployer).updateVaultPerpToUnderlyingSwapFeePerc(toPercFixedPtAmt("0.1"));
        const f = await feePolicy.computePerpToUnderlyingSwapFeePercs(toPercFixedPtAmt("1"));
        expect(f[0]).to.eq("0");
        expect(f[1]).to.eq(toPercFixedPtAmt("0.1"));
      });
    });
  });

  describe("fee logic", function () {
    beforeEach(async function () {
      await feePolicy.updatePerpMintFees(toPercFixedPtAmt("0.025"));
      await feePolicy.updatePerpBurnFees(toPercFixedPtAmt("0.035"));
      await feePolicy.updatePerpRolloverFees({
        lower: toPercFixedPtAmt("-0.00253"),
        upper: toPercFixedPtAmt("0.00769"),
        growth: toPercFixedPtAmt("5"),
      });
      await feePolicy.updateVaultUnderlyingToPerpSwapFeePerc(toPercFixedPtAmt("0.1"));
      await feePolicy.updateVaultPerpToUnderlyingSwapFeePerc(toPercFixedPtAmt("0.15"));
    });

    describe("when dr = 1", function () {
      it("should charge perp mint fees", async function () {
        expect(await feePolicy.computePerpMintFeePerc(toPercFixedPtAmt("1"))).to.eq(toPercFixedPtAmt("0.025"));
      });
      it("should charge no perp burn fees", async function () {
        expect(await feePolicy.computePerpBurnFeePerc(toPercFixedPtAmt("1"))).to.eq("0");
      });
      it("should charge no perp rollover fees", async function () {
        expect(await feePolicy.computePerpRolloverFeePerc(toPercFixedPtAmt("1"))).to.eq("0");
      });
      it("should charge perp mint fee and a swap fee", async function () {
        const f = await feePolicy.computeUnderlyingToPerpSwapFeePercs(toPercFixedPtAmt("1"));
        expect(f[0]).to.eq(toPercFixedPtAmt("0.025"));
        expect(f[1]).to.eq(toPercFixedPtAmt("0.1"));
      });
      it("should charge no perp burn fees and a swap fee", async function () {
        const f = await feePolicy.computePerpToUnderlyingSwapFeePercs(toPercFixedPtAmt("1"));
        expect(f[0]).to.eq("0");
        expect(f[1]).to.eq(toPercFixedPtAmt("0.15"));
      });
    });

    describe("when dr < 1 but higher than the lower bound", function () {
      it("should charge perp mint fees", async function () {
        expect(await feePolicy.computePerpMintFeePerc(toPercFixedPtAmt("0.99"))).to.eq(toPercFixedPtAmt("0.025"));
      });
      it("should charge no perp burn fees", async function () {
        expect(await feePolicy.computePerpBurnFeePerc(toPercFixedPtAmt("0.99"))).to.eq("0");
      });
      it("should charge -ve perp rollover fees, debasement", async function () {
        expect(await feePolicy.computePerpRolloverFeePerc(toPercFixedPtAmt("0.99"))).to.eq(
          toPercFixedPtAmt("-0.00004101"),
        );
      });
      it("should charge perp mint fee and a swap fee", async function () {
        const f = await feePolicy.computeUnderlyingToPerpSwapFeePercs(toPercFixedPtAmt("0.99"));
        expect(f[0]).to.eq(toPercFixedPtAmt("0.025"));
        expect(f[1]).to.eq(toPercFixedPtAmt("0.1"));
      });
      it("should charge no perp burn fees and a swap fee", async function () {
        const f = await feePolicy.computePerpToUnderlyingSwapFeePercs(toPercFixedPtAmt("0.99"));
        expect(f[0]).to.eq("0");
        expect(f[1]).to.eq(toPercFixedPtAmt("0.15"));
      });
    });

    describe("when dr < lower than lower bound", function () {
      it("should charge perp mint fees", async function () {
        expect(await feePolicy.computePerpMintFeePerc(toPercFixedPtAmt("0.7"))).to.eq(toPercFixedPtAmt("0.025"));
      });
      it("should charge no perp burn fees", async function () {
        expect(await feePolicy.computePerpBurnFeePerc(toPercFixedPtAmt("0.7"))).to.eq("0");
      });
      it("should charge -ve perp rollover fees, debasement", async function () {
        expect(await feePolicy.computePerpRolloverFeePerc(toPercFixedPtAmt("0.7"))).to.eq(
          toPercFixedPtAmt("-0.00146510"),
        );
      });
      it("should charge mint fee and 100% swap fee", async function () {
        const f = await feePolicy.computeUnderlyingToPerpSwapFeePercs(toPercFixedPtAmt("0.7"));
        expect(f[0]).to.eq(toPercFixedPtAmt("0.025"));
        expect(f[1]).to.eq(toPercFixedPtAmt("1"));
      });
      it("should charge no perp burn fees and a swap fee", async function () {
        const f = await feePolicy.computePerpToUnderlyingSwapFeePercs(toPercFixedPtAmt("0.7"));
        expect(f[0]).to.eq("0");
        expect(f[1]).to.eq(toPercFixedPtAmt("0.15"));
      });
    });

    describe("when dr > 1 but lower than higher bound", function () {
      it("should charge NOT perp mint fees", async function () {
        expect(await feePolicy.computePerpMintFeePerc(toPercFixedPtAmt("1.5"))).to.eq("0");
      });
      it("should charge perp burn fees", async function () {
        expect(await feePolicy.computePerpBurnFeePerc(toPercFixedPtAmt("1.5"))).to.eq(toPercFixedPtAmt("0.035"));
      });
      it("should charge +ve perp rollover fees, enrichment", async function () {
        expect(await feePolicy.computePerpRolloverFeePerc(toPercFixedPtAmt("1.5"))).to.eq(
          toPercFixedPtAmt("0.00411794"),
        );
      });
      it("should charge no perp mint fees and a swap fee", async function () {
        const f = await feePolicy.computeUnderlyingToPerpSwapFeePercs(toPercFixedPtAmt("1.5"));
        expect(f[0]).to.eq("0");
        expect(f[1]).to.eq(toPercFixedPtAmt("0.1"));
      });
      it("should charge perp burn fees and a swap fee", async function () {
        const f = await feePolicy.computePerpToUnderlyingSwapFeePercs(toPercFixedPtAmt("1.5"));
        expect(f[0]).to.eq(toPercFixedPtAmt("0.035"));
        expect(f[1]).to.eq(toPercFixedPtAmt("0.15"));
      });
    });

    describe("when dr > higher than higher bound", function () {
      it("should charge NOT perp mint fees", async function () {
        expect(await feePolicy.computePerpMintFeePerc(toPercFixedPtAmt("2.01"))).to.eq("0");
      });
      it("should charge perp burn fees", async function () {
        expect(await feePolicy.computePerpBurnFeePerc(toPercFixedPtAmt("2.01"))).to.eq(toPercFixedPtAmt("0.035"));
      });
      it("should charge +ve perp rollover fees, enrichment", async function () {
        expect(await feePolicy.computePerpRolloverFeePerc(toPercFixedPtAmt("2.01"))).to.eq(
          toPercFixedPtAmt("0.00682084"),
        );
      });
      it("should charge no perp mint fees and a swap fee", async function () {
        const f = await feePolicy.computeUnderlyingToPerpSwapFeePercs(toPercFixedPtAmt("2.01"));
        expect(f[0]).to.eq("0");
        expect(f[1]).to.eq(toPercFixedPtAmt("0.1"));
      });
      it("should charge perp burn fees and 100% swap fee", async function () {
        const f = await feePolicy.computePerpToUnderlyingSwapFeePercs(toPercFixedPtAmt("2.01"));
        expect(f[0]).to.eq(toPercFixedPtAmt("0.035"));
        expect(f[1]).to.eq(toPercFixedPtAmt("1"));
      });
    });
  });

  describe("#computeDeviationRatio", async function () {
    beforeEach(async function () {
      await feePolicy.updateTargetSubscriptionRatio(toPercFixedPtAmt("1.25"));
    });

    describe("when deviation = 1.0", function () {
      it("should return 1", async function () {
        const r = await feePolicy["computeDeviationRatio((uint256,uint256,uint256))"]({
          perpTVL: toFixedPtAmt("100"),
          vaultTVL: toFixedPtAmt("500"),
          seniorTR: 200,
        });
        expect(r).to.eq(toPercFixedPtAmt("1"));
      });
    });

    describe("when deviation > 1.0", function () {
      it("should compute dr", async function () {
        const r = await feePolicy["computeDeviationRatio((uint256,uint256,uint256))"]({
          perpTVL: toFixedPtAmt("100"),
          vaultTVL: toFixedPtAmt("1000"),
          seniorTR: 200,
        });
        expect(r).to.eq(toPercFixedPtAmt("2"));
      });
    });

    describe("when deviation < 1.0", function () {
      it("should compute dr", async function () {
        const r = await feePolicy["computeDeviationRatio((uint256,uint256,uint256))"]({
          perpTVL: toFixedPtAmt("100"),
          vaultTVL: toFixedPtAmt("250"),
          seniorTR: 200,
        });
        expect(r).to.eq(toPercFixedPtAmt("0.5"));
      });
    });
  });
});
