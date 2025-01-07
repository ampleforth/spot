// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import { LineHelpers } from "../_utils/LineHelpers.sol";
import { Line, Range } from "../_interfaces/types/CommonTypes.sol";

contract LineHelpersTester {
    using LineHelpers for Line;

    function testComputeY(Line memory fn, uint256 x) public pure returns (int256) {
        return fn.computeY(x);
    }

    function testAvgY(
        Line memory fn,
        uint256 xL,
        uint256 xU
    ) public pure returns (int256) {
        return fn.avgY(xL, xU);
    }

    function testComputePiecewiseAvgY(
        Line memory fn1,
        Line memory fn2,
        Line memory fn3,
        Range memory xBreakPt,
        Range memory xRange
    ) public pure returns (int256) {
        return LineHelpers.computePiecewiseAvgY(fn1, fn2, fn3, xBreakPt, xRange);
    }
}
