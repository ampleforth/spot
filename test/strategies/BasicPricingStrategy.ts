import { expect } from "chai";
import { ethers } from "hardhat";
import { constants } from "ethers";

describe("BasicPricingStrategy", function () {
  describe("computeTranchePrice", function () {
    it("should return 1", async function () {
      const BasicPricingStrategy = await ethers.getContractFactory("BasicPricingStrategy");
      const pricingStrategy = await BasicPricingStrategy.deploy();

      expect(await pricingStrategy.decimals()).to.eq(8);
      expect(await pricingStrategy.computeTranchePrice(constants.AddressZero)).to.eq("100000000");
    });
  });
});
