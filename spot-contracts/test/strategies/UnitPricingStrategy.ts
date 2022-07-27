import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, constants } from "ethers";

let pricingStrategy: Contract;

describe("UnitPricingStrategy", function () {
  beforeEach(async () => {
    const UnitPricingStrategy = await ethers.getContractFactory("UnitPricingStrategy");
    pricingStrategy = await UnitPricingStrategy.deploy();
  });

  describe("decimals", function () {
    it("should be set", async function () {
      expect(await pricingStrategy.decimals()).to.eq(8);
    });
  });

  describe("computeTranchePrice", function () {
    it("should be return one", async function () {
      expect(await pricingStrategy.computeTranchePrice(constants.AddressZero)).to.eq("100000000");
    });
  });

  describe("computeMatureTranchePrice", function () {
    it("should be return one", async function () {
      expect(await pricingStrategy.computeMatureTranchePrice(constants.AddressZero, 0, 0)).to.eq("100000000");
    });
  });
});
