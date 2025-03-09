// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.20;

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { Line, Range } from "../_interfaces/CommonTypes.sol";
import { InvalidRange } from "../_interfaces/ProtocolErrors.sol";

/**
 * @title LineHelpers
 * @notice Provides helper functions for working with linear functions and computing piecewise averages.
 */
library LineHelpers {
    using MathUpgradeable for uint256;
    using SafeCastUpgradeable for uint256;
    using SafeCastUpgradeable for int256;

    /**
     * @notice Computes the weighted average y-value over a specified x-range for a piecewise linear function.
     * @dev This function considers two linear segments—`fn1` for x-values below the breakpoint (`xBreakPt`)
     *      and `fn2` for x-values above or equal to the breakpoint. If the entire x-range lies on one side of
     *      `xBreakPt`, it returns the average y-value computed over that range using the appropriate function.
     *      If the x-range spans `xBreakPt`, it computes a weighted average of the two sub-ranges, weighted by their lengths.
     * @param fn1 The linear function used for x-values below `xBreakPt`.
     * @param fn2 The linear function used for x-values above or equal to `xBreakPt`.
     * @param xRange The x-range over which to compute the average.
     * @param xBreakPt The x-coordinate where the piecewise function transitions from `fn1` to `fn2`.
     * @return yVal The computed weighted average y-value over the x-range.
     */
    function computePiecewiseAvgY(
        Line memory fn1,
        Line memory fn2,
        Range memory xRange,
        uint256 xBreakPt
    ) internal pure returns (int256 yVal) {
        if (xRange.lower > xRange.upper) {
            revert InvalidRange();
        }

        if (xRange.upper <= xBreakPt) {
            // Entire range is below the breakpoint.
            yVal = avgY(fn1, xRange.lower, xRange.upper);
        } else if (xRange.lower >= xBreakPt) {
            // Entire range is above or equal to the breakpoint.
            yVal = avgY(fn2, xRange.lower, xRange.upper);
        } else {
            // Range spans the breakpoint, so compute weighted average of both segments.
            uint256 len1 = xBreakPt - xRange.lower;
            uint256 len2 = xRange.upper - xBreakPt;
            int256 avg1 = avgY(fn1, xRange.lower, xBreakPt);
            int256 avg2 = avgY(fn2, xBreakPt, xRange.upper);
            yVal = (avg1 * int256(len1) + avg2 * int256(len2)) / int256(xRange.upper - xRange.lower);
        }
    }

    /**
     * @notice Computes the average y-value of a linear function over the interval [xL, xU].
     * @dev For a linear function defined as f(x) = m*x + c, the average value over [xL, xU] is:
     *      (f(xL) + f(xU)) / 2, which can be rewritten as m*((xL + xU)/2) + c.
     *      This function calculates the slope m using the two endpoints of the line and then computes
     *      the y-intercept c (using c = y2 - m*x2). If the line is horizontal (zero slope), it returns the
     *      constant y-value. Note that precision loss may occur due to integer division and type casting.
     *      Also, it is assumed that fn.x1 and fn.x2 are distinct to avoid division by zero.
     * @param fn The linear function defined by two points (with properties x1, y1, x2, y2).
     * @param xL The lower bound of the x-interval.
     * @param xU The upper bound of the x-interval.
     * @return The average y-value over the interval [xL, xU].
     */
    function avgY(Line memory fn, uint256 xL, uint256 xU) internal pure returns (int256) {
        // If the line is horizontal, return the constant y-value.
        if (fn.y1 == fn.y2) {
            return fn.y2.toInt256();
        }

        // Calculate the slope (m = deltaY / deltaX).
        int256 deltaY = fn.y2.toInt256() - fn.y1.toInt256();
        int256 deltaX = fn.x2.toInt256() - fn.x1.toInt256();

        // Calculate the y-intercept using one of the endpoints: c = y2 - m * x2.
        int256 c = fn.y2.toInt256() - ((fn.x2.toInt256() * deltaY) / deltaX);

        // Compute the average value over [xL, xU] as m*((xL + xU)/2) + c.
        return ((((xL + xU).toInt256() * deltaY) / (2 * deltaX)) + c);
    }
}
