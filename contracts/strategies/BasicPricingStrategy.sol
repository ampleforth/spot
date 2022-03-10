// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;
import { ITranche } from "../_interfaces/button-wood/ITranche.sol";
import { IPricingStrategy } from "../_interfaces/IPricingStrategy.sol";

/*
 *  @title BasicPricingStrategy
 *
 *  @notice Basic pricing strategy, prices tranches 1:1 with the underlying collateral.
 *
 */
contract BasicPricingStrategy is IPricingStrategy {
    uint8 private constant DECIMALS = 18;

    /// @inheritdoc IPricingStrategy
    function computeTranchePrice(ITranche t) external pure override returns (uint256) {
        return (10**DECIMALS);
    }

    /// @inheritdoc IPricingStrategy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }
}
