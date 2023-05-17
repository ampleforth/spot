// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";

/// @notice Expected tranche to be part of bond.
/// @param tranche Address of the tranche token.
error UnacceptableTranche(ITranche tranche);

struct BondTranches {
    ITranche[] tranches;
    uint256[] trancheRatios;
}

/**
 *  @title BondTranchesHelpers
 *
 *  @notice Library with helper functions for the bond's retrieved tranche data.
 *
 */
library BondTranchesHelpers {
    using MathUpgradeable for uint256;

    // Replicating value used here:
    // https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 private constant TRANCHE_RATIO_GRANULARITY = 1000;

    /// @notice Iterates through the tranche data to find the seniority index of the given tranche.
    /// @param bt The tranche data object.
    /// @param t The address of the tranche to check.
    /// @return the index of the tranche in the tranches array.
    function indexOf(BondTranches memory bt, ITranche t) internal pure returns (uint8) {
        for (uint8 i = 0; i < bt.tranches.length; i++) {
            if (bt.tranches[i] == t) {
                return i;
            }
        }
        revert UnacceptableTranche(t);
    }

    /// @notice For a given bond's tranche data and user address, computes the maximum number of each of the bond's tranches
    ///         the user is able to redeem before the bond's maturity. These tranche amounts necessarily match the bond's tranche ratios.
    /// @param bt The bond's tranche data.
    /// @param u The address to check balance for.
    /// @return An array of tranche token balances.
    function computeRedeemableTrancheAmounts(BondTranches memory bt, address u)
        internal
        view
        returns (uint256[] memory)
    {
        uint256[] memory redeemableAmts = new uint256[](bt.tranches.length);

        // Calculate how many underlying assets could be redeemed from each tranche balance,
        // assuming other tranches are not an issue, and record the smallest amount.
        uint256 minUnderlyingOut = type(uint256).max;
        uint8 i;
        for (i = 0; i < bt.tranches.length; i++) {
            uint256 d = bt.tranches[i].balanceOf(u).mulDiv(TRANCHE_RATIO_GRANULARITY, bt.trancheRatios[i]);
            if (d < minUnderlyingOut) {
                minUnderlyingOut = d;
            }

            // if one of the balances is zero, we return
            if (minUnderlyingOut == 0) {
                return redeemableAmts;
            }
        }

        for (i = 0; i < bt.tranches.length; i++) {
            redeemableAmts[i] = bt.trancheRatios[i].mulDiv(minUnderlyingOut, TRANCHE_RATIO_GRANULARITY);
        }

        return redeemableAmts;
    }

    /// @notice For a given bond's tranche data and tranche balances available, computes the maximum number of each of the bond's tranches
    ///         the user is able to redeem before the bond's maturity.
    ///         The returned tranche amounts necessarily match the bond's tranche ratios.
    /// @param bt The bond's tranche data.
    /// @param trancheBalsAvailable The tranche balance of each bond tranche available to be used for redemption.
    /// @return An array of tranche token balances.
    function computeRedeemableTrancheAmounts(BondTranches memory bt, uint256[] memory trancheBalsAvailable)
        internal
        view
        returns (uint256[] memory)
    {
        uint256[] memory redeemableAmts = new uint256[](bt.tranches.length);

        // Calculate how many underlying assets could be redeemed from each available tranche balance,
        // assuming other tranches are not an issue, and record the smallest amount.
        uint256 minUnderlyingOut = type(uint256).max;
        uint8 i;
        for (i = 0; i < bt.tranches.length; i++) {
            // the available tranche balance can never be above the tranche's total supply
            uint256 d = MathUpgradeable.min(trancheBalsAvailable[i], bt.tranches[i].totalSupply()).mulDiv(
                TRANCHE_RATIO_GRANULARITY,
                bt.trancheRatios[i]
            );
            if (d < minUnderlyingOut) {
                minUnderlyingOut = d;
            }

            // if one of the balances is zero, we return
            if (minUnderlyingOut == 0) {
                return redeemableAmts;
            }
        }

        for (i = 0; i < bt.tranches.length; i++) {
            redeemableAmts[i] = bt.trancheRatios[i].mulDiv(minUnderlyingOut, TRANCHE_RATIO_GRANULARITY);
        }

        return redeemableAmts;
    }
}
