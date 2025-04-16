// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

/**
 *  @title ERC20Helpers
 *
 *  @notice Library with helper functions for ERC20 Tokens.
 *
 */
library ERC20Helpers {
    using SafeERC20Upgradeable for IERC20Upgradeable;

    /// @notice Checks if the spender has sufficient allowance. If not, approves the maximum possible amount.
    function checkAndApproveMax(IERC20Upgradeable token, address spender, uint256 amount) internal {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance < amount) {
            token.safeApprove(spender, type(uint256).max);
        }
    }
}
