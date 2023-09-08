import { expect } from "chai";
import { ethers } from "hardhat";
import { constants, Contract } from "ethers";

import { toPercFixedPtAmt } from "../helpers";

describe.only("Sigmoid", function () {
  let math:Contract;
  async function cmp(x, y, lower, upper, growth){
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
    before(async function(){
      const MathTester = await ethers.getContractFactory("MathTester");
      math = await MathTester.deploy();
      await math.deployed();
    })
    it("should return sigmoid(x)", async function () {
      await cmp(1, 0, -0.01, 0.05, 4);
      await cmp(1.01, 0.00018181, -0.01, 0.05, 4);
      await cmp(1.02, 0.00036624, -0.01, 0.05, 4);
      await cmp(1.1, 0.00235705, -0.01, 0.05, 4);
      await cmp(1.5, 0.01666666, -0.01, 0.05, 4);
      await cmp(2, 0.03571428, -0.01, 0.05, 4);
      //await cmp(10, 0, -0.01, 0.05, 0.03);
    });
  });
});
