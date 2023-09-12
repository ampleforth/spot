import { expect, use } from "chai";
import { ethers } from "hardhat";
import { Contract, Transaction, Signer, constants } from "ethers";
import { smock } from "@defi-wonderland/smock";

import {
  toFixedPtAmt,
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  getTranches,
  toDiscountFixedPtAmt,
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

  describe.only("#init", function () {
    it("should return the perp address", async function () {
      expect(await feeStrategy.perp()).to.eq(perp.address);
    });
    it("should return owner", async function () {
      expect(await feeStrategy.owner()).to.eq(await deployer.getAddress());
    });
  });

  describe.only("#computeTargetVaultTVL", function () {
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

  describe.only("#getCurrentVaultTVL", function () {
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

  // describe("#updateMintFeePerc", function () {
  //   let tx: Transaction;
  //   beforeEach(async function () {
  //     await feeStrategy.init("0", "0", "0");
  //   });

  //   describe("when triggered by non-owner", function () {
  //     it("should revert", async function () {
  //       await expect(feeStrategy.connect(otherUser).updateMintFeePerc("1")).to.be.revertedWith(
  //         "Ownable: caller is not the owner",
  //       );
  //     });
  //   });

  //   describe("when set mint fee perc is valid", function () {
  //     beforeEach(async function () {
  //       tx = feeStrategy.connect(deployer).updateMintFeePerc("50000000");
  //       await tx;
  //     });
  //     it("should update reference", async function () {
  //       expect(await feeStrategy.mintFeePerc()).to.eq("50000000");
  //     });
  //     it("should emit event", async function () {
  //       await expect(tx).to.emit(feeStrategy, "UpdatedMintPerc").withArgs("50000000");
  //     });
  //   });
  // });
});
