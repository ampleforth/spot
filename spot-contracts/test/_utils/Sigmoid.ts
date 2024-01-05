import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, BigNumber } from "ethers";

import { toPercFixedPtAmt } from "../helpers";

describe("Sigmoid", function () {
  let math: Contract;
  async function cmp(x, y, lower, upper, growth) {
    expect(
      await math.compute(
        toPercFixedPtAmt(`${x}`),
        toPercFixedPtAmt(`${lower}`),
        toPercFixedPtAmt(`${upper}`),
        toPercFixedPtAmt(`${growth}`),
        toPercFixedPtAmt("1.0"),
      ),
    ).to.eq(toPercFixedPtAmt(`${y}`));
  }

  describe("compute", function () {
    before(async function () {
      const MathTester = await ethers.getContractFactory("MathTester");
      math = await MathTester.deploy();
      await math.deployed();
    });
    it("should return sigmoid(x)", async function () {
      await cmp(0, -0.00925926, -0.01, 0.05, 4);
      await cmp(0.1, -0.00902227, -0.01, 0.05, 4);
      await cmp(0.25, -0.00853659, -0.01, 0.05, 4);
      await cmp(0.5, -0.00714286, -0.01, 0.05, 4);
      await cmp(0.75, -0.00454546, -0.01, 0.05, 4);
      await cmp(0.8, -0.00374551, -0.01, 0.05, 4);
      await cmp(0.85, -0.00297903, -0.01, 0.05, 4);
      await cmp(0.9, -0.00198311, -0.01, 0.05, 4);
      await cmp(0.95, -0.00103668, -0.01, 0.05, 4);
      await cmp(0.98, -0.00035583, -0.01, 0.05, 4);
      await cmp(0.99, -0.00017921, -0.01, 0.05, 4);
      await cmp(1, 0, -0.01, 0.05, 4);
      await cmp(1.01, 0.00018181, -0.01, 0.05, 4);
      await cmp(1.02, 0.00036624, -0.01, 0.05, 4);
      await cmp(1.1, 0.00235705, -0.01, 0.05, 4);
      await cmp(1.2, 0.00534796, -0.01, 0.05, 4);
      await cmp(1.3, 0.00877749, -0.01, 0.05, 4);
      await cmp(1.5, 0.01666666, -0.01, 0.05, 4);
      await cmp(2, 0.03571428, -0.01, 0.05, 4);
      await cmp(3, 0.04885057, -0.01, 0.05, 4);
      await cmp(4, 0.04992684, -0.01, 0.05, 4);
      await cmp(10, 0.05, -0.01, 0.05, 4);
    });
  });

  describe("twoPower", function () {
    before(async function () {
      const MathTester = await ethers.getContractFactory("MathTester");
      math = await MathTester.deploy();
      await math.deployed();
    });

    const decimals18 = BigNumber.from("1000000000000000000");
    const decimals10 = BigNumber.from("10000000000");
    it("2^0", async function () {
      const e = BigNumber.from(0);
      const one = BigNumber.from(1).mul(decimals18);
      expect(await math.twoPower(e, one)).to.eq(one);
    });
    it("2^1", async function () {
      const e = BigNumber.from(1).mul(decimals18);
      const one = BigNumber.from(1).mul(decimals18);
      const result = BigNumber.from(2).mul(decimals18);
      expect(await math.twoPower(e, one)).to.eq(result);
    });
    it("2^30", async function () {
      const e = BigNumber.from(30).mul(decimals18);
      const one = BigNumber.from(1).mul(decimals18);
      const result = BigNumber.from(2 ** 30).mul(decimals18);
      expect(await math.twoPower(e, one)).to.eq(result);
    });
    it("2^2.5", async function () {
      const e = BigNumber.from("25000000000");
      const one = BigNumber.from(1).mul(decimals10);
      const result = BigNumber.from("56568542494");
      expect(await math.twoPower(e, one)).to.eq(result);
    });
    it("2^2.25", async function () {
      const e = BigNumber.from("22500000000");
      const one = BigNumber.from(1).mul(decimals10);
      const result = BigNumber.from("47568284600");
      expect(await math.twoPower(e, one)).to.eq(result);
    });
    it("2^-2.25", async function () {
      const e = BigNumber.from("-22500000000");
      const one = BigNumber.from(1).mul(decimals10);
      const result = BigNumber.from("2102241038");
      expect(await math.twoPower(e, one)).to.eq(result);
    });
    it("2^-0.6", async function () {
      const e = BigNumber.from("-6000000000");
      const one = BigNumber.from(1).mul(decimals10);
      const result = BigNumber.from("6626183216");
      expect(await math.twoPower(e, one)).to.eq(result);
    });
    it("2^2.96875", async function () {
      const e = BigNumber.from("29687500000");
      const one = BigNumber.from(1).mul(decimals10);
      const result = BigNumber.from("78285764964");
      expect(await math.twoPower(e, one)).to.eq(result);
    });
    it("2^2.99", async function () {
      const e = BigNumber.from("29900000000");
      const one = BigNumber.from(1).mul(decimals10);
      const result = BigNumber.from("78285764964");
      expect(await math.twoPower(e, one)).to.eq(result);
    });
    it("should fail on too small exponents", async function () {
      const e = BigNumber.from("-1011000000000");
      const one = BigNumber.from(1).mul(decimals10);
      await expect(math.twoPower(e, one)).to.be.revertedWith("Sigmoid: twoPower exp too big");
    });
    it("should fail on too large exponents", async function () {
      const e = BigNumber.from("1011000000000");
      const one = BigNumber.from(1).mul(decimals10);
      await expect(math.twoPower(e, one)).to.be.revertedWith("Sigmoid: twoPower exp too big");
    });
  });
});
