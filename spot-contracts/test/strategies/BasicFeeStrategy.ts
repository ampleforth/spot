import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ContractFactory, Transaction, Signer } from "ethers";

import { toFixedPtAmt } from "../helpers";

let factory: ContractFactory, feeStrategy: Contract, deployer: Signer, otherUser: Signer;

const mockFeeTokenAddress = "0x000000000000000000000000000000000000dEaD";

describe("BasicFeeStrategy", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    factory = await ethers.getContractFactory("BasicFeeStrategy");
    feeStrategy = await factory.deploy(mockFeeTokenAddress);
  });

  describe("#feeToken", function () {
    beforeEach(async function () {
      await feeStrategy.init("0", "0", "0");
    });
    it("should return the fee token", async function () {
      expect(await feeStrategy.feeToken()).to.eq(mockFeeTokenAddress);
    });
  });

  describe("#updateMintFeePerc", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await feeStrategy.init("0", "0", "0");
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(otherUser).updateMintFeePerc("1")).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
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
      await feeStrategy.init("0", "0", "0");
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(otherUser).updateBurnFeePerc("1")).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
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
      await feeStrategy.init("0", "0", "0");
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(otherUser).updateRolloverFeePerc("1")).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
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

  describe("#computeMintFees", function () {
    describe("when perc > 0", function () {
      it("should return the mint fee", async function () {
        await feeStrategy.init("1500000", "0", "0");
        const r = await feeStrategy.computeMintFees(toFixedPtAmt("1000"));
        expect(r[0]).to.eq(toFixedPtAmt("15"));
        expect(r[1]).to.eq("0");
      });
    });

    describe("when perc < 0", function () {
      it("should return the mint fee", async function () {
        await feeStrategy.init("-2500000", "0", "0");
        const r = await feeStrategy.computeMintFees(toFixedPtAmt("1000"));
        expect(r[0]).to.eq(toFixedPtAmt("-25"));
        expect(r[1]).to.eq("0");
      });
    });

    describe("when perc = 0", function () {
      it("should return the mint fee", async function () {
        await feeStrategy.init("0", "0", "0");
        const r = await feeStrategy.computeMintFees(toFixedPtAmt("1000"));
        expect(r[0]).to.eq(toFixedPtAmt("0"));
        expect(r[1]).to.eq("0");
      });
    });
  });

  describe("#computeBurnFees", function () {
    describe("when perc > 0", function () {
      it("should return the burn fee", async function () {
        await feeStrategy.init("0", "2500000", "0");
        const r = await feeStrategy.computeBurnFees(toFixedPtAmt("1000"));
        expect(r[0]).to.eq(toFixedPtAmt("25"));
        expect(r[1]).to.eq("0");
      });
    });

    describe("when perc < 0", function () {
      it("should return the burn fee", async function () {
        await feeStrategy.init("0", "-1500000", "0");
        const r = await feeStrategy.computeBurnFees(toFixedPtAmt("1000"));
        expect(r[0]).to.eq(toFixedPtAmt("-15"));
        expect(r[1]).to.eq("0");
      });
    });

    describe("when perc = 0", function () {
      it("should return the burn fee", async function () {
        await feeStrategy.init("0", "0", "0");
        const r = await feeStrategy.computeBurnFees(toFixedPtAmt("1000"));
        expect(r[0]).to.eq(toFixedPtAmt("0"));
        expect(r[1]).to.eq("0");
      });
    });
  });

  describe("#computeRolloverFees", function () {
    describe("when perc > 0", function () {
      it("should return the rollover fee", async function () {
        await feeStrategy.init("0", "0", "1000000");
        const r = await feeStrategy.computeRolloverFees(toFixedPtAmt("100000"));
        expect(r[0]).to.eq(toFixedPtAmt("1000"));
        expect(r[1]).to.eq("0");
      });
    });

    describe("when perc < 0", function () {
      it("should return the rollover fee", async function () {
        await feeStrategy.init("0", "0", "-5000000");
        const r = await feeStrategy.computeRolloverFees(toFixedPtAmt("100000"));
        expect(r[0]).to.eq(toFixedPtAmt("-5000"));
        expect(r[1]).to.eq("0");
      });
    });

    describe("when perc = 0", function () {
      it("should return the rollover fee", async function () {
        await feeStrategy.init("0", "0", "0");
        const r = await feeStrategy.computeRolloverFees(toFixedPtAmt("100000"));
        expect(r[0]).to.eq(toFixedPtAmt("0"));
        expect(r[1]).to.eq("0");
      });
    });
  });
});
