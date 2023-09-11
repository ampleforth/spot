import { expect, use } from "chai";
import { ethers } from "hardhat";
import { Contract, Transaction, Signer } from "ethers";
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

let feeStrategy: Contract, deployer: Signer, otherUser: Signer, perp: Contract, bondFactory: Contract, collateralToken;

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

  describe.only("#computeTargetVaultTVL", function () {
    it("should compute the target tvl", async function () {
      const bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 86400);
      const tranches = await getTranches(bond);
      await perp.computeDiscount.whenCalledWith(tranches[0].address).returns(toDiscountFixedPtAmt("1"));
      await perp.computeDiscount.whenCalledWith(tranches[1].address).returns(toDiscountFixedPtAmt("0.5"));
      await perp.computeDiscount.whenCalledWith(tranches[2].address).returns(toDiscountFixedPtAmt("0"));
      await perp.getTVL.returns(toFixedPtAmt("1000"));
      expect(await feeStrategy.callStatic.computeTargetVaultTVL(bond.address)).to.eq(toFixedPtAmt("1857.142857142857142857")) // => 1000/350*650
    });
  });
});
