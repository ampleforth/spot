// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IPerpetualNoteTranche } from "../_interfaces/IPerpetualNoteTranche.sol";

interface IPricingStrategy {
    // @notice Computes the price of a given token.
    // @param perp The address of the perpetual note contract.
    // @param token The token to compute price of.
    // @return The price as a fixed point number with `decimals()`.
    function computePrice(IPerpetualNoteTranche perp, IERC20Upgradeable token) external view returns (uint256);

    // @notice Number of price decimals.
    function decimals() external view returns (uint8);
}
