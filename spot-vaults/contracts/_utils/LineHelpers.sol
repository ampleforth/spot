// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Line } from "../_interfaces/types/CommonTypes.sol";

/**
 *  @title LineHelpers
 *
 *  @notice Library with helper functions for the Line data structure.
 *
 */
library LineHelpers {
    using SafeCast for uint256;

    /// @dev We compute the average height of the line between {xL,xU}.
    function avgY(Line memory fn, uint256 xL, uint256 xU) internal pure returns (int256) {
        // if the line has a zero slope, return any y
        if (fn.y1 == fn.y2) {
            return fn.y2.toInt256();
        }

        // m = dlY/dlX
        // c = y2 - m . x2
        // Avg height => (yL + yU) / 2
        //            => m . ( xL + xU ) / 2 + c
        int256 dlY = fn.y2.toInt256() - fn.y1.toInt256();
        int256 dlX = fn.x2.toInt256() - fn.x1.toInt256();
        int256 c = fn.y2.toInt256() - ((fn.x2.toInt256() * dlY) / dlX);
        return ((((xL + xU).toInt256() * dlY) / (2 * dlX)) + c);
    }

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
}
