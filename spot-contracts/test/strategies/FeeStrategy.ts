import { expect, use } from "chai";
import { ethers } from "hardhat";
import { Contract, Transaction, Signer } from "ethers";
import { smock } from "@defi-wonderland/smock";

import {
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  getTranches,
  toFixedPtAmt,
  toDiscountFixedPtAmt,
  toPercFixedPtAmt,
} from "../helpers";
use(smock.matchers);

let feeStrategy: Contract,
  deployer: Signer,
  otherUser: Signer,
  perp: Contract,
  bondFactory: Contract,
  collateralToken,
  vault: Contract,
  currentBond: Contract;

describe("FeeStrategy", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    bondFactory = await setupBondFactory();
    ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await smock.fake(PerpetualTranche);

    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    vault = await smock.fake(RolloverVault);

    const factory = await ethers.getContractFactory("FeeStrategy");
    feeStrategy = await factory.deploy(perp.address, vault.address);
    await feeStrategy.init();
  });

  async function mockDeviation(vaultTVL, perpTVL, target) {
    await feeStrategy.updateDeviationTarget(toPercFixedPtAmt(target));
    await vault.getTVL.returns(toFixedPtAmt(vaultTVL));
    currentBond = await createBondWithFactory(bondFactory, collateralToken, [250, 750], 28 * 86400);
    const tranches = await getTranches(currentBond);
    await perp.getDepositBond.returns(currentBond.address);
    await perp.getTVL.returns(toFixedPtAmt(perpTVL));
  }

  describe("#init", function () {
    it("should return the references", async function () {
      expect(await feeStrategy.perp()).to.eq(perp.address);
      expect(await feeStrategy.vault()).to.eq(vault.address);
    });
    it("should return the initial paramters", async function () {
      expect(await feeStrategy.maxMintFeePerc()).to.eq(toPercFixedPtAmt("0.025"));
      expect(await feeStrategy.maxBurnFeePerc()).to.eq(toPercFixedPtAmt("0.025"));
      const r = await feeStrategy.rolloverFeeAPR();
      expect(r[0]).to.eq(toPercFixedPtAmt("-0.02"));
      expect(r[1]).to.eq(toPercFixedPtAmt("0.05"));
      expect(r[2]).to.eq(toPercFixedPtAmt("5"));
      expect(await feeStrategy.targetDeviation()).to.eq(toPercFixedPtAmt("1"));
    });
    it("should return owner", async function () {
      expect(await feeStrategy.owner()).to.eq(await deployer.getAddress());
    });
    it("should return decimals", async function () {
      expect(await feeStrategy.decimals()).to.eq(8);
    });
  });

  describe("#computeNormalizedDeviation", function () {
    describe("when deviation = 1.0", function () {
      it("should return 1", async function () {
        await mockDeviation("400", "100", "1");
        expect(await feeStrategy.callStatic.computeNormalizedDeviation(currentBond.address)).to.eq(
          toPercFixedPtAmt("1"),
        );
      });
    });

    describe("when deviation < 1.0", function () {
      it("should return 1", async function () {
        await mockDeviation("300", "100", "1");
        expect(await feeStrategy.callStatic.computeNormalizedDeviation(currentBond.address)).to.eq(
          toPercFixedPtAmt("0.75"),
        );
      });
    });

    describe("when deviation > 1.0", function () {
      it("should return 1", async function () {
        await mockDeviation("600", "100", "1");
        expect(await feeStrategy.callStatic.computeNormalizedDeviation(currentBond.address)).to.eq(
          toPercFixedPtAmt("1.5"),
        );
      });
    });
  });

  describe("#computeMintFeePerc", function () {
    describe("when deviation = 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("400", "100", "1");
        expect(await feeStrategy.callStatic.computeMintFeePerc()).to.eq(toPercFixedPtAmt("0.025"));
      });
    });

    describe("when deviation > 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("600", "100", "1");
        expect(await feeStrategy.callStatic.computeMintFeePerc()).to.eq(toPercFixedPtAmt("0"));
      });
    });

    describe("when deviation < 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("200", "100", "1");
        expect(await feeStrategy.callStatic.computeMintFeePerc()).to.eq(toPercFixedPtAmt("0.025"));
      });
    });
  });

  describe("#computeBurnFeePerc", function () {
    describe("when deviation = 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("400", "100", "1");
        expect(await feeStrategy.callStatic.computeBurnFeePerc()).to.eq(toPercFixedPtAmt("0.025"));
      });
    });

    describe("when deviation > 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("600", "100", "1");
        expect(await feeStrategy.callStatic.computeBurnFeePerc()).to.eq(toPercFixedPtAmt("0.025"));
      });
    });

    describe("when deviation < 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("200", "100", "1");
        expect(await feeStrategy.callStatic.computeBurnFeePerc()).to.eq(toPercFixedPtAmt("0"));
      });
    });
  });

  describe("#computeRolloverFeePerc", function () {
    describe("when deviation = 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("400", "100", "1");
        expect(await feeStrategy.callStatic.computeRolloverFeePerc()).to.eq(toPercFixedPtAmt("0"));
      });
    });

    describe("when deviation > 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("600", "100", "1");
        expect(await feeStrategy.callStatic.computeRolloverFeePerc()).to.eq(toPercFixedPtAmt("0.00218830"));
      });
    });

    describe("when deviation < 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("200", "100", "1");
        expect(await feeStrategy.callStatic.computeRolloverFeePerc()).to.eq(toPercFixedPtAmt("-0.00117880"));
      });
    });

    describe("when target is set", function () {
      describe("when deviation = 1", function () {
        it("should compute the fee perc", async function () {
          await mockDeviation("440", "100", "1.1");
          expect(await feeStrategy.callStatic.computeRolloverFeePerc()).to.eq(toPercFixedPtAmt("0"));
        });
      });

      describe("when deviation > 1", function () {
        it("should compute the fee perc", async function () {
          await mockDeviation("600", "100", "1.1");
          expect(await feeStrategy.callStatic.computeRolloverFeePerc()).to.eq(toPercFixedPtAmt("0.00160172"));
        });
      });

      describe("when deviation < 1", function () {
        it("should compute the fee perc", async function () {
          await mockDeviation("300", "100", "1.1");
          expect(await feeStrategy.callStatic.computeRolloverFeePerc()).to.eq(toPercFixedPtAmt("-0.00089315"));
        });
      });
    });
  });

  describe("#updateMintFees", function () {
    let tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(otherUser).updateMintFees(toPercFixedPtAmt("0.01"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });
    describe("when params are invalid", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(deployer).updateMintFees(toPercFixedPtAmt("1.01"))).to.be.revertedWith(
          "FeeStrategy: mint fee too high",
        );
      });
    });

    describe("when trigged by owner", function () {
      beforeEach(async function () {
        tx = feeStrategy.connect(deployer).updateMintFees(toPercFixedPtAmt("0.01"));
        await tx;
      });
      it("should update the mint fees", async function () {
        expect(await feeStrategy.maxMintFeePerc()).to.eq(toPercFixedPtAmt("0.01"));
      });
    });
  });

  describe("#updateBurnFees", function () {
    let tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(otherUser).updateBurnFees(toPercFixedPtAmt("0.035"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });
    describe("when params are invalid", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(deployer).updateBurnFees(toPercFixedPtAmt("1.01"))).to.be.revertedWith(
          "FeeStrategy: burn fee too high",
        );
      });
    });

    describe("when trigged by owner", function () {
      beforeEach(async function () {
        tx = feeStrategy.connect(deployer).updateBurnFees(toPercFixedPtAmt("0.035"));
        await tx;
      });
      it("should update the burn fees", async function () {
        expect(await feeStrategy.maxBurnFeePerc()).to.eq(toPercFixedPtAmt("0.035"));
      });
    });
  });

  describe("#updateRolloverFees", function () {
    let tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feeStrategy
            .connect(otherUser)
            .updateRolloverFees([toPercFixedPtAmt("-0.01"), toPercFixedPtAmt("0.01"), toPercFixedPtAmt("3")]),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
    describe("when params are invalid", function () {
      it("should revert", async function () {
        await expect(
          feeStrategy
            .connect(deployer)
            .updateRolloverFees([toPercFixedPtAmt("-0.25"), toPercFixedPtAmt("0.01"), toPercFixedPtAmt("3")]),
        ).to.be.revertedWith("FeeStrategy: fee lower bound too low");
      });
      it("should revert", async function () {
        await expect(
          feeStrategy
            .connect(deployer)
            .updateRolloverFees([toPercFixedPtAmt("-0.01"), toPercFixedPtAmt("0.25"), toPercFixedPtAmt("3")]),
        ).to.be.revertedWith("FeeStrategy: fee upper bound too high");
      });

      it("should revert", async function () {
        await expect(
          feeStrategy
            .connect(deployer)
            .updateRolloverFees([toPercFixedPtAmt("0.2"), toPercFixedPtAmt("0.1"), toPercFixedPtAmt("3")]),
        ).to.be.revertedWith("FeeStrategy: paramters invalid");
      });
    });

    describe("when trigged by owner", function () {
      beforeEach(async function () {
        tx = feeStrategy
          .connect(deployer)
          .updateRolloverFees([toPercFixedPtAmt("-0.01"), toPercFixedPtAmt("0.01"), toPercFixedPtAmt("3")]);
        await tx;
      });
      it("should update paramters", async function () {
        const p = await feeStrategy.rolloverFeeAPR();
        expect(p[0]).to.eq(toPercFixedPtAmt("-0.01"));
        expect(p[1]).to.eq(toPercFixedPtAmt("0.01"));
        expect(p[2]).to.eq(toPercFixedPtAmt("3"));
      });
    });
  });

  describe("#updateDeviationTarget", function () {
    let tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(otherUser).updateDeviationTarget(toPercFixedPtAmt("0.01"))).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });
    describe("when params are invalid", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(deployer).updateDeviationTarget(toPercFixedPtAmt("0"))).to.be.revertedWith(
          "FeeStrategy: target deviation too low",
        );
      });
    });

    describe("when trigged by owner", function () {
      beforeEach(async function () {
        tx = feeStrategy.connect(deployer).updateDeviationTarget(toPercFixedPtAmt("1.01"));
        await tx;
      });
      it("should update the mint fees", async function () {
        expect(await feeStrategy.targetDeviation()).to.eq(toPercFixedPtAmt("1.01"));
      });
    });
  });
});
