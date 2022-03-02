// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

/*
 *  @title SignedMathHelpers
 *
 *  @notice Library with helper functions for signed integer math.
 *
 */
library SignedMathHelpers {
    function sign(int256 a) internal pure returns (int256) {
        return (a >= 0) ? int256(1) : int256(-1);
    }
}
