// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";

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
    /// @notice Given a tranche, looks up the collateral balance backing the tranche supply.
    /// @param t Address of the tranche token.
    /// @return The collateral balance and the tranche token supply.
    function getTrancheCollateralization(ITranche t) internal view returns (uint256, uint256) {
        IBondController bond = IBondController(t.bond());
        BondTranches memory bt = BondHelpers.getTranches(bond);
        uint256[] memory collateralBalances;
        uint256[] memory trancheSupplies;
        (collateralBalances, trancheSupplies) = BondHelpers.getTrancheCollateralizations(bond, bt);
        uint256 trancheIndex = BondTranchesHelpers.indexOf(bt, t);
        return (collateralBalances[trancheIndex], trancheSupplies[trancheIndex]);
    }
}
