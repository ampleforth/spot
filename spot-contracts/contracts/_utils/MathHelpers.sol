// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.20;

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";

/**
 *  @title MathHelpers
 *
 *  @notice Library with helper functions for math operations.
 *
 */
library MathHelpers {
    using MathUpgradeable for uint256;

    /// @dev Clips a given unsigned integer between provided min and max unsigned integer.
    function clip(uint256 n, uint256 min, uint256 max) internal pure returns (uint256) {
        return MathUpgradeable.min(MathUpgradeable.max(n, min), max);
    }
}
