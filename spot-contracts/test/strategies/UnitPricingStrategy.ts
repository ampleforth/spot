import { expect } from "chai";
import { ethers } from "hardhat";
import { constants } from "ethers";

describe("UnitPricingStrategy", function () {
  describe("computeTranchePrice", function () {
    it("should return 1", async function () {
      const UnitPricingStrategy = await ethers.getContractFactory("UnitPricingStrategy");
      const pricingStrategy = await UnitPricingStrategy.deploy();

      expect(await pricingStrategy.decimals()).to.eq(8);
      expect(await pricingStrategy.computeTranchePrice(constants.AddressZero)).to.eq("100000000");
    });
  });
});
