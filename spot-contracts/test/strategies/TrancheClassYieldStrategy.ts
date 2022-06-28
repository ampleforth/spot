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
  toYieldFixedPtAmt,
} from "../helpers";

let yieldStrategy: Contract, deployer: Signer, otherUser: Signer;

describe("TrancheClassYieldStrategy", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    const TrancheClassYieldStrategy = await ethers.getContractFactory("TrancheClassYieldStrategy");
    yieldStrategy = await TrancheClassYieldStrategy.deploy();
    await yieldStrategy.init();
  });

  describe("decimals", function () {
    it("should be set", async function () {
      expect(await pricingStrategy.decimals()).to.eq(18);
    });
  });

  describe("#updateDefinedYield", function () {
    let tx: Transaction, tranche: Contract, classHash: string;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(yieldStrategy.connect(otherUser).updateDefinedYield(constants.HashZero, 0)).to.be.revertedWith(
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

        classHash = await yieldStrategy.trancheClass(tranche.address);
        tx = yieldStrategy.updateDefinedYield(classHash, toYieldFixedPtAmt("1"));
        await tx;
      });
      it("should update reference", async function () {
        expect(await yieldStrategy.computeYield(tranche.address)).to.eq(toYieldFixedPtAmt("1"));
      });
      it("should emit event", async function () {
        await expect(tx)
          .to.emit(yieldStrategy, "UpdatedDefinedTrancheYields")
          .withArgs(classHash, toYieldFixedPtAmt("1"));
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
        expect(await yieldStrategy.trancheClass(tranches[0].address)).to.eq(c0);
        expect(await yieldStrategy.trancheClass(tranches[1].address)).to.eq(c1);
        expect(await yieldStrategy.trancheClass(tranches[2].address)).to.eq(c2);
      });
    });

    describe("when 2 tranches from same class", function () {
      let tranchesOther: Contract[];
      beforeEach(async function () {
        const bondOther = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
        tranchesOther = await getTranches(bondOther);
      });
      it("should have the same class hash", async function () {
        expect(await yieldStrategy.trancheClass(tranches[0].address)).to.eq(
          await yieldStrategy.trancheClass(tranchesOther[0].address),
        );
        expect(await yieldStrategy.trancheClass(tranches[1].address)).to.eq(
          await yieldStrategy.trancheClass(tranchesOther[1].address),
        );
        expect(await yieldStrategy.trancheClass(tranches[2].address)).to.eq(
          await yieldStrategy.trancheClass(tranchesOther[2].address),
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
        expect(await yieldStrategy.trancheClass(tranches[0].address)).not.to.eq(
          await yieldStrategy.trancheClass(tranchesOther[0].address),
        );
        expect(await yieldStrategy.trancheClass(tranches[1].address)).not.to.eq(
          await yieldStrategy.trancheClass(tranchesOther[1].address),
        );
        expect(await yieldStrategy.trancheClass(tranches[2].address)).not.to.eq(
          await yieldStrategy.trancheClass(tranchesOther[2].address),
        );
      });
    });
  });

  describe("#trancheYield", function () {
    let bondFactory: Contract, collateralToken: Contract, bond: Contract, tranches: Contract[];
    beforeEach(async function () {
      bondFactory = await setupBondFactory();
      ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));

      bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
      tranches = await getTranches(bond);

      await yieldStrategy.updateDefinedYield(
        await yieldStrategy.trancheClass(tranches[0].address),
        toYieldFixedPtAmt("1"),
      );
    });

    describe("when tranche instance is not in the system", function () {
      it("should return defined yield", async function () {
        expect(await yieldStrategy.computeYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("1"));
      });
      describe("when not defined", function () {
        it("should return 0", async function () {
          expect(await yieldStrategy.computeYield(tranches[1].address)).to.eq(toYieldFixedPtAmt("0"));
          expect(await yieldStrategy.computeYield(tranches[2].address)).to.eq(toYieldFixedPtAmt("0"));
        });
      });
      describe("when updated", function () {
        beforeEach(async function () {
          await yieldStrategy.updateDefinedYield(
            await yieldStrategy.trancheClass(tranches[0].address),
            toYieldFixedPtAmt("0.5"),
          );
        });
        it("should return defined yield", async function () {
          expect(await yieldStrategy.computeYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("0.5"));
        });
      });
    });

    describe("when a new tranche instance enters the system", function () {
      let tranchesNext: Contract[];
      beforeEach(async function () {
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(yieldStrategy.address, toFixedPtAmt("200"));

        const bondNext = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
        tranchesNext = await getTranches(bondNext);
      });
      it("should return defined yield", async function () {
        expect(await yieldStrategy.computeYield(tranchesNext[0].address)).to.eq(toYieldFixedPtAmt("1"));
      });
      describe("when updated", function () {
        beforeEach(async function () {
          await yieldStrategy.updateDefinedYield(
            await yieldStrategy.trancheClass(tranches[0].address),
            toYieldFixedPtAmt("0.5"),
          );
        });
        it("should return the updated yield", async function () {
          expect(await yieldStrategy.computeYield(tranchesNext[0].address)).to.eq(toYieldFixedPtAmt("0.5"));
        });
        it("should return the updated yield", async function () {
          expect(await yieldStrategy.computeYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("0.5"));
        });
      });
    });
  });
});
