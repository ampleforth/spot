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

  async function mockDeviation(vaultTVL, perpTVL, treshold) {
    await feeStrategy.updateDeviationTreshold(toPercFixedPtAmt(treshold));
    await vault.getTVL.returns(toFixedPtAmt(vaultTVL));
    currentBond = await createBondWithFactory(bondFactory, collateralToken, [250, 750], 28 * 86400);
    const tranches = await getTranches(currentBond);
    await perp.getDepositBond.returns(currentBond.address);
    await perp.computeDiscount.whenCalledWith(tranches[0].address).returns(toDiscountFixedPtAmt("1"));
    await perp.computeDiscount.whenCalledWith(tranches[1].address).returns(toDiscountFixedPtAmt("0"));
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
      expect(await feeStrategy.deviationThresholdPerc()).to.eq(toPercFixedPtAmt("0.05"));
    });
    it("should return owner", async function () {
      expect(await feeStrategy.owner()).to.eq(await deployer.getAddress());
    });
    it("should return decimals", async function () {
      expect(await feeStrategy.decimals()).to.eq(8);
    });
  });

  describe("#computeDeviationRatio", function () {
    describe("when deviation is exactly 1.0, when deviation treshold is not set", function () {
      it("should return 1", async function () {
        await mockDeviation("400", "100", "0");
        expect(await feeStrategy.callStatic.computeDeviationRatio(currentBond.address)).to.eq(toPercFixedPtAmt("1"));
      });
    });

    describe("when deviation is 1.0, when deviation treshold is set", function () {
      it("should return 1", async function () {
        await mockDeviation("399", "100", "0.1");
        expect(await feeStrategy.callStatic.computeDeviationRatio(currentBond.address)).to.lt(toPercFixedPtAmt("1"));

        await mockDeviation("400", "100", "0.1");
        expect(await feeStrategy.callStatic.computeDeviationRatio(currentBond.address)).to.eq(toPercFixedPtAmt("1"));

        await mockDeviation("420", "100", "0.1");
        expect(await feeStrategy.callStatic.computeDeviationRatio(currentBond.address)).to.eq(toPercFixedPtAmt("1"));

        await mockDeviation("440", "100", "0.1");
        expect(await feeStrategy.callStatic.computeDeviationRatio(currentBond.address)).to.eq(toPercFixedPtAmt("1"));

        await mockDeviation("441", "100", "0.1");
        expect(await feeStrategy.callStatic.computeDeviationRatio(currentBond.address)).to.gt(toPercFixedPtAmt("1"));
      });
    });

    describe("when deviation is > 1.0, when deviation treshold is not set", function () {
      it("should return 1.5", async function () {
        await mockDeviation("600", "100", "0");
        expect(await feeStrategy.callStatic.computeDeviationRatio(currentBond.address)).to.eq(toPercFixedPtAmt("1.5"));
      });
    });

    describe("when deviation is > 1.0, when deviation treshold is set", function () {
      it("should return 1.45", async function () {
        await mockDeviation("600", "100", "0.05");
        expect(await feeStrategy.callStatic.computeDeviationRatio(currentBond.address)).to.eq(toPercFixedPtAmt("1.45"));
      });
    });

    describe("when deviation is < 1.0", function () {
      it("should return 0.75", async function () {
        await mockDeviation("300", "100", "0");
        expect(await feeStrategy.callStatic.computeDeviationRatio(currentBond.address)).to.eq(toPercFixedPtAmt("0.75"));
      });
    });

    describe("when deviation is < 1.0, when deviation treshold is set", function () {
      it("should return 0.75", async function () {
        await mockDeviation("300", "100", "0.1");
        expect(await feeStrategy.callStatic.computeDeviationRatio(currentBond.address)).to.eq(toPercFixedPtAmt("0.75"));
      });
    });
  });

  describe("#computeMintFeePerc", function () {
    describe("when deviation = 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("400", "100", "0");
        expect(await feeStrategy.callStatic.computeMintFeePerc()).to.eq(toPercFixedPtAmt("0.025"));
      });
    });

    describe("when deviation > 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("600", "100", "0");
        expect(await feeStrategy.callStatic.computeMintFeePerc()).to.eq(toPercFixedPtAmt("0"));
      });
    });

    describe("when deviation < 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("200", "100", "0");
        expect(await feeStrategy.callStatic.computeMintFeePerc()).to.eq(toPercFixedPtAmt("0.025"));
      });
    });
  });

  describe("#computeBurnFeePerc", function () {
    describe("when deviation = 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("400", "100", "0");
        expect(await feeStrategy.callStatic.computeBurnFeePerc()).to.eq(toPercFixedPtAmt("0.025"));
      });
    });

    describe("when deviation > 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("600", "100", "0");
        expect(await feeStrategy.callStatic.computeBurnFeePerc()).to.eq(toPercFixedPtAmt("0.025"));
      });
    });

    describe("when deviation < 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("200", "100", "0");
        expect(await feeStrategy.callStatic.computeBurnFeePerc()).to.eq(toPercFixedPtAmt("0"));
      });
    });
  });

  describe("#computeRolloverFeePerc", function () {
    describe("when deviation = 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("400", "100", "0");
        expect(await feeStrategy.callStatic.computeRolloverFeePerc()).to.eq(toPercFixedPtAmt("0"));
      });
    });

    describe("when deviation > 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("600", "100", "0");
        expect(await feeStrategy.callStatic.computeRolloverFeePerc()).to.eq(toPercFixedPtAmt("0.00218830"));
      });
    });

    describe("when deviation > 1 and treshold set", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("600", "100", "0.1");
        expect(await feeStrategy.callStatic.computeRolloverFeePerc()).to.eq(toPercFixedPtAmt("0.00176907"));
      });
    });

    describe("when deviation < 1", function () {
      it("should compute the fee perc", async function () {
        await mockDeviation("200", "100", "0");
        expect(await feeStrategy.callStatic.computeRolloverFeePerc()).to.eq(toPercFixedPtAmt("-0.00117880"));
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
        ).to.be.revertedWith("FeeStrategy: fee bound too low");
      });
      it("should revert", async function () {
        await expect(
          feeStrategy
            .connect(deployer)
            .updateRolloverFees([toPercFixedPtAmt("-0.01"), toPercFixedPtAmt("0.25"), toPercFixedPtAmt("3")]),
        ).to.be.revertedWith("FeeStrategy: fee bound too high");
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
});
