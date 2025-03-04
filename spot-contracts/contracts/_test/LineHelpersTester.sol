// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.20;

import { LineHelpers } from "../_utils/LineHelpers.sol";
import { Line } from "../_interfaces/CommonTypes.sol";

contract LineHelpersTester {
    // Expose the library functions as public wrappers for testing.
    function computePiecewiseAvgY(
        Line memory fn1,
        Line memory fn2,
        Range memory xRange,
        uint256 xBreakPt
    ) public pure returns (int256) {
        return LineHelpers.computePiecewiseAvgY(fn1, fn2, xRange, xBreakPt);
    }

    function avgY(Line memory fn, uint256 xL, uint256 xU) public pure returns (int256) {
        return LineHelpers.avgY(fn, xL, xU);
    }
}
