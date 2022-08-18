// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

interface IYieldStrategy {
    // @notice Computes the yield to be applied to a given tranche token.
    // @param tranche The tranche token to compute yield for.
    // @return The yield as a fixed point number with `decimals()`.
    function computeTrancheYield(IERC20Upgradeable tranche) external view returns (uint256);

    // @notice Number of yield decimals.
    function decimals() external view returns (uint8);
}
