// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Line } from "../_interfaces/types/CommonTypes.sol";

/**
 *  @title LineHelpers
 *
 *  @notice Library with helper functions for the Line data structure.
 *
 */
library LineHelpers {
    /// @dev We compute the average height of the line between {xL,xU}.
    ///      Clips the final y value between [yMin, yMax].
    function avgY(
        Line memory fn,
        uint256 xL,
        uint256 xU,
        uint256 yMin,
        uint256 yMax
    ) internal pure returns (uint256) {
        // if the line has a zero slope, return any y
        if (fn.y1 == fn.y2) {
            return _clip(fn.y1, yMin, yMax);
        }

        uint256 yL = computeY(fn, xL, 0, type(uint256).max);
        uint256 yU = computeY(fn, xU, 0, type(uint256).max);
        uint256 avgY_ = (yL + yU) / 2;
        return _clip(avgY_, yMin, yMax);
    }

    /// @dev This function computes y for a given x on the line (fn), bounded by yMin and yMax.
    function computeY(
        Line memory fn,
        uint256 x,
        uint256 yMin,
        uint256 yMax
    ) internal pure returns (uint256) {
        // m = (y2-y1)/(x2-x1)
        // y = y1 + m * (x-x1)

        // If the line has a zero slope, return a y value clipped between yMin and yMax
        if (fn.y1 == fn.y2) {
            return _clip(fn.y1, yMin, yMax);
        }

        // Determine if m is positive
        bool posM = (fn.y2 > fn.y1 && fn.x2 > fn.x1) || (fn.y2 < fn.y1 && fn.x2 < fn.x1);

        // Determine if (x - x1) is positive
        bool posDelX1 = (x > fn.x1);

        // Calculate absolute differences to ensure no underflow
        uint256 dlY = fn.y2 > fn.y1 ? (fn.y2 - fn.y1) : (fn.y1 - fn.y2);
        uint256 dlX = fn.x2 > fn.x1 ? (fn.x2 - fn.x1) : (fn.x1 - fn.x2);
        uint256 delX1 = posDelX1 ? (x - fn.x1) : (fn.x1 - x);

        // Calculate m * (x-x1)
        uint256 mDelX1 = Math.mulDiv(delX1, dlY, dlX);

        uint256 y = 0;

        // When m * (x-x1) is positive
        if ((posM && posDelX1) || (!posM && !posDelX1)) {
            y = fn.y1 + mDelX1;
        }
        // When m * (x-x1) is negative
        else {
            y = (fn.y1 > mDelX1) ? (fn.y1 - mDelX1) : yMin; // Ensures no underflow
        }

        // Return the y value clipped between yMin and yMax
        return _clip(y, yMin, yMax);
    }

    // @dev Helper function to clip y between min and max values
    function _clip(uint256 y, uint256 min, uint256 max) private pure returns (uint256) {
        y = (y <= min) ? min : y;
        y = (y >= max) ? max : y;
        return y;
    }
}
