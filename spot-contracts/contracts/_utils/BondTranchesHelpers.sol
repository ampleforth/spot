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
        uint256[] memory trancheBalsAvailable = new uint256[](bt.tranches.length);
        for (uint8 i = 0; i < bt.tranches.length; i++) {
            trancheBalsAvailable[i] = bt.tranches[i].balanceOf(u);
        }
        return computeRedeemableTrancheAmounts(bt, trancheBalsAvailable);
    }

    /// @notice For a given bond's tranche data and tranche balances available, computes the maximum number of each of the bond's tranches
    ///         the user is able to redeem before the bond's maturity.
    ///         The returned tranche amounts necessarily match the bond's tranche ratios.
    /// @param bt The bond's tranche data.
    /// @param trancheBalsAvailable The tranche balance of each bond tranche available to be used for redemption.
    /// @return An array of tranche token balances.
    function computeRedeemableTrancheAmounts(BondTranches memory bt, uint256[] memory trancheBalsAvailable)
        internal
        pure
        returns (uint256[] memory)
    {
        uint256[] memory redeemableAmts = new uint256[](bt.tranches.length);

        // We Calculate how many underlying assets could be redeemed from each available tranche balance,
        // assuming other tranches are not an issue, and record the smallest amount.
        //
        // Usually one tranche balance is the limiting factor, we first loop through to identify
        // it by figuring out the one which has the least `trancheBalance/trancheRatio`.
        //
        uint256 minBalanceToTrancheRatio = type(uint256).max;
        uint8 i;
        for (i = 0; i < bt.tranches.length; i++) {
            // NOTE: We round the avaiable balance down to the nearest multiple of the
            //       tranche ratio. This ensures that `minBalanceToTrancheRatio`
            //       can be represented without loss as a fixedPt number.
            uint256 bal = trancheBalsAvailable[i] - (trancheBalsAvailable[i] % bt.trancheRatios[i]);

            uint256 d = bal.mulDiv(TRANCHE_RATIO_GRANULARITY, bt.trancheRatios[i]);
            if (d < minBalanceToTrancheRatio) {
                minBalanceToTrancheRatio = d;
            }

            // if one of the balances is zero, we return
            if (minBalanceToTrancheRatio <= 0) {
                return (redeemableAmts);
            }
        }

        // Now that we have `minBalanceToTrancheRatio`, we compute the redeemable amounts.
        for (i = 0; i < bt.tranches.length; i++) {
            redeemableAmts[i] = bt.trancheRatios[i].mulDiv(minBalanceToTrancheRatio, TRANCHE_RATIO_GRANULARITY);
        }

        return redeemableAmts;
    }
}
