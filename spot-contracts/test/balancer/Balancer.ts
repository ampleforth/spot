import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";
import { toPercFixedPtAmt, toFixedPtAmt, setupCollateralToken, DMock } from "../helpers";

let collateralToken: Contract, balancer: Contract, deployer: Signer, otherUser: Signer;
const toPerc = toPercFixedPtAmt;
const toAmt = toFixedPtAmt;

describe("Balancer", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));

    const perp = new DMock(await ethers.getContractFactory("PerpetualTranche"));
    await perp.deploy();

    const vault = new DMock(await ethers.getContractFactory("RolloverVault"));
    await vault.deploy();

    await perp.mockMethod("underlying()", [collateralToken.target]);
    await perp.mockMethod("vault()", [vault.target]);
    await perp.mockMethod("depositTrancheRatio()", [250]);

    balancer = new DMock(await ethers.getContractFactory("Balancer"));
    await balancer.deploy();
    await balancer.mockMethod("decimals()", [8]);

    const Balancer = await ethers.getContractFactory("Balancer");
    balancer = await upgrades.deployProxy(Balancer.connect(deployer), [perp.target], {
      initializer: "init(address)",
    });
  });

  describe("#init", function () {
    it("should return the initial parameters", async function () {
      expect(await balancer.targetSubscriptionRatio()).to.eq(toPerc("1.33333333"));
      const swapBound = await balancer.swapDRBound();
      expect(swapBound.lower).to.eq(toPerc("0.75"));
      expect(swapBound.upper).to.eq(toPerc("1.5"));
      const rebalanceBound = await balancer.rebalanceDRBound();
      expect(rebalanceBound.lower).to.eq(toPerc("1.5"));
      expect(rebalanceBound.upper).to.eq(toPerc("1"));
    });
    it("should set initial fees", async function () {
      const fees = await balancer.fees();
      expect(fees.perpMintFeePerc).to.eq(0n);
      expect(fees.perpBurnFeePerc).to.eq(0n);
      expect(fees.vaultMintFeePerc).to.eq(0n);
      expect(fees.vaultBurnFeePerc).to.eq(0n);
      expect(fees.rolloverFee.lower).to.eq(toPerc("-0.01"));
      expect(fees.rolloverFee.upper).to.eq(toPerc("0.02"));
      expect(fees.rolloverFee.growth).to.eq(toPerc("3"));
      expect(fees.underlyingToPerpSwapFeePerc).to.eq(toPerc("1"));
      expect(fees.perpToUnderlyingSwapFeePerc).to.eq(toPerc("1"));
      expect(fees.protocolSwapSharePerc).to.eq(0n);
    });
    it("should return owner", async function () {
      expect(await balancer.owner()).to.eq(await deployer.getAddress());
    });
    it("should return decimals", async function () {
      expect(await balancer.decimals()).to.eq(8);
    });
  });

  describe("#updateTargetSubscriptionRatio", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(balancer.connect(otherUser).updateTargetSubscriptionRatio(toPerc("1.25"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          balancer.connect(deployer).updateTargetSubscriptionRatio(toPerc("0.5")),
        ).to.be.revertedWithCustomError(balancer, "InvalidTargetSRBounds");
      });
    });

    describe("when parameters are invalid", function () {
      it("should revert", async function () {
        await expect(
          balancer.connect(deployer).updateTargetSubscriptionRatio(toPerc("2.1")),
        ).to.be.revertedWithCustomError(balancer, "InvalidTargetSRBounds");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the target sr", async function () {
        expect(await balancer.targetSubscriptionRatio()).to.eq(toPerc("1.33333333"));
        await balancer.connect(deployer).updateTargetSubscriptionRatio(toPerc("1.25"));
        expect(await balancer.targetSubscriptionRatio()).to.eq(toPerc("1.25"));
      });
    });
  });

  describe("#updateSwapDRLimits", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(balancer.connect(otherUser).updateSwapDRLimits([toPerc("1"), toPerc("1")])).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when triggered by owner", function () {
      it("should update swap dr limits", async function () {
        const _swapBound = await balancer.swapDRBound();
        expect(_swapBound.lower).to.eq(toPerc("0.75"));
        expect(_swapBound.upper).to.eq(toPerc("1.5"));
        await balancer.connect(deployer).updateSwapDRLimits([toPerc("0.5"), toPerc("1.33")]);
        const swapBound = await balancer.swapDRBound();
        expect(swapBound.lower).to.eq(toPerc("0.5"));
        expect(swapBound.upper).to.eq(toPerc("1.33"));
      });
    });
  });

  describe("#updateRebalanceDRLimits", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          balancer.connect(otherUser).updateRebalanceDRLimits([toPerc("1"), toPerc("1")]),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when triggered by owner", function () {
      it("should update rebalance dr limits", async function () {
        const _rebalBound = await balancer.rebalanceDRBound();
        expect(_rebalBound.lower).to.eq(toPerc("1.5"));
        expect(_rebalBound.upper).to.eq(toPerc("1"));
        await balancer.connect(deployer).updateRebalanceDRLimits([toPerc("1.25"), toPerc("0.9")]);
        const rebalBound = await balancer.rebalanceDRBound();
        expect(rebalBound.lower).to.eq(toPerc("1.25"));
        expect(rebalBound.upper).to.eq(toPerc("0.9"));
      });
    });
  });

  describe("#updateFees", function () {
    const flattenFees = f => [
      f.perpMintFeePerc,
      f.perpBurnFeePerc,
      f.vaultMintFeePerc,
      f.vaultBurnFeePerc,
      [f.rolloverFee.lower, f.rolloverFee.upper, f.rolloverFee.growth],
      f.underlyingToPerpSwapFeePerc,
      f.perpToUnderlyingSwapFeePerc,
      f.protocolSwapSharePerc,
    ];

    let fees: any;
    beforeEach(async function () {
      fees = {
        perpMintFeePerc: toPerc("0.03"),
        perpBurnFeePerc: toPerc("0.03"),
        vaultMintFeePerc: toPerc("0.01"),
        vaultBurnFeePerc: toPerc("0.05"),
        rolloverFee: {
          lower: toPerc("-0.009"),
          upper: toPerc("0.009"),
          growth: toPerc("3"),
        },
        underlyingToPerpSwapFeePerc: toPerc("0.05"),
        perpToUnderlyingSwapFeePerc: toPerc("0.1"),
        protocolSwapSharePerc: toPerc("0.05"),
      };
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(balancer.connect(otherUser).updateFees(fees)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when parameters are invalid", function () {
      beforeEach(async function () {
        fees.perpMintFeePerc = toFixedPtAmt("1.01");
      });
      it("should revert", async function () {
        await expect(balancer.connect(deployer).updateFees(fees)).to.be.revertedWithCustomError(
          balancer,
          "InvalidPerc",
        );
      });
    });

    describe("when parameters are invalid", function () {
      beforeEach(async function () {
        fees.perpBurnFeePerc = toFixedPtAmt("1.01");
      });
      it("should revert", async function () {
        await expect(balancer.connect(deployer).updateFees(fees)).to.be.revertedWithCustomError(
          balancer,
          "InvalidPerc",
        );
      });
    });

    describe("when parameters are invalid", function () {
      beforeEach(async function () {
        fees.vaultMintFeePerc = toFixedPtAmt("1.01");
      });
      it("should revert", async function () {
        await expect(balancer.connect(deployer).updateFees(fees)).to.be.revertedWithCustomError(
          balancer,
          "InvalidPerc",
        );
      });
    });

    describe("when parameters are invalid", function () {
      beforeEach(async function () {
        fees.vaultBurnFeePerc = toFixedPtAmt("1.01");
      });
      it("should revert", async function () {
        await expect(balancer.connect(deployer).updateFees(fees)).to.be.revertedWithCustomError(
          balancer,
          "InvalidPerc",
        );
      });
    });

    describe("when parameters are invalid", function () {
      beforeEach(async function () {
        fees.underlyingToPerpSwapFeePerc = toFixedPtAmt("1.01");
      });
      it("should revert", async function () {
        await expect(balancer.connect(deployer).updateFees(fees)).to.be.revertedWithCustomError(
          balancer,
          "InvalidPerc",
        );
      });
    });

    describe("when parameters are invalid", function () {
      beforeEach(async function () {
        fees.perpToUnderlyingSwapFeePerc = toFixedPtAmt("1.01");
      });
      it("should revert", async function () {
        await expect(balancer.connect(deployer).updateFees(fees)).to.be.revertedWithCustomError(
          balancer,
          "InvalidPerc",
        );
      });
    });

    describe("when parameters are invalid", function () {
      beforeEach(async function () {
        fees.protocolSwapSharePerc = toFixedPtAmt("1.01");
      });
      it("should revert", async function () {
        await expect(balancer.connect(deployer).updateFees(fees)).to.be.revertedWithCustomError(
          balancer,
          "InvalidPerc",
        );
      });
    });

    describe("when parameters are invalid", function () {
      beforeEach(async function () {
        fees.rolloverFee.lower = toFixedPtAmt("-0.02");
      });
      it("should revert", async function () {
        await expect(balancer.connect(deployer).updateFees(fees)).to.be.revertedWithCustomError(
          balancer,
          "InvalidSigmoidAsymptotes",
        );
      });
    });

    describe("when parameters are invalid", function () {
      beforeEach(async function () {
        fees.rolloverFee.upper = toFixedPtAmt("0.02");
      });
      it("should revert", async function () {
        await expect(balancer.connect(deployer).updateFees(fees)).to.be.revertedWithCustomError(
          balancer,
          "InvalidSigmoidAsymptotes",
        );
      });
    });

    describe("when parameters are invalid", function () {
      beforeEach(async function () {
        fees.rolloverFee.lower = toFixedPtAmt("0.01");
        fees.rolloverFee.upper = toFixedPtAmt("0.009");
      });
      it("should revert", async function () {
        await expect(balancer.connect(deployer).updateFees(fees)).to.be.revertedWithCustomError(
          balancer,
          "InvalidSigmoidAsymptotes",
        );
      });
    });

    describe("when triggered by owner", function () {
      it("should update the fees", async function () {
        expect(await balancer.fees()).to.not.deep.eq(flattenFees(fees));
        await expect(balancer.connect(deployer).updateFees(fees)).to.not.be.reverted;
        expect(await balancer.fees()).to.deep.eq(flattenFees(fees));
      });
    });
  });

  describe("fee logic", function () {
    let fees: any;

    beforeEach(async function () {
      fees = {
        perpMintFeePerc: toPerc("0.03"),
        perpBurnFeePerc: toPerc("0.03"),
        vaultMintFeePerc: toPerc("0.01"),
        vaultBurnFeePerc: toPerc("0.05"),
        rolloverFee: {
          lower: toPerc("-0.00253"),
          upper: toPerc("0.00769"),
          growth: toPerc("5"),
        },
        underlyingToPerpSwapFeePerc: toPerc("0.05"),
        perpToUnderlyingSwapFeePerc: toPerc("0.1"),
        protocolSwapSharePerc: 0n,
      };
      await balancer.updateFees(fees);
      await balancer.updateSwapDRLimits([toPerc("0.75"), toPerc("1.5")]);
    });

    describe("static mint/burn fees", async function () {
      it("should return the fee percentage", async function () {
        expect(await balancer.computePerpMintFeePerc()).to.eq(toPerc("0.03"));
        expect(await balancer.computePerpBurnFeePerc()).to.eq(toPerc("0.03"));
        expect(await balancer.computeVaultMintFeePerc()).to.eq(toPerc("0.01"));
        expect(await balancer.computeVaultBurnFeePerc()).to.eq(toPerc("0.05"));
      });
    });

    describe("rollover fee", function () {
      it("should compute fees as expected", async function () {
        expect(await balancer.computePerpRolloverFeePerc(toPerc("0.01"))).to.eq(toPerc("-0.00242144"));
        expect(await balancer.computePerpRolloverFeePerc(toPerc("0.25"))).to.eq(toPerc("-0.00228606"));
        expect(await balancer.computePerpRolloverFeePerc(toPerc("0.5"))).to.eq(toPerc("-0.00196829"));
        expect(await balancer.computePerpRolloverFeePerc(toPerc("0.75"))).to.eq(toPerc("-0.00128809"));
        expect(await balancer.computePerpRolloverFeePerc(toPerc("0.9"))).to.eq(toPerc("-0.00060117"));
        expect(await balancer.computePerpRolloverFeePerc(toPerc("0.99"))).to.eq(toPerc("-0.00004101"));
        expect(await balancer.computePerpRolloverFeePerc(toPerc("1"))).to.eq("0");
        expect(await balancer.computePerpRolloverFeePerc(toPerc("1.01"))).to.eq(toPerc("0.00004146"));
        expect(await balancer.computePerpRolloverFeePerc(toPerc("1.05"))).to.eq(toPerc("0.00034407"));
        expect(await balancer.computePerpRolloverFeePerc(toPerc("1.1"))).to.eq(toPerc("0.00071519"));
        expect(await balancer.computePerpRolloverFeePerc(toPerc("1.25"))).to.eq(toPerc("0.00195646"));
        expect(await balancer.computePerpRolloverFeePerc(toPerc("1.5"))).to.eq(toPerc("0.00411794"));
        expect(await balancer.computePerpRolloverFeePerc(toPerc("1.75"))).to.eq(toPerc("0.00580663"));
        expect(await balancer.computePerpRolloverFeePerc(toPerc("2"))).to.eq(toPerc("0.00680345"));
        expect(await balancer.computePerpRolloverFeePerc(toPerc("5"))).to.eq(toPerc("0.00768997"));
      });
    });

    describe("computeUnderlyingToPerpSwapFeePerc", function () {
      describe("when protocol fee is zero", function () {
        it("should compute swap fees", async function () {
          const s = await balancer.computeUnderlyingToPerpSwapFeePerc();
          expect(s[0]).to.eq(toPerc("0.05"));
          expect(s[1]).to.eq(0n);
        });
      });

      describe("when protocol fee is non zero", function () {
        beforeEach(async function () {
          fees.protocolSwapSharePerc = toPerc("0.1");
          await balancer.updateFees(fees);
        });
        it("should compute swap fees", async function () {
          const s = await balancer.computeUnderlyingToPerpSwapFeePerc();
          expect(s[0]).to.eq(toPerc("0.045"));
          expect(s[1]).to.eq(toPerc("0.005"));
        });
      });
    });

    describe("computePerpToUnderlyingSwapFeePerc", function () {
      describe("when protocol fee is zero", function () {
        it("should compute swap fees", async function () {
          const s = await balancer.computePerpToUnderlyingSwapFeePerc();
          expect(s[0]).to.eq(toPerc("0.1"));
          expect(s[1]).to.eq(0n);
        });
      });

      describe("when protocol fee is non zero", function () {
        beforeEach(async function () {
          fees.protocolSwapSharePerc = toPerc("0.1");
          await balancer.updateFees(fees);
        });

        it("should compute swap fees", async function () {
          const s = await balancer.computePerpToUnderlyingSwapFeePerc();
          expect(s[0]).to.eq(toPerc("0.09"));
          expect(s[1]).to.eq(toPerc("0.01"));
        });
      });
    });
  });

  describe("#computeDeviationRatio", async function () {
    beforeEach(async function () {
      await balancer.updateTargetSubscriptionRatio(toPerc("1.25"));
    });

    describe("when deviation = 1.0", function () {
      it("should return 1", async function () {
        const r = await balancer["computeDeviationRatio((uint256,uint256,uint256))"]({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("500"),
          seniorTR: 200,
        });
        expect(r).to.eq(toPerc("1"));
      });
    });

    describe("when deviation > 1.0", function () {
      it("should compute dr", async function () {
        const r = await balancer["computeDeviationRatio((uint256,uint256,uint256))"]({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("1000"),
          seniorTR: 200,
        });
        expect(r).to.eq(toPerc("2"));
      });
    });

    describe("when deviation < 1.0", function () {
      it("should compute dr", async function () {
        const r = await balancer["computeDeviationRatio((uint256,uint256,uint256))"]({
          perpTVL: toAmt("100"),
          vaultTVL: toAmt("250"),
          seniorTR: 200,
        });
        expect(r).to.eq(toPerc("0.5"));
      });
    });
  });
});
