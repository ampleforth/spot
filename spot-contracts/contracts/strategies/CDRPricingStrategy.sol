// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.15;

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { TrancheHelpers } from "../_utils/BondHelpers.sol";

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";
import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";
import { IPricingStrategy } from "../_interfaces/IPricingStrategy.sol";
import { IPerpetualTranche } from "../_interfaces/IPerpetualTranche.sol";

/*
 *  @title CDRPricingStrategy (CDR -> collateral to debt ratio)
 *
 *  @notice Prices the given tranche token based on it's CDR.
 *
 */
contract CDRPricingStrategy is IPricingStrategy {
    using TrancheHelpers for ITranche;

    uint8 private constant DECIMALS = 8;
    uint256 private constant UNIT_PRICE = 10**DECIMALS;

    /// @inheritdoc IPricingStrategy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    /// @inheritdoc IPricingStrategy
    // @dev Selective handling for collateral for mature tranches are held by the perp reserve.
    function computeMatureTranchePrice(
        IERC20Upgradeable /* collateralToken */,
        uint256 collateralBalance,
        uint256 debt
    ) external pure override returns (uint256) {
        return (collateralBalance * UNIT_PRICE) / debt;
    }

    /// @inheritdoc IPricingStrategy
    function computeTranchePrice(ITranche tranche) external view override returns (uint256) {
        (uint256 collateralBalance, uint256 debt) = tranche.getTrancheCollateralization();
        return (collateralBalance * UNIT_PRICE) / debt;
    }
}
