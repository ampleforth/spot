// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

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
    function computePrice(IPerpetualTranche perp, IERC20Upgradeable token) external view override returns (uint256) {
        // NOTE: selective handling for collateral for mature tranches are held by the perp reserve
        return
            (token == perp.collateral())
                ? computeMatureTrancheCDR(perp, token)
                : computeTrancheCDR(ITranche(address(token)));
    }

    // @dev todo
    function computeTrancheCDR(ITranche tranche) internal view returns (uint256) {
        (uint256 collateralBalance, uint256 debt) = tranche.getTrancheCollateralization();
        return (collateralBalance * UNIT_PRICE) / debt;
    }

    // @dev todo
    function computeMatureTrancheCDR(IPerpetualTranche perp, IERC20Upgradeable collateral)
        internal
        view
        returns (uint256)
    {
        return (perp.reserveBalance(collateral) * UNIT_PRICE) / perp.matureTrancheBalance();
    }
}
