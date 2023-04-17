import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Transaction, Signer } from "ethers";

import { toFixedPtAmt } from "../helpers";

let feeStrategy: Contract, deployer: Signer, otherUser: Signer, feeToken: Contract;

describe("BasicFeeStrategy", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    const ERC20 = await ethers.getContractFactory("MockERC20");
    feeToken = await ERC20.deploy();

    const factory = await ethers.getContractFactory("BasicFeeStrategy");
    feeStrategy = await factory.deploy(feeToken.address, feeToken.address);
  });

  describe("#init", function () {
    beforeEach(async function () {
      await feeStrategy.init("0", "0", "0");
    });
    it("should return the fee token", async function () {
      expect(await feeStrategy.feeToken()).to.eq(feeToken.address);
    });
    it("should return the debasement flag", async function () {
      expect(await feeStrategy.allowDebase()).to.eq(false);
    });
    it("should return owner", async function () {
      expect(await feeStrategy.owner()).to.eq(await deployer.getAddress());
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

  describe("#enableDebasement", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await feeStrategy.init("0", "0", "0");
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(otherUser).allowDebasement(true)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when debasement is enabled", function () {
      beforeEach(async function () {
        tx = feeStrategy.connect(deployer).allowDebasement(true);
        await tx;
      });
      it("should update flag", async function () {
        expect(await feeStrategy.allowDebase()).to.eq(true);
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(feeStrategy, "UpdatedDebasementRule").withArgs(true);
      });
    });
  });

  describe("#disableDebasement", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await feeStrategy.init("0", "0", "0");
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(feeStrategy.connect(otherUser).allowDebasement(false)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when debasement is disabled", function () {
      beforeEach(async function () {
        tx = feeStrategy.connect(deployer).allowDebasement(false);
        await tx;
      });
      it("should update flag", async function () {
        expect(await feeStrategy.allowDebase()).to.eq(false);
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(feeStrategy, "UpdatedDebasementRule").withArgs(false);
      });
    });
  });

  describe("when debasement is enabled", function () {
    describe("#computeMintFees", function () {
      describe("when perc > 0", function () {
        it("should return the mint fee", async function () {
          await feeStrategy.init("1500000", "0", "0");
          await feeStrategy.allowDebasement(true);

          const r = await feeStrategy.computeMintFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq(toFixedPtAmt("15"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0", function () {
        it("should return the mint fee", async function () {
          await feeStrategy.init("-2500000", "0", "0");
          await feeStrategy.allowDebasement(true);

          const r = await feeStrategy.computeMintFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq(toFixedPtAmt("-25"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc = 0", function () {
        it("should return the mint fee", async function () {
          await feeStrategy.init("0", "0", "0");
          await feeStrategy.allowDebasement(true);

          const r = await feeStrategy.computeMintFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq("0");
          expect(r[1]).to.eq("0");
        });
      });
    });

    describe("#computeBurnFees", function () {
      describe("when perc > 0", function () {
        it("should return the burn fee", async function () {
          await feeStrategy.init("0", "2500000", "0");
          await feeStrategy.allowDebasement(true);

          const r = await feeStrategy.computeBurnFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq(toFixedPtAmt("25"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0", function () {
        it("should return the burn fee", async function () {
          await feeStrategy.init("0", "-1500000", "0");
          await feeStrategy.allowDebasement(true);

          const r = await feeStrategy.computeBurnFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq(toFixedPtAmt("-15"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc = 0", function () {
        it("should return the burn fee", async function () {
          await feeStrategy.init("0", "0", "0");
          await feeStrategy.allowDebasement(true);

          const r = await feeStrategy.computeBurnFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq("0");
          expect(r[1]).to.eq("0");
        });
      });
    });

    describe("#computeRolloverFees", function () {
      describe("when perc > 0", function () {
        it("should return the rollover fee", async function () {
          await feeStrategy.init("0", "0", "1000000");
          await feeStrategy.allowDebasement(true);

          const r = await feeStrategy.computeRolloverFees(toFixedPtAmt("100000"));
          expect(r[0]).to.eq(toFixedPtAmt("1000"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0", function () {
        it("should return the rollover fee", async function () {
          await feeStrategy.init("0", "0", "-5000000");
          await feeStrategy.allowDebasement(true);

          const r = await feeStrategy.computeRolloverFees(toFixedPtAmt("100000"));
          expect(r[0]).to.eq(toFixedPtAmt("-5000"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc = 0", function () {
        it("should return the rollover fee", async function () {
          await feeStrategy.init("0", "0", "0");
          await feeStrategy.allowDebasement(true);

          const r = await feeStrategy.computeRolloverFees(toFixedPtAmt("100000"));
          expect(r[0]).to.eq("0");
          expect(r[1]).to.eq("0");
        });
      });
    });
  });

  describe("when debasement is disabled", function () {
    describe("#computeMintFees", function () {
      describe("when perc > 0", function () {
        it("should return the mint fee", async function () {
          await feeStrategy.init("1500000", "0", "0");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeMintFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq(toFixedPtAmt("15"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0 && reserve balance = 0", function () {
        it("should return the debasement-free mint fee", async function () {
          await feeStrategy.init("-2500000", "0", "0");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeMintFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq("0");
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0 && reserve balance > fee to be paid", function () {
        it("should return the mint fee", async function () {
          await feeToken.mint(feeToken.address, toFixedPtAmt("30"));
          await feeStrategy.init("-2500000", "0", "0");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeMintFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq(toFixedPtAmt("-25"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0 && reserve balance = fee to be paid", function () {
        it("should return the mint fee", async function () {
          await feeToken.mint(feeToken.address, toFixedPtAmt("25"));
          await feeStrategy.init("-2500000", "0", "0");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeMintFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq(toFixedPtAmt("-25"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0 && reserve balance < fee to be paid", function () {
        it("should return the the debasement-free mint fee", async function () {
          await feeToken.mint(feeToken.address, toFixedPtAmt("18"));
          await feeStrategy.init("-2500000", "0", "0");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeMintFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq(toFixedPtAmt("-18"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc = 0", function () {
        it("should return the mint fee", async function () {
          await feeStrategy.init("0", "0", "0");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeMintFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq("0");
          expect(r[1]).to.eq("0");
        });
      });
    });

    describe("#computeBurnFees", function () {
      describe("when perc > 0", function () {
        it("should return the burn fee", async function () {
          await feeStrategy.init("0", "2500000", "0");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeBurnFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq(toFixedPtAmt("25"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0 && reserve balance = 0", function () {
        it("should return the the debasement-free burn fee", async function () {
          await feeStrategy.init("0", "-1500000", "0");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeBurnFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq("0");
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0 && reserve balance > fee to be paid", function () {
        it("should return the burn fee", async function () {
          await feeToken.mint(feeToken.address, toFixedPtAmt("20"));
          await feeStrategy.init("0", "-1500000", "0");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeBurnFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq(toFixedPtAmt("-15"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0 && reserve balance = fee to be paid", function () {
        it("should return the burn fee", async function () {
          await feeToken.mint(feeToken.address, toFixedPtAmt("15"));
          await feeStrategy.init("0", "-1500000", "0");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeBurnFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq(toFixedPtAmt("-15"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0 && reserve balance < fee to be paid", function () {
        it("should return the the debasement-free burn fee", async function () {
          await feeToken.mint(feeToken.address, toFixedPtAmt("11"));
          await feeStrategy.init("0", "-1500000", "0");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeBurnFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq(toFixedPtAmt("-11"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc = 0", function () {
        it("should return the burn fee", async function () {
          await feeStrategy.init("0", "0", "0");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeBurnFees(toFixedPtAmt("1000"));
          expect(r[0]).to.eq("0");
          expect(r[1]).to.eq("0");
        });
      });
    });

    describe("#computeRolloverFees", function () {
      describe("when perc > 0", function () {
        it("should return the rollover fee", async function () {
          await feeStrategy.init("0", "0", "1000000");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeRolloverFees(toFixedPtAmt("100000"));
          expect(r[0]).to.eq(toFixedPtAmt("1000"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0 && reserve balance = 0", function () {
        it("should return the the debasement-free rollover fee", async function () {
          await feeStrategy.init("0", "0", "-5000000");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeRolloverFees(toFixedPtAmt("100000"));
          expect(r[0]).to.eq("0");
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0 && reserve balance > fee to be paid", function () {
        it("should return the rollover fee", async function () {
          await feeToken.mint(feeToken.address, toFixedPtAmt("10000"));
          await feeStrategy.init("0", "0", "-5000000");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeRolloverFees(toFixedPtAmt("100000"));
          expect(r[0]).to.eq(toFixedPtAmt("-5000"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0 && reserve balance = fee to be paid", function () {
        it("should return the rollover fee", async function () {
          await feeToken.mint(feeToken.address, toFixedPtAmt("5000"));
          await feeStrategy.init("0", "0", "-5000000");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeRolloverFees(toFixedPtAmt("100000"));
          expect(r[0]).to.eq(toFixedPtAmt("-5000"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc < 0 && reserve balance < fee to be paid", function () {
        it("should return the the debasement-free rollover fee", async function () {
          await feeToken.mint(feeToken.address, toFixedPtAmt("1000"));
          await feeStrategy.init("0", "0", "-5000000");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeRolloverFees(toFixedPtAmt("100000"));
          expect(r[0]).to.eq(toFixedPtAmt("-1000"));
          expect(r[1]).to.eq("0");
        });
      });

      describe("when perc = 0", function () {
        it("should return the rollover fee", async function () {
          await feeStrategy.init("0", "0", "0");
          await feeStrategy.allowDebasement(false);

          const r = await feeStrategy.computeRolloverFees(toFixedPtAmt("100000"));
          expect(r[0]).to.eq("0");
          expect(r[1]).to.eq("0");
        });
      });
    });
  });
});
