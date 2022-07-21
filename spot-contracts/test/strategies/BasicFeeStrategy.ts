import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ContractFactory, Transaction, Signer, constants } from "ethers";

import { toFixedPtAmt } from "../helpers";

let perp: Contract, factory: ContractFactory, feeStrategy: Contract, deployer: Signer, otherUser: Signer;

describe("BasicFeeStrategy", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    const PerpetualTranche = await ethers.getContractFactory("MockPerpetualTranche");
    perp = await PerpetualTranche.deploy();
    await perp.deployed();
    await perp.init("MockPerpetualTranche", "PERP");

    factory = await ethers.getContractFactory("BasicFeeStrategy");
    feeStrategy = await factory.deploy(perp.address);
  });

  describe("#updateFeeToken", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await feeStrategy.init(perp.address, "0", "0", "0");
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(otherUser).updateFeeToken(constants.AddressZero)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set by owner", function () {
      beforeEach(async function () {
        tx = feeStrategy.connect(deployer).updateFeeToken(constants.AddressZero);
        await tx;
      });
      it("should update reference", async function () {
        expect(await feeStrategy.feeToken()).to.eq(constants.AddressZero);
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(feeStrategy, "UpdatedFeeToken").withArgs(constants.AddressZero);
      });
    });
  });

  describe("#updateMintFeePerc", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await feeStrategy.init(perp.address, "0", "0", "0");
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(otherUser).updateMintFeePerc("1")).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set mint fee perc is NOT valid", function () {
      it("should revert", async function () {
        await expect(feeStrategy.updateMintFeePerc("100000001")).to.be.revertedWith("UnacceptablePercValue");
      });
    });

    describe("when set mint fee perc is valid", function () {
      beforeEach(async function () {
        tx = feeStrategy.connect(deployer).updateMintFeePerc("50000000");
        await tx;
      });
      it("should update reference", async function () {
        expect(await feeStrategy.mintFeePerc()).to.eq("50000000");
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(feeStrategy, "UpdatedMintPerc").withArgs("50000000");
      });
    });
  });

  describe("#updateBurnFeePerc", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await feeStrategy.init(perp.address, "0", "0", "0");
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(otherUser).updateBurnFeePerc("1")).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set burn fee perc is NOT valid", function () {
      it("should revert", async function () {
        await expect(feeStrategy.updateBurnFeePerc("100000001")).to.be.revertedWith("UnacceptablePercValue");
      });
    });

    describe("when set burn fee perc is valid", function () {
      beforeEach(async function () {
        tx = feeStrategy.connect(deployer).updateBurnFeePerc("50000000");
        await tx;
      });
      it("should update reference", async function () {
        expect(await feeStrategy.burnFeePerc()).to.eq("50000000");
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(feeStrategy, "UpdatedBurnPerc").withArgs("50000000");
      });
    });
  });

  describe("#updateRolloverFeePerc", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await feeStrategy.init(perp.address, "0", "0", "0");
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(otherUser).updateRolloverFeePerc("1")).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set rollover fee perc is NOT valid", function () {
      it("should revert", async function () {
        await expect(feeStrategy.updateRolloverFeePerc("100000001")).to.be.revertedWith("UnacceptablePercValue");
      });
    });

    describe("when set rollover fee perc is valid", function () {
      beforeEach(async function () {
        tx = feeStrategy.connect(deployer).updateRolloverFeePerc("50000000");
        await tx;
      });
      it("should update reference", async function () {
        expect(await feeStrategy.rolloverFeePerc()).to.eq("50000000");
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(feeStrategy, "UpdatedRolloverPerc").withArgs("50000000");
      });
    });
  });

  describe("#computeMintFee", function () {
    describe("when perc > 0", function () {
      it("should return the mint fee", async function () {
        await feeStrategy.init(perp.address, "1500000", "0", "0");
        expect(await feeStrategy.computeMintFee(toFixedPtAmt("1000"))).to.eq(toFixedPtAmt("15"));
      });
    });

    describe("when perc < 0", function () {
      it("should return the mint fee", async function () {
        await feeStrategy.init(perp.address, "-2500000", "0", "0");
        expect(await feeStrategy.computeMintFee(toFixedPtAmt("1000"))).to.eq(toFixedPtAmt("-25"));
      });
    });

    describe("when perc = 0", function () {
      it("should return the mint fee", async function () {
        await feeStrategy.init(perp.address, "0", "0", "0");
        expect(await feeStrategy.computeMintFee(toFixedPtAmt("1000"))).to.eq(toFixedPtAmt("0"));
      });
    });
  });

  describe("#computeBurnFee", function () {
    describe("when perc > 0", function () {
      it("should return the burn fee", async function () {
        await feeStrategy.init(perp.address, "0", "2500000", "0");
        expect(await feeStrategy.computeBurnFee(toFixedPtAmt("1000"))).to.eq(toFixedPtAmt("25"));
      });
    });

    describe("when perc < 0", function () {
      it("should return the burn fee", async function () {
        await feeStrategy.init(perp.address, "0", "-1500000", "0");
        expect(await feeStrategy.computeBurnFee(toFixedPtAmt("1000"))).to.eq(toFixedPtAmt("-15"));
      });
    });

    describe("when perc = 0", function () {
      it("should return the burn fee", async function () {
        await feeStrategy.init(perp.address, "0", "0", "0");
        expect(await feeStrategy.computeBurnFee(toFixedPtAmt("1000"))).to.eq(toFixedPtAmt("0"));
      });
    });
  });

  describe("#computeRolloverFee", function () {
    beforeEach(async function () {
      await perp.mint(perp.address, toFixedPtAmt("100000"));
    });

    describe("when perc > 0", function () {
      it("should return the rollover fee", async function () {
        await feeStrategy.init(perp.address, "0", "0", "1000000");
        expect(await feeStrategy.computeRolloverFee(toFixedPtAmt("100000"))).to.eq(toFixedPtAmt("1000"));
      });
    });

    describe("when perc < 0", function () {
      it("should return the rollover fee", async function () {
        await feeStrategy.init(perp.address, "0", "0", "-5000000");
        expect(await feeStrategy.computeRolloverFee(toFixedPtAmt("100000"))).to.eq(toFixedPtAmt("-5000"));
      });
    });

    describe("when perc = 0", function () {
      it("should return the rollover fee", async function () {
        await feeStrategy.init(perp.address, "0", "0", "0");
        expect(await feeStrategy.computeRolloverFee(toFixedPtAmt("100000"))).to.eq(toFixedPtAmt("0"));
      });
    });
  });
});
