// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { TrancheData, TrancheDataHelpers, BondHelpers } from "../_utils/BondHelpers.sol";

import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";
import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";
import { IPricingStrategy } from "../_interfaces/IPricingStrategy.sol";

/*
 *  @title CDRLBPricingStrategy (CDRLB -> collateral to debt ratio - lower bound)
 *
 *  @notice Prices a given tranche as the max(tranche's CDR, ONE).
 *
 */
contract CDRLBPricingStrategy is IPricingStrategy {
    using BondHelpers for IBondController;
    using TrancheDataHelpers for TrancheData;

    uint8 private constant DECIMALS = 8;
    uint256 private constant ONE = 10**DECIMALS;

    /// @inheritdoc IPricingStrategy
    function computeTranchePrice(ITranche t) external view override returns (uint256) {
        IBondController bond = IBondController(t.bond());

        // NOTE: The maturity check here is an optimization.
        //       Non-equity tranches will never have a CDR > 1 before they mature.
        if (!bond.isMature()) {
            return ONE;
        }

        TrancheData memory td;
        uint256[] memory collateralBalances;
        uint256[] memory trancheSupplies;
        (td, collateralBalances, trancheSupplies) = bond.getTrancheCollateralizations();

        // tranche cdr = underlying collateral balance / tranche supply
        uint256 trancheIndex = td.getTrancheIndex(t);
        uint256 trancheCDR = (collateralBalances[trancheIndex] * (10**DECIMALS)) / trancheSupplies[trancheIndex];

        return MathUpgradeable.max(trancheCDR, ONE);
    }

    /// @inheritdoc IPricingStrategy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }
}
