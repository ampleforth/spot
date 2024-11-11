// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/**
 *  @title MathHelpers
 *
 *  @notice Library with helper functions for math operations.
 *
 */
library MathHelpers {
    using Math for uint256;
    using SafeCast for int256;

    /// @dev Clips a given integer number between provided min and max unsigned integer.
    function clip(int256 n, uint256 min, uint256 max) internal pure returns (uint256) {
        return Math.min(Math.max((n >= 0) ? n.toUint256() : 0, min), max);
    }
}
