import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract } from "ethers";

// AI generated
describe("LineHelpers", function () {
  let testLineHelpers: Contract;

  // Deploy the test contract before running the suite
  before(async () => {
    const LineHelpersTester = await ethers.getContractFactory("LineHelpersTester");
    testLineHelpers = await LineHelpersTester.deploy();
  });

  //
  // Helper for constructing the `Line` struct in TypeScript
  //
  function makeLine(x1: number, y1: number, x2: number, y2: number) {
    return { x1, y1, x2, y2 };
  }

  //
  // Helper for constructing the `Range` struct in TypeScript
  //
  function makeRange(lower: number, upper: number) {
    return { lower, upper };
  }

  // ---------------------------------------------------------------------
  // 1. Tests for `avgY`
  // ---------------------------------------------------------------------
  describe("avgY", function () {
    it("handles zero slope correctly", async () => {
      const fn = makeLine(0, 100, 10, 100); // zero slope
      const yAvg = await testLineHelpers.testAvgY(fn, 0, 10);
      expect(yAvg).to.equal(100);

      // Subrange
      const yAvgSub = await testLineHelpers.testAvgY(fn, 2, 5);
      expect(yAvgSub).to.equal(100);
    });

    it("handles positive slope", async () => {
      // slope = (200 - 100)/(10 - 0) = 10
      const fn = makeLine(0, 100, 10, 200);
      // avg from x=0..10 => (100 + 200)/2 = 150
      const yAvg = await testLineHelpers.testAvgY(fn, 0, 10);
      expect(yAvg).to.equal(150);
    });

    it("handles negative slope", async () => {
      // slope = (50 - 100)/(10 - 0) = -5
      const fn = makeLine(0, 100, 10, 50);
      // avg from x=0..10 => (100 + 50)/2 = 75
      const yAvg = await testLineHelpers.testAvgY(fn, 0, 10);
      expect(yAvg).to.equal(75);
    });

    it("handles partial subrange", async () => {
      // slope = 10
      // from x=2 => y=120, x=5 => y=150 => avg=135
      const fn = makeLine(0, 100, 10, 200);
      const yAvg = await testLineHelpers.testAvgY(fn, 2, 5);
      expect(yAvg).to.equal(135);
    });
  });

  // ---------------------------------------------------------------------
  // 2. Tests for `computeY`
  // ---------------------------------------------------------------------
  describe("computeY", function () {
    it("handles zero slope", async () => {
      const fn = makeLine(0, 100, 10, 100);
      const yAt5 = await testLineHelpers.testComputeY(fn, 5);
      expect(yAt5).to.equal(100);
    });

    it("handles positive slope", async () => {
      // slope=10 => line eq: y=10*x + 100
      const fn = makeLine(0, 100, 10, 200);
      const yAt5 = await testLineHelpers.testComputeY(fn, 5);
      expect(yAt5).to.equal(150);
    });

    it("handles negative slope", async () => {
      // slope=-5 => line eq: y=-5*x + 100
      const fn = makeLine(0, 100, 10, 50);
      const yAt2 = await testLineHelpers.testComputeY(fn, 2);
      expect(yAt2).to.equal(90);
    });
  });

  // ---------------------------------------------------------------------
  // 3. Tests for `computePiecewiseAvgY`
  // ---------------------------------------------------------------------
  describe("computePiecewiseAvgY", function () {
    // Reusable lines and ranges in multiple tests
    let fn1, fn2, fn3;
    let xBreakPt;

    beforeEach(async () => {
      fn1 = makeLine(0, 50, 10, 100);
      fn2 = makeLine(0, 100, 10, 200);
      fn3 = makeLine(0, 200, 10, 300);
      xBreakPt = makeRange(2, 8);
    });

    it("reverts when xRange.lower > xRange.upper", async () => {
      const xRange = makeRange(10, 5); // invalid
      await expect(
        testLineHelpers.testComputePiecewiseAvgY(fn1, fn2, fn3, xBreakPt, xRange),
      ).to.be.revertedWithCustomError(testLineHelpers, "InvalidRange");
    });

    it("reverts when xRange straddles from below to above breakpoints", async () => {
      // crosses [2..8] from 1..9
      const xRange = makeRange(1, 9);
      await expect(
        testLineHelpers.testComputePiecewiseAvgY(fn1, fn2, fn3, xBreakPt, xRange),
      ).to.be.revertedWithCustomError(testLineHelpers, "UnexpectedRangeDelta");
    });

    it("uses fn1 entirely when xRange is below xBreakPt.lower", async () => {
      // xBreakPt= [2..8], xRange= [0..1]
      const localBreak = makeRange(2, 8);
      const localRange = makeRange(0, 1);
      const localFn1 = makeLine(0, 50, 10, 70); // slope ~ 2/unit
      const localFn2 = makeLine(10, 60, 20, 200);
      const localFn3 = makeLine(20, 200, 30, 500);

      const result = await testLineHelpers.testComputePiecewiseAvgY(
        localFn1,
        localFn2,
        localFn3,
        localBreak,
        localRange,
      );
      expect(result).to.equal(51);
    });

    it("uses fn3 entirely when xRange is above xBreakPt.upper", async () => {
      // xBreakPt= [2..8], xRange= [9..10]
      const localBreak = makeRange(2, 8);
      const localRange = makeRange(9, 10);

      // fn3 from (8,200) to (10,300)
      // y(9)=250, y(10)=300 => avg=275
      const localFn1 = makeLine(0, 0, 10, 0);
      const localFn2 = makeLine(10, 0, 20, 100);
      const localFn3 = makeLine(8, 200, 10, 300);

      const result = await testLineHelpers.testComputePiecewiseAvgY(
        localFn1,
        localFn2,
        localFn3,
        localBreak,
        localRange,
      );
      expect(result).to.equal(275);
    });

    it("splits range across fn1 & fn2 when straddling xBreakPt.lower", async () => {
      // xBreakPt= [2..8], xRange= [1..5]
      const localBreak = makeRange(2, 8);
      const localRange = makeRange(1, 5);

      // fn1 => (0,10)->(2,30), slope=10
      //   x=1 => y=20, x=2 => y=30 => avg=25
      // fn2 => (2,30)->(8,90), slope=10
      //   x=2 => y=30, x=5 => y=60 => avg=45
      // Weighted sum => (25*1) + (45*3)=160 => /4=40
      const localFn1 = makeLine(0, 10, 2, 30);
      const localFn2 = makeLine(2, 30, 8, 90);
      const localFn3 = makeLine(8, 90, 10, 100);

      const result = await testLineHelpers.testComputePiecewiseAvgY(
        localFn1,
        localFn2,
        localFn3,
        localBreak,
        localRange,
      );
      expect(result).to.equal(40);
    });

    it("splits range across fn2 & fn3 when straddling xBreakPt.upper", async () => {
      // xBreakPt= [2..8], xRange= [5..9]
      const localBreak = makeRange(2, 8);
      const localRange = makeRange(5, 9);

      // fn2 => (2,30)->(8,90), slope=10
      //   x=5 => y=60, x=8 => y=90 => avg=75
      // fn3 => (8,90)->(10,110), slope=10
      //   x=8 => y=90, x=9 => y=100 => avg=95
      // Weighted sum => (75*3)+(95*1)=320 => /4=80
      const localFn1 = makeLine(0, 10, 2, 30);
      const localFn2 = makeLine(2, 30, 8, 90);
      const localFn3 = makeLine(8, 90, 10, 110);

      const result = await testLineHelpers.testComputePiecewiseAvgY(
        localFn1,
        localFn2,
        localFn3,
        localBreak,
        localRange,
      );
      expect(result).to.equal(80);
    });

    it("uses only fn2 when xRange is fully within breakpoints", async () => {
      // xBreakPt= [2..8], xRange= [3..7]
      // fn2 => (2,20)->(8,80), slope=10
      //   x=3 => y=30, x=7 => y=70 => avg=50
      const localBreak = makeRange(2, 8);
      const localRange = makeRange(3, 7);

      const localFn1 = makeLine(0, 10, 2, 20);
      const localFn2 = makeLine(2, 20, 8, 80);
      const localFn3 = makeLine(8, 80, 10, 100);

      const result = await testLineHelpers.testComputePiecewiseAvgY(
        localFn1,
        localFn2,
        localFn3,
        localBreak,
        localRange,
      );
      expect(result).to.equal(50);
    });

    it("handles zero-length xRange exactly at xBreakPt.lower", async () => {
      // xRange= [2..2] => a single x-value
      // Expect to take fn1 vs fn2?
      // Typically, a single x==2 is the boundary => By definition,
      //   if `upper <= breakPt.lower` => we are in fn1
      //   OR if `lower >= breakPt.lower` => we might be in fn2.
      // This might require clarity in your design or the function.
      // For demonstration, let's assume we define:
      //   if x == bpl => treat as fn2 (since "below" is strictly < bpl).
      const localRange = makeRange(2, 2);
      // We'll set the lines so we can easily compute y(2).
      const localFn1 = makeLine(0, 10, 2, 30); // y(2)=30
      const localFn2 = makeLine(2, 30, 8, 90); // y(2)=30
      // We'll see which one the code picks based on your piecewise logic
      // For a zero-length range, the "average" is just y(2).

      const result = await testLineHelpers.testComputePiecewiseAvgY(
        localFn1,
        localFn2,
        fn3,
        xBreakPt,
        localRange,
      );
      // Depending on your code logic:
      // If your code lumps x=breakPt.lower in fn1, expect 30
      // If lumps it in fn2, also 30 in this example (coincidentally the same).
      // If you want to ensure it's definitely fn2, you could change lines:
      //   localFn2 = makeLine(2, 50, 8, 90) => y(2)=50
      //   Then check if result==50 => means it's definitely fn2.
      expect(result).to.equal(30);
    });

    it("handles zero-length xRange exactly at xBreakPt.upper", async () => {
      // xBreakPt= [2..8], xRange= [8..8]
      // Single point at x=8
      // By your design, x=8 could be considered "upper edge" of fn2 or "start" of fn3.
      const localRange = makeRange(8, 8);

      // Distinguish the lines so we can confirm which is used
      const localFn2 = makeLine(2, 20, 8, 80); // y(8)=80
      const localFn3 = makeLine(8, 999, 10, 1000); // y(8)=999

      const result = await testLineHelpers.testComputePiecewiseAvgY(
        fn1,
        localFn2,
        localFn3,
        xBreakPt,
        localRange,
      );
      // Depending on how your piecewise function is coded:
      // - If x=breakPt.upper is still "within" fn2 => expect 80
      // - If your code lumps it with fn3 => expect 999
      // In *your* logic, it looks like "if (xRange.lower <= bpu && xRange.upper > bpu)"
      // is the condition for partial in fn2/fn3.
      // But here, 8..8 is exactly <=bpu and not >bpu => might remain in fn2
      // So I'd expect 80 given the code snippet above.
      expect(result).to.equal(80);
    });

    it("uses only fn2 when xRange = xBreakPt exactly", async () => {
      // xRange= [2..8], which is exactly the break range
      // Should use fn2 entirely, no partial
      const localRange = makeRange(2, 8);
      // We'll define fn2 so we can test the integral average from 2..8
      // Let's pick slope=10 again =>
      // y(2)=20, y(8)=80 => average => (20+80)/2=50
      const localFn2 = makeLine(2, 20, 8, 80);

      const result = await testLineHelpers.testComputePiecewiseAvgY(
        fn1,
        localFn2,
        fn3,
        xBreakPt,
        localRange,
      );
      // If the code lumps [2..8] wholly into fn2, we get 50
      expect(result).to.equal(50);
    });
  });
});
