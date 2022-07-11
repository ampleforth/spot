import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, ContractFactory } from "ethers";

import { toFixedPtAmt } from "../helpers";

let perp: Contract, factory: ContractFactory;

describe("BasicFeeStrategy", function () {
  beforeEach(async function () {
    const PerpetualTranche = await ethers.getContractFactory("MockPerpetualTranche");
    perp = await PerpetualTranche.deploy();
    await perp.deployed();
    await perp.init("MockPerpetualTranche", "PERP");

    factory = await ethers.getContractFactory("BasicFeeStrategy");
  });

  describe("#computeMintFee", function () {
    describe("when perc > 0", function () {
      it("should return the mint fee", async function () {
        const feeStrategy = await factory.deploy(perp.address, perp.address, "1500000", "0", "0");
        expect(await feeStrategy.computeMintFee(toFixedPtAmt("1000"))).to.eq(toFixedPtAmt("15"));
      });
    });

    describe("when perc < 0", function () {
      it("should return the mint fee", async function () {
        const feeStrategy = await factory.deploy(perp.address, perp.address, "-2500000", "0", "0");
        expect(await feeStrategy.computeMintFee(toFixedPtAmt("1000"))).to.eq(toFixedPtAmt("-25"));
      });
    });

    describe("when perc = 0", function () {
      it("should return the mint fee", async function () {
        const feeStrategy = await factory.deploy(perp.address, perp.address, "0", "0", "0");
        expect(await feeStrategy.computeMintFee(toFixedPtAmt("1000"))).to.eq(toFixedPtAmt("0"));
      });
    });
  });

  describe("#computeBurnFee", function () {
    describe("when perc > 0", function () {
      it("should return the mint fee", async function () {
        const feeStrategy = await factory.deploy(perp.address, perp.address, "0", "2500000", "0");
        expect(await feeStrategy.computeBurnFee(toFixedPtAmt("1000"))).to.eq(toFixedPtAmt("25"));
      });
    });

    describe("when perc < 0", function () {
      it("should return the mint fee", async function () {
        const feeStrategy = await factory.deploy(perp.address, perp.address, "0", "-1500000", "0");
        expect(await feeStrategy.computeBurnFee(toFixedPtAmt("1000"))).to.eq(toFixedPtAmt("-15"));
      });
    });

    describe("when perc = 0", function () {
      it("should return the mint fee", async function () {
        const feeStrategy = await factory.deploy(perp.address, perp.address, "0", "0", "0");
        expect(await feeStrategy.computeBurnFee(toFixedPtAmt("1000"))).to.eq(toFixedPtAmt("0"));
      });
    });
  });

  describe("#computeRolloverFee", function () {
    beforeEach(async function () {
      await perp.mint(perp.address, toFixedPtAmt("100000"));
    });

    describe("when perc > 0", function () {
      it("should return the mint fee", async function () {
        const feeStrategy = await factory.deploy(perp.address, perp.address, "0", "0", "1000000");
        expect(await feeStrategy.computeRolloverFee(toFixedPtAmt("100000"))).to.eq(toFixedPtAmt("1000"));
      });
    });

    describe("when perc < 0", function () {
      it("should return the mint fee", async function () {
        const feeStrategy = await factory.deploy(perp.address, perp.address, "0", "0", "-5000000");
        expect(await feeStrategy.computeRolloverFee(toFixedPtAmt("100000"))).to.eq(toFixedPtAmt("-5000"));
      });
    });

    describe("when perc = 0", function () {
      it("should return the mint fee", async function () {
        const feeStrategy = await factory.deploy(perp.address, perp.address, "0", "0", "0");
        expect(await feeStrategy.computeRolloverFee(toFixedPtAmt("100000"))).to.eq(toFixedPtAmt("0"));
      });
    });
  });
});
