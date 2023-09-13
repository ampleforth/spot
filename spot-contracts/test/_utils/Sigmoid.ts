import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract } from "ethers";

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
        8,
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
});
