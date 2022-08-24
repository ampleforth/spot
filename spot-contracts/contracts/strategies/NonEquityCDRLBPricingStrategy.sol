// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";
import { IPricingStrategy } from "../_interfaces/IPricingStrategy.sol";

/**
 *  @title NonEquityCDRLBPricingStrategy (CDRLB -> collateral to debt ratio - lower bound)
 *
 *  @notice Prices a given tranche as the max(tranche's CDR, UNIT_PRICE).
 *
 *  @dev This is only to be used for non-equity tranches.
 *
 */
contract NonEquityCDRLBPricingStrategy is IPricingStrategy {
    uint8 private constant DECIMALS = 8;
    uint256 private constant UNIT_PRICE = 10**DECIMALS;

    /// @inheritdoc IPricingStrategy
    function computeTranchePrice(
        ITranche /* tranche */
    ) external pure override returns (uint256) {
        // NOTE: The is an optimization. Non-equity tranches will never have a CDR > 1 before they mature.
        return UNIT_PRICE;
    }

    /// @inheritdoc IPricingStrategy
    function computeMatureTranchePrice(
        IERC20Upgradeable, /* collateralToken */
        uint256 collateralBalance,
        uint256 debt
    ) external pure override returns (uint256) {
        uint256 trancheCDR = (debt > 0) ? ((collateralBalance * UNIT_PRICE) / debt) : UNIT_PRICE;
        return MathUpgradeable.max(trancheCDR, UNIT_PRICE);
    }

    /// @inheritdoc IPricingStrategy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }
}
