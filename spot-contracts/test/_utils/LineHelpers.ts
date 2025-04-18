import { ethers } from "hardhat";
import { expect } from "chai";
import { Contract } from "ethers";

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Range {
  lower: number;
  upper: number;
}

describe("LineHelpers", function () {
  let lineHelpersTest: Contract;

  before(async function () {
    const TestFactory = await ethers.getContractFactory("LineHelpersTester");
    lineHelpersTest = await TestFactory.deploy();
  });

  describe("computePiecewiseAvgY", function () {
    it("should compute average when xRange is entirely below the breakpoint", async function () {
      // Branch: xRange.upper <= xBreakPt
      // Use fn1: f(x) = 2x + 5, defined by points (0,5) and (10,25)
      // Use fn2: arbitrary (not used in this branch), e.g. f(x) = 3x + 7
      // xRange: lower = 10, upper = 20, xBreakPt = 30
      // Expected: avgY(fn1, [10,20]) = 2*((10+20)/2) + 5 = 35.
      const fn1: Line = { x1: 0, y1: 5, x2: 10, y2: 25 };
      const fn2: Line = { x1: 0, y1: 7, x2: 10, y2: 37 };
      const xRange: Range = { lower: 10, upper: 20 };
      const xBreakPt = 30;
      const result = await lineHelpersTest.computePiecewiseAvgY(fn1, fn2, xRange, xBreakPt);
      expect(result).to.equal(35);
    });

    it("should compute average when xRange is entirely above the breakpoint", async function () {
      // Branch: xRange.lower >= xBreakPt
      // Use fn2: f(x) = 3x + 7, defined by (0,7) and (10,37)
      // xRange: lower = 40, upper = 50, xBreakPt = 30
      // Expected: avgY(fn2, [40,50]) = 3*((40+50)/2) + 7 = 142.
      const fn1: Line = { x1: 0, y1: 5, x2: 10, y2: 25 }; // dummy function
      const fn2: Line = { x1: 0, y1: 7, x2: 10, y2: 37 };
      const xRange: Range = { lower: 40, upper: 50 };
      const xBreakPt = 30;
      const result = await lineHelpersTest.computePiecewiseAvgY(fn1, fn2, xRange, xBreakPt);
      expect(result).to.equal(142);
    });

    it("should compute weighted average when xRange spans the breakpoint", async function () {
      // Branch: xRange.lower < xBreakPt < xRange.upper
      // Use fn1: f(x) = 2x + 5 for [20,30]
      // Use fn2: f(x) = 3x + 7 for [30,40]
      // xRange: lower = 20, upper = 40, xBreakPt = 30.
      // Compute averages:
      //  avgY(fn1, [20,30]) = 2*((20+30)/2) + 5 = 2*25 + 5 = 55.
      //  avgY(fn2, [30,40]) = 3*((30+40)/2) + 7 = 3*35 + 7 = 112.
      // Weighted average = (55 * (30-20) + 112 * (40-30)) / (40-20)
      //                  = (55*10 + 112*10) / 20 = 1670/20 = 83 (integer division truncates any fraction).
      const fn1: Line = { x1: 0, y1: 5, x2: 10, y2: 25 };
      const fn2: Line = { x1: 0, y1: 7, x2: 10, y2: 37 };
      const xRange: Range = { lower: 20, upper: 40 };
      const xBreakPt = 30;
      const result = await lineHelpersTest.computePiecewiseAvgY(fn1, fn2, xRange, xBreakPt);
      expect(result).to.equal(83);
    });
  });

  describe("avgY", function () {
    it("should return the constant y-value for a horizontal line", async function () {
      // For a horizontal line f(x) = constant, avgY should return that constant.
      // Define a horizontal line f(x) = 10 with points (0,10) and (10,10)
      // For any x-range (here [5,15]), the average is 10.
      const horizontalLine: Line = { x1: 0, y1: 10, x2: 10, y2: 10 };
      const xL = 5;
      const xU = 15;
      const result = await lineHelpersTest.avgY(horizontalLine, xL, xU);
      expect(result).to.equal(10);
    });

    it("should compute average correctly for a non-horizontal line with fractional average", async function () {
      // Test a line with a fractional average result.
      // Define line: f(x) = x + 1, using points (0,1) and (3,4)
      // For x-range [1,2]:
      //   m = (4-1)/(3-0) = 1, c = 4 - 1*3 = 1.
      //   Expected average = 1*((1+2)/2) + 1 = 1*1 + 1 = 2 (due to integer division truncation).
      const line: Line = { x1: 0, y1: 1, x2: 3, y2: 4 };
      const xL = 1;
      const xU = 2;
      const result = await lineHelpersTest.avgY(line, xL, xU);
      expect(result).to.equal(2);
    });
  });
});
