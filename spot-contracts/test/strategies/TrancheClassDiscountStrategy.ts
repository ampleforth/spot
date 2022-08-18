import { expect } from "chai";
import { ethers } from "hardhat";
import { Signer, Contract, constants, Transaction } from "ethers";

import {
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  depositIntoBond,
  getTranches,
  toFixedPtAmt,
  toDiscountFixedPtAmt,
} from "../helpers";

let discountStrategy: Contract, deployer: Signer, otherUser: Signer;

describe("TrancheClassDiscountStrategy", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    const TrancheClassDiscountStrategy = await ethers.getContractFactory("TrancheClassDiscountStrategy");
    discountStrategy = await TrancheClassDiscountStrategy.deploy();
    await discountStrategy.init();
  });

  describe("decimals", function () {
    it("should be set", async function () {
      expect(await discountStrategy.decimals()).to.eq(18);
    });
  });

  describe("#updateDefinedDiscount", function () {
    let tx: Transaction, tranche: Contract, classHash: string;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(discountStrategy.connect(otherUser).updateDefinedDiscount(constants.HashZero, 0)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when triggered by owner", function () {
      beforeEach(async function () {
        const bondFactory = await setupBondFactory();
        const { collateralToken } = await setupCollateralToken("Bitcoin", "BTC");
        const bond = await createBondWithFactory(bondFactory, collateralToken, [1000], 86400);
        const tranches = await getTranches(bond);
        tranche = tranches[0];

        classHash = await discountStrategy.trancheClass(tranche.address);
        tx = discountStrategy.updateDefinedDiscount(classHash, toDiscountFixedPtAmt("1"));
        await tx;
      });
      it("should update reference", async function () {
        expect(await discountStrategy.computeTrancheDiscount(tranche.address)).to.eq(toDiscountFixedPtAmt("1"));
      });
      it("should emit event", async function () {
        await expect(tx)
          .to.emit(discountStrategy, "UpdatedDefinedTrancheDiscounts")
          .withArgs(classHash, toDiscountFixedPtAmt("1"));
      });
      it("should delete discount when set to zero", async function () {
        await discountStrategy.updateDefinedDiscount(classHash, "0");
        expect(await discountStrategy.computeTrancheDiscount(tranche.address)).to.eq("0");
      });
    });
  });

  describe("#trancheClass", function () {
    let bondFactory: Contract, collateralToken: Contract, tranches: Contract[];
    beforeEach(async function () {
      bondFactory = await setupBondFactory();
      ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));
      const bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
      tranches = await getTranches(bond);
    });
    describe("given a tranche", function () {
      it("should compute the tranche hash", async function () {
        const types = ["address", "uint256[]", "uint256"];
        const abiCoder = ethers.utils.defaultAbiCoder;
        const c0 = await ethers.utils.keccak256(abiCoder.encode(types, [collateralToken.address, [200, 300, 500], 0]));
        const c1 = await ethers.utils.keccak256(abiCoder.encode(types, [collateralToken.address, [200, 300, 500], 1]));
        const c2 = await ethers.utils.keccak256(abiCoder.encode(types, [collateralToken.address, [200, 300, 500], 2]));
        expect(await discountStrategy.trancheClass(tranches[0].address)).to.eq(c0);
        expect(await discountStrategy.trancheClass(tranches[1].address)).to.eq(c1);
        expect(await discountStrategy.trancheClass(tranches[2].address)).to.eq(c2);
      });
    });

    describe("when 2 tranches from same class", function () {
      let tranchesOther: Contract[];
      beforeEach(async function () {
        const bondOther = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
        tranchesOther = await getTranches(bondOther);
      });
      it("should have the same class hash", async function () {
        expect(await discountStrategy.trancheClass(tranches[0].address)).to.eq(
          await discountStrategy.trancheClass(tranchesOther[0].address),
        );
        expect(await discountStrategy.trancheClass(tranches[1].address)).to.eq(
          await discountStrategy.trancheClass(tranchesOther[1].address),
        );
        expect(await discountStrategy.trancheClass(tranches[2].address)).to.eq(
          await discountStrategy.trancheClass(tranchesOther[2].address),
        );
      });
    });

    describe("when 2 tranches from different classes", function () {
      let tranchesOther: Contract[];
      beforeEach(async function () {
        const bondOther = await createBondWithFactory(bondFactory, collateralToken, [201, 300, 499], 3600);
        tranchesOther = await getTranches(bondOther);
      });
      it("should NOT have the same class hash", async function () {
        expect(await discountStrategy.trancheClass(tranches[0].address)).not.to.eq(
          await discountStrategy.trancheClass(tranchesOther[0].address),
        );
        expect(await discountStrategy.trancheClass(tranches[1].address)).not.to.eq(
          await discountStrategy.trancheClass(tranchesOther[1].address),
        );
        expect(await discountStrategy.trancheClass(tranches[2].address)).not.to.eq(
          await discountStrategy.trancheClass(tranchesOther[2].address),
        );
      });
    });
  });

  describe("#computeTrancheDiscount", function () {
    let bondFactory: Contract, collateralToken: Contract, bond: Contract, tranches: Contract[];
    beforeEach(async function () {
      bondFactory = await setupBondFactory();
      ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));

      bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
      tranches = await getTranches(bond);

      await discountStrategy.updateDefinedDiscount(
        await discountStrategy.trancheClass(tranches[0].address),
        toDiscountFixedPtAmt("1"),
      );
    });

    describe("when tranche instance is not in the system", function () {
      it("should return defined discount", async function () {
        expect(await discountStrategy.computeTrancheDiscount(tranches[0].address)).to.eq(toDiscountFixedPtAmt("1"));
      });
      describe("when not defined", function () {
        it("should return 0", async function () {
          expect(await discountStrategy.computeTrancheDiscount(tranches[1].address)).to.eq(toDiscountFixedPtAmt("0"));
          expect(await discountStrategy.computeTrancheDiscount(tranches[2].address)).to.eq(toDiscountFixedPtAmt("0"));
        });
      });
      describe("when updated", function () {
        beforeEach(async function () {
          await discountStrategy.updateDefinedDiscount(
            await discountStrategy.trancheClass(tranches[0].address),
            toDiscountFixedPtAmt("0.5"),
          );
        });
        it("should return defined discount", async function () {
          expect(await discountStrategy.computeTrancheDiscount(tranches[0].address)).to.eq(toDiscountFixedPtAmt("0.5"));
        });
      });
    });

    describe("when a new tranche instance enters the system", function () {
      let tranchesNext: Contract[];
      beforeEach(async function () {
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(discountStrategy.address, toFixedPtAmt("200"));

        const bondNext = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
        tranchesNext = await getTranches(bondNext);
      });
      it("should return defined discount", async function () {
        expect(await discountStrategy.computeTrancheDiscount(tranchesNext[0].address)).to.eq(toDiscountFixedPtAmt("1"));
      });
      describe("when updated", function () {
        beforeEach(async function () {
          await discountStrategy.updateDefinedDiscount(
            await discountStrategy.trancheClass(tranches[0].address),
            toDiscountFixedPtAmt("0.5"),
          );
        });
        it("should return the updated discount", async function () {
          expect(await discountStrategy.computeTrancheDiscount(tranchesNext[0].address)).to.eq(toDiscountFixedPtAmt("0.5"));
        });
        it("should return the updated discount", async function () {
          expect(await discountStrategy.computeTrancheDiscount(tranches[0].address)).to.eq(toDiscountFixedPtAmt("0.5"));
        });
      });
    });
  });
});
