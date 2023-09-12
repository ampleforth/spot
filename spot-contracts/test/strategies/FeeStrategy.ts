import { expect, use } from "chai";
import { ethers } from "hardhat";
import { Contract, Transaction, Signer, constants } from "ethers";
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
  vault1: Contract,
  vault2: Contract;

describe("FeeStrategy", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    const factory = await ethers.getContractFactory("FeeStrategy");
    feeStrategy = await factory.deploy();

    bondFactory = await setupBondFactory();
    ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await smock.fake(PerpetualTranche);

    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    vault1 = await smock.fake(RolloverVault);
    vault2 = await smock.fake(RolloverVault);

    await feeStrategy.init(perp.address);
  });

  describe("#init", function () {
    it("should return the perp address", async function () {
      expect(await feeStrategy.perp()).to.eq(perp.address);
    });
    it("should return owner", async function () {
      expect(await feeStrategy.owner()).to.eq(await deployer.getAddress());
    });
  });

  describe("#computeTargetVaultTVL", function () {
    it("should compute the target tvl", async function () {
      const bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 86400);
      const tranches = await getTranches(bond);
      await perp.computeDiscount.whenCalledWith(tranches[0].address).returns(toDiscountFixedPtAmt("1"));
      await perp.computeDiscount.whenCalledWith(tranches[1].address).returns(toDiscountFixedPtAmt("0.5"));
      await perp.computeDiscount.whenCalledWith(tranches[2].address).returns(toDiscountFixedPtAmt("0"));
      await perp.getTVL.returns(toFixedPtAmt("1000"));
      expect(await feeStrategy.callStatic.computeTargetVaultTVL(bond.address)).to.eq(
        toFixedPtAmt("1857.142857142857142857"),
      ); // => 1000/350*650
    });
  });

  describe("#getCurrentVaultTVL", function () {
    describe("when one vault is authorized", function () {
      it("should compute the tvl", async function () {
        await perp.authorizedRollersCount.returns(1);
        await perp.authorizedRollerAt.whenCalledWith(0).returns(vault1.address);
        await vault1.getTVL.returns(toFixedPtAmt("999"));
        expect(await feeStrategy.callStatic.getCurrentVaultTVL()).to.eq(toFixedPtAmt("999"));
      });
    });

    describe("when multiple vaults are authorized", function () {
      it("should compute the tvl", async function () {
        await perp.authorizedRollersCount.returns(2);
        await perp.authorizedRollerAt.whenCalledWith(0).returns(vault1.address);
        await perp.authorizedRollerAt.whenCalledWith(1).returns(vault2.address);
        await vault1.getTVL.returns(toFixedPtAmt("10000"));
        await vault2.getTVL.returns(toFixedPtAmt("5000"));
        expect(await feeStrategy.callStatic.getCurrentVaultTVL()).to.eq(toFixedPtAmt("15000"));
      });
    });

    describe("when one vault is a contract which is not a vault contract", function () {
      it("should compute the tvl", async function () {
        await perp.authorizedRollersCount.returns(2);
        await perp.authorizedRollerAt.whenCalledWith(0).returns(vault1.address);
        await perp.authorizedRollerAt.whenCalledWith(1).returns(collateralToken.address);
        await vault1.getTVL.returns(toFixedPtAmt("100"));
        expect(await feeStrategy.callStatic.getCurrentVaultTVL()).to.eq(toFixedPtAmt("100"));
      });
    });

    describe("when one vault is a eoa", function () {
      it("should compute the tvl", async function () {
        await perp.authorizedRollersCount.returns(2);
        await perp.authorizedRollerAt.whenCalledWith(0).returns(vault1.address);
        await perp.authorizedRollerAt.whenCalledWith(1).returns(await deployer.getAddress());
        await vault1.getTVL.returns(toFixedPtAmt("10000"));
        expect(await feeStrategy.callStatic.getCurrentVaultTVL()).to.eq(toFixedPtAmt("10000"));
      });
    });
  });

  describe("#computeRolloverAPR", function () {
    it("should compute the apr", async function () {
      expect(await feeStrategy.callStatic.computeRolloverAPR(toFixedPtAmt("100"), toFixedPtAmt("100"))).to.eq(
        toPercFixedPtAmt("0"),
      );
      expect(await feeStrategy.callStatic.computeRolloverAPR(toFixedPtAmt("100"), toFixedPtAmt("200"))).to.eq(
        toPercFixedPtAmt("-0.01537714"),
      );
      expect(await feeStrategy.callStatic.computeRolloverAPR(toFixedPtAmt("200"), toFixedPtAmt("100"))).to.eq(
        toPercFixedPtAmt("0.04492753"),
      );
    });
  });

  describe("#computeRolloverFeePerc", function () {
    describe("at equilibrium", function () {
      it("should compute the fee perc", async function () {
        await perp.authorizedRollersCount.returns(1);
        await perp.authorizedRollerAt.whenCalledWith(0).returns(vault1.address);
        await vault1.getTVL.returns(toFixedPtAmt("300"));

        const bond = await createBondWithFactory(bondFactory, collateralToken, [250, 750], 28 * 86400);
        const tranches = await getTranches(bond);
        await perp.getDepositBond.returns(bond.address);
        await perp.computeDiscount.whenCalledWith(tranches[0].address).returns(toDiscountFixedPtAmt("1"));
        await perp.computeDiscount.whenCalledWith(tranches[1].address).returns(toDiscountFixedPtAmt("0"));
        await perp.getTVL.returns(toFixedPtAmt("100"));

        expect(await feeStrategy.callStatic.computeRolloverFeePerc()).to.eq(toPercFixedPtAmt("0"));
      });
    });

    describe("when vault tvl > target", function () {
      it("should compute the fee perc", async function () {
        await perp.authorizedRollersCount.returns(1);
        await perp.authorizedRollerAt.whenCalledWith(0).returns(vault1.address);
        await vault1.getTVL.returns(toFixedPtAmt("600"));

        const bond = await createBondWithFactory(bondFactory, collateralToken, [250, 750], 28 * 86400);
        const tranches = await getTranches(bond);
        await perp.getDepositBond.returns(bond.address);
        await perp.computeDiscount.whenCalledWith(tranches[0].address).returns(toDiscountFixedPtAmt("1"));
        await perp.computeDiscount.whenCalledWith(tranches[1].address).returns(toDiscountFixedPtAmt("0"));
        await perp.getTVL.returns(toFixedPtAmt("100"));

        expect(await feeStrategy.callStatic.computeRolloverFeePerc()).to.eq(toPercFixedPtAmt("0.00344649"));
      });
    });

    describe("when vault tvl < target", function () {
      it("should compute the fee perc", async function () {
        await perp.authorizedRollersCount.returns(1);
        await perp.authorizedRollerAt.whenCalledWith(0).returns(vault1.address);
        await vault1.getTVL.returns(toFixedPtAmt("200"));

        const bond = await createBondWithFactory(bondFactory, collateralToken, [250, 750], 28 * 86400);
        const tranches = await getTranches(bond);
        await perp.getDepositBond.returns(bond.address);
        await perp.computeDiscount.whenCalledWith(tranches[0].address).returns(toDiscountFixedPtAmt("1"));
        await perp.computeDiscount.whenCalledWith(tranches[1].address).returns(toDiscountFixedPtAmt("0"));
        await perp.getTVL.returns(toFixedPtAmt("100"));

        expect(await feeStrategy.callStatic.computeRolloverFeePerc()).to.eq(toPercFixedPtAmt("-0.00092952"));
      });
    });
  });

  describe("#updateFeeParams", function () {
    let tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          feeStrategy
            .connect(otherUser)
            .updateFeeParams([toPercFixedPtAmt("-0.01"), toPercFixedPtAmt("0.01"), toPercFixedPtAmt("3")]),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
    describe("when params are invalid", function () {
      it("should revert", async function () {
        await expect(
          feeStrategy
            .connect(deployer)
            .updateFeeParams([toPercFixedPtAmt("-0.25"), toPercFixedPtAmt("0.01"), toPercFixedPtAmt("3")]),
        ).to.be.revertedWith("FeeStrategy: fee bound too low");
      });
      it("should revert", async function () {
        await expect(
          feeStrategy
            .connect(deployer)
            .updateFeeParams([toPercFixedPtAmt("-0.01"), toPercFixedPtAmt("0.25"), toPercFixedPtAmt("3")]),
        ).to.be.revertedWith("FeeStrategy: fee bound too high");
      });
    });

    describe("when trigged by owner", function () {
      beforeEach(async function () {
        tx = feeStrategy
          .connect(deployer)
          .updateFeeParams([toPercFixedPtAmt("-0.01"), toPercFixedPtAmt("0.01"), toPercFixedPtAmt("3")]);
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
