// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";
import { IPricingStrategy } from "../_interfaces/IPricingStrategy.sol";

/**
 *  @title UnitPricingStrategy
 *
 *  @notice All tranche tokens are assumed to have a price of 1.
 *
 */
contract UnitPricingStrategy is IPricingStrategy {
    uint8 private constant DECIMALS = 8;
    uint256 private constant UNIT_PRICE = 10**DECIMALS;

    /// @inheritdoc IPricingStrategy
    function computeTranchePrice(
        ITranche /* tranche */
    ) external pure override returns (uint256) {
        return UNIT_PRICE;
    }

    /// @inheritdoc IPricingStrategy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }
}
