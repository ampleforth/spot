// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";
import { UnacceptableTrancheLength } from "../_interfaces/ProtocolErrors.sol";

import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { BondTranches, BondTranchesHelpers } from "./BondTranchesHelpers.sol";
import { BondHelpers } from "./BondHelpers.sol";

/**
 *  @title TrancheHelpers
 *
 *  @notice Library with helper functions for tranche tokens.
 *
 */
library TrancheHelpers {
    /// @notice Given a tranche, calculates the claimable collateral balance backing the tranche supply.
    /// @param tranche Address of the tranche token.
    /// @param bond Address of the tranche's parent bond.
    /// @param collateralToken Address of the tranche's underlying collateral token.
    /// @return The collateral balance and the tranche token supply.
    function getTrancheCollateralization(
        ITranche tranche,
        IBondController bond,
        IERC20Upgradeable collateralToken
    ) internal view returns (uint256, uint256) {
        // When the tranche's parent bond is mature
        if (bond.isMature()) {
            uint256 trancheCollateralBalance = collateralToken.balanceOf(address(tranche));
            uint256 trancheSupply_ = tranche.totalSupply();
            return (trancheCollateralBalance, trancheSupply_);
        }

        // When the tranche's parent bond is not mature
        BondTranches memory bt = BondHelpers.getTranches(bond);

        // NOTE: We assume that the system only accepts bonds with 2 tranches
        require(bt.tranches.length == 2, "TrancheHelpers: Unexpected tranche count");
        uint256 trancheIndex = (bt.tranches[0] == tranche) ? 0 : 1;

        uint256 bondCollateralBalance = collateralToken.balanceOf(address(bond));
        uint256 trancheSupply = tranche.totalSupply();
        uint256 trancheClaim = 0;
        if (trancheIndex == 0) {
            trancheClaim = MathUpgradeable.min(trancheSupply, bondCollateralBalance);
        } else {
            uint256 seniorSupply = bt.tranches[0].totalSupply();
            uint256 seniorClaim = MathUpgradeable.min(seniorSupply, bondCollateralBalance);
            trancheClaim = bondCollateralBalance - seniorClaim;
        }
        return (trancheClaim, trancheSupply);
    }

    /// @notice Given a senior immature tranche, calculates the claimable collateral balance backing the tranche supply.
    /// @param seniorTranche Address of the tranche token.
    /// @param parentBondCollateralBalance The total amount of collateral backing the given tranche's parent bond.
    /// @return The collateral balance and the tranche token supply.
    function getImmatureSeniorTrancheCollateralization(ITranche seniorTranche, uint256 parentBondCollateralBalance)
        internal
        view
        returns (uint256, uint256)
    {
        uint256 seniorSupply = seniorTranche.totalSupply();
        uint256 seniorClaim = MathUpgradeable.min(seniorSupply, parentBondCollateralBalance);
        return (seniorClaim, seniorSupply);
    }
}
