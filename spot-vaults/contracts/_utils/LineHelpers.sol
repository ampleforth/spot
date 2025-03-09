// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { MathHelpers } from "./MathHelpers.sol";
import { Line, Range } from "../_interfaces/types/CommonTypes.sol";
import { InvalidRange, UnexpectedRangeDelta } from "../_interfaces/errors/CommonErrors.sol";

/**
 *  @title LineHelpers
 *
 *  @notice Library with helper functions for the Line data structure.
 *
 */
library LineHelpers {
    using Math for uint256;
    using MathHelpers for uint256;
    using SafeCast for uint256;
    using SafeCast for int256;

    /// @dev This function computes y for a given x on the line (fn).
    function computeY(Line memory fn, uint256 x) internal pure returns (int256) {
        // If the line has a zero slope, return any y.
        if (fn.y1 == fn.y2) {
            return fn.y1.toInt256();
        }

        // m = dlY/dlX
        // c = y2 - m . x2
        // y = m . x + c
        int256 dlY = fn.y2.toInt256() - fn.y1.toInt256();
        int256 dlX = fn.x2.toInt256() - fn.x1.toInt256();
        int256 c = fn.y2.toInt256() - ((fn.x2.toInt256() * dlY) / dlX);
        return (((x.toInt256() * dlY) / dlX) + c);
    }

    /// @dev We compute the average height of the line between {xL,xU}.
    function avgY(Line memory fn, uint256 xL, uint256 xU) internal pure returns (int256) {
        // if the line has a zero slope, return any y
        if (fn.y1 == fn.y2) {
            return fn.y2.toInt256();
        }

        // NOTE: There is some precision loss because we cast to int and back
        // m = dlY/dlX
        // c = y2 - m . x2
        // Avg height => (yL + yU) / 2
        //            => m . ( xL + xU ) / 2 + c
        int256 dlY = fn.y2.toInt256() - fn.y1.toInt256();
        int256 dlX = fn.x2.toInt256() - fn.x1.toInt256();
        int256 c = fn.y2.toInt256() - ((fn.x2.toInt256() * dlY) / dlX);
        return ((((xL + xU).toInt256() * dlY) / (2 * dlX)) + c);
    }

    /// @notice Computes a piecewise average value (yVal) over the domain xRange,
    ///         based on three linear segments (fn1, fn2, fn3) that switch at xBreakPt.
    /// @dev    The function splits the input range into up to three segments, then
    ///         calculates a weighted average in each segment using the corresponding
    ///         piecewise function.
    /// @dev AI-GENERATED
    /// @param fn1 Piecewise linear function used when x is below xBreakPt.lower.
    /// @param fn2 Piecewise linear function used when x is between xBreakPt.lower and xBreakPt.upper.
    /// @param fn3 Piecewise linear function used when x is above xBreakPt.upper.
    /// @param xBreakPt Range denoting the lower and upper x thresholds.
    /// @param xRange   The actual x-range over which we want to compute an averaged value.
    /// @return yVal  The computed piecewise average.
    function computePiecewiseAvgY(
        Line memory fn1,
        Line memory fn2,
        Line memory fn3,
        Range memory xBreakPt,
        Range memory xRange
    ) internal pure returns (int256) {
        int256 xl = xRange.lower.toInt256();
        int256 xu = xRange.upper.toInt256();
        int256 bpl = xBreakPt.lower.toInt256();
        int256 bpu = xBreakPt.upper.toInt256();

        // Validate range inputs (custom errors omitted here).
        if (xl > xu) revert InvalidRange();
        if (xl <= bpl && xu > bpu) revert UnexpectedRangeDelta();

        // ---------------------------
        // CASE A: Entire xRange below xBreakPt.lower → use fn1
        if (xu <= bpl) {
            return avgY(fn1, xRange.lower, xRange.upper);
        }

        // CASE B: xRange straddles bpl but still <= bpu
        // Blend fn1 and fn2
        if (xl <= bpl && xu <= bpu) {
            // w1 = portion in fn1, w2 = portion in fn2
            int256 w1 = bpl - xl;
            int256 w2 = xu - bpl;
            // Weighted average across two sub-ranges
            return
                (avgY(fn1, xRange.lower, xBreakPt.lower) *
                    w1 +
                    avgY(fn2, xBreakPt.lower, xRange.upper) *
                    w2) / (w1 + w2);
        }

        // CASE C: Fully within [bpl, bpu] → use fn2
        if (xl > bpl && xu <= bpu) {
            return avgY(fn2, xRange.lower, xRange.upper);
        }

        // CASE D: xRange straddles xBreakPt.upper → blend fn2 and fn3
        if (xl <= bpu && xu > bpu) {
            int256 w1 = bpu - xl;
            int256 w2 = xu - bpu;
            return
                (avgY(fn2, xRange.lower, xBreakPt.upper) *
                    w1 +
                    avgY(fn3, xBreakPt.upper, xRange.upper) *
                    w2) / (w1 + w2);
        }

        // CASE E: Entire xRange above xBreakPt.upper → use fn3
        // (if none of the above conditions matched, we must be here)
        return avgY(fn3, xRange.lower, xRange.upper);
    }
}
