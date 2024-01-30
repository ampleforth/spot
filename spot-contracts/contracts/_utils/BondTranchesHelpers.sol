// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { UnacceptableTrancheLength } from "../_interfaces/ProtocolErrors.sol";

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
        // NOTE: This implementation assumes the bond has only two tranches.
        if (bt.tranches.length != 2) {
            revert UnacceptableTrancheLength();
        }

        uint256[] memory trancheAmtsReq = new uint256[](2);

        // We compute the amount of seniors required using all the juniors
        trancheAmtsReq[1] = trancheBalsAvailable[1] - (trancheBalsAvailable[1] % bt.trancheRatios[1]);
        trancheAmtsReq[0] = (trancheAmtsReq[1] * bt.trancheRatios[0]) / bt.trancheRatios[1];

        // If enough seniors aren't available, we compute the amount of juniors required using all the seniors
        if (trancheAmtsReq[0] > trancheBalsAvailable[0]) {
            trancheAmtsReq[0] = trancheBalsAvailable[0] - (trancheBalsAvailable[0] % bt.trancheRatios[0]);
            trancheAmtsReq[1] = (trancheAmtsReq[0] * bt.trancheRatios[1]) / bt.trancheRatios[0];
        }

        return trancheAmtsReq;
    }
}
