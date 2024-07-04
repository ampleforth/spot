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

    describe("when triggered by owner", function () {
      it("should update the target sr", async function () {
        expect(await balancer.targetSubscriptionRatio()).to.eq(toPerc("1.33333333"));
        await balancer.connect(deployer).updateTargetSubscriptionRatio(toPerc("1.25"));
        expect(await balancer.targetSubscriptionRatio()).to.eq(toPerc("1.25"));
      });
    });
  });

  describe("#addRebalancer", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(balancer.connect(otherUser).addRebalancer(await deployer.getAddress())).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when already whitelisted", function () {
      it("should revert", async function () {
        await balancer.connect(deployer).addRebalancer(await deployer.getAddress());
        await expect(
          balancer.connect(deployer).addRebalancer(await deployer.getAddress()),
        ).to.be.revertedWithCustomError(balancer, "UnacceptableParams");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the whitelist", async function () {
        expect(await balancer.rebalancerCount()).to.eq(0);
        await balancer.connect(deployer).addRebalancer(await deployer.getAddress());
        expect(await balancer.rebalancerCount()).to.eq(1);
        expect(await balancer.rebalancerAt(0)).to.eq(await deployer.getAddress());
      });
    });
  });

  describe("#removeRebalancer", function () {
    beforeEach(async function () {
      await balancer.connect(deployer).addRebalancer(await deployer.getAddress());
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(balancer.connect(otherUser).removeRebalancer(await deployer.getAddress())).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when not already whitelisted", function () {
      it("should revert", async function () {
        await balancer.connect(deployer).removeRebalancer(await deployer.getAddress());
        await expect(
          balancer.connect(deployer).removeRebalancer(await deployer.getAddress()),
        ).to.be.revertedWithCustomError(balancer, "UnacceptableParams");
      });
    });

    describe("when triggered by owner", function () {
      it("should update the whitelist", async function () {
        expect(await balancer.rebalancerCount()).to.eq(1);
        expect(await balancer.rebalancerAt(0)).to.eq(await deployer.getAddress());
        await balancer.connect(deployer).removeRebalancer(await deployer.getAddress());
        expect(await balancer.rebalancerCount()).to.eq(0);
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
    });

    describe("static mint/burn fees", async function () {
      it("should return the fee percentage", async function () {
        const fees = await balancer.fees();
        expect(fees[0]).to.eq(toPerc("0.03"));
        expect(fees[1]).to.eq(toPerc("0.03"));
        expect(fees[2]).to.eq(toPerc("0.01"));
        expect(fees[3]).to.eq(toPerc("0.05"));
      });
    });

    describe("rollover fee", function () {
      it("should compute fees as expected", async function () {
        expect(await balancer.computeRolloverFeePerc(toPerc("0.01"))).to.eq(toPerc("-0.00242144"));
        expect(await balancer.computeRolloverFeePerc(toPerc("0.25"))).to.eq(toPerc("-0.00228606"));
        expect(await balancer.computeRolloverFeePerc(toPerc("0.5"))).to.eq(toPerc("-0.00196829"));
        expect(await balancer.computeRolloverFeePerc(toPerc("0.75"))).to.eq(toPerc("-0.00128809"));
        expect(await balancer.computeRolloverFeePerc(toPerc("0.9"))).to.eq(toPerc("-0.00060117"));
        expect(await balancer.computeRolloverFeePerc(toPerc("0.99"))).to.eq(toPerc("-0.00004101"));
        expect(await balancer.computeRolloverFeePerc(toPerc("1"))).to.eq("0");
        expect(await balancer.computeRolloverFeePerc(toPerc("1.01"))).to.eq(toPerc("0.00004146"));
        expect(await balancer.computeRolloverFeePerc(toPerc("1.05"))).to.eq(toPerc("0.00034407"));
        expect(await balancer.computeRolloverFeePerc(toPerc("1.1"))).to.eq(toPerc("0.00071519"));
        expect(await balancer.computeRolloverFeePerc(toPerc("1.25"))).to.eq(toPerc("0.00195646"));
        expect(await balancer.computeRolloverFeePerc(toPerc("1.5"))).to.eq(toPerc("0.00411794"));
        expect(await balancer.computeRolloverFeePerc(toPerc("1.75"))).to.eq(toPerc("0.00580663"));
        expect(await balancer.computeRolloverFeePerc(toPerc("2"))).to.eq(toPerc("0.00680345"));
        expect(await balancer.computeRolloverFeePerc(toPerc("5"))).to.eq(toPerc("0.00768997"));
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
