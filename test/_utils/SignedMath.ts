import { expect } from "chai";
import { ethers } from "hardhat";
import { constants } from "ethers";

describe("SignedMath", function () {
  describe("sign", function () {
    it("should return sign", async function () {
      const MathTester = await ethers.getContractFactory("MathTester");
      const math = await MathTester.deploy();
      await math.deployed();
      expect(await math.sign("0")).to.eq(0);

      expect(await math.sign("-1")).to.eq(-1);
      expect(await math.sign(constants.MinInt256)).to.eq(-1);
      expect(await math.sign("-1123213132112")).to.eq(-1);

      expect(await math.sign("1")).to.eq(1);
      expect(await math.sign("1112433423242")).to.eq(1);
      expect(await math.sign(constants.MaxInt256)).to.eq(1);
    });
  });
});
