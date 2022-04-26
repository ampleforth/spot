// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";
import { IPricingStrategy } from "../_interfaces/IPricingStrategy.sol";

/*
 *  @title UnitPricingStrategy
 *
 *  @notice Basic pricing strategy, prices tranches 1:1 with the underlying collateral.
 *
 */
contract UnitPricingStrategy is IPricingStrategy {
    uint8 private constant DECIMALS = 8;
    uint256 private constant ONE = 10**DECIMALS;

    /// @inheritdoc IPricingStrategy
    // solhint-disable-next-line no-unused-vars
    function computeTranchePrice(ITranche t) external pure override returns (uint256) {
        return ONE;
    }

    /// @inheritdoc IPricingStrategy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }
}
