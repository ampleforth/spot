// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { BondHelpers } from "./BondHelpers.sol";

/**
 *  @title PerpHelpers
 *
 *  @notice Library with helper functions for the Perpetual tranche contract.
 *
 */
library PerpHelpers {
    using MathUpgradeable for uint256;
    using BondHelpers for IBondController;

    // Replicating value used here:
    // https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 private constant TRANCHE_RATIO_GRANULARITY = 1000;

    /// @notice This function estimates the amount of underlying tokens that need to be tranched
    ///         in order to mint the given amount of perp tokens.
    /// @dev If this function errs, it is guaranteed to err by overestimating, i.e) when you tranche the estimated amount
    ///      of underlying tokens, then and use the senior tranches to mint perps,
    ///      you might end up minting slightly more than `perpAmtToMint`.
    /// @param perpTVL The current TVL of perp.
    /// @param perpSupply The total supply of perp tokens.
    /// @param depositBondCollateralBalance The total collateral balance of perp's deposit bond.
    /// @param depositBondTotalDebt The total debt of perp's deposit bond.
    /// @param depositTrancheSupply The total supply of perp's deposit tranche.
    /// @param depositTrancheTR The tranche ratio of perp's deposit tranche.
    /// @param perpAmtToMint The required number of perp tokens to mint.
    /// @return underylingAmtToTranche The number of underlying tokens to tranche.
    /// @return seniorAmtToDeposit The number of minted seniors to then deposit into perp.
    function estimateUnderlyingAmtToTranche(
        uint256 perpTVL,
        uint256 perpSupply,
        uint256 depositBondCollateralBalance,
        uint256 depositBondTotalDebt,
        uint256 depositTrancheSupply,
        uint256 depositTrancheTR,
        uint256 perpAmtToMint
    ) internal pure returns (uint256, uint256) {
        // We assume that:
        //  - Perp only accepts one tranche from the deposit bond.
        //  - The deposit bond is NOT mature.
        //  - No fees are withheld while tranching

        // Calculate the seniors required to mint `perpAmtToMint` perps
        uint256 seniorAmtToDeposit = perpAmtToMint;
        if (perpSupply > 0) {
            seniorAmtToDeposit = seniorAmtToDeposit.mulDiv(perpTVL, perpSupply, MathUpgradeable.Rounding.Up);
        }
        if (depositTrancheSupply > 0) {
            seniorAmtToDeposit = seniorAmtToDeposit.mulDiv(
                depositTrancheSupply,
                MathUpgradeable.min(depositTrancheSupply, depositBondCollateralBalance),
                MathUpgradeable.Rounding.Up
            );
        }

        // Calculate the underlying require to mint `underlyingAmtToTranche` tranches
        uint256 underlyingAmtToTranche = seniorAmtToDeposit;
        if (depositBondTotalDebt > 0) {
            underlyingAmtToTranche = underlyingAmtToTranche.mulDiv(
                depositBondCollateralBalance,
                depositBondTotalDebt,
                MathUpgradeable.Rounding.Up
            );
        }
        underlyingAmtToTranche = underlyingAmtToTranche.mulDiv(
            TRANCHE_RATIO_GRANULARITY,
            depositTrancheTR,
            MathUpgradeable.Rounding.Up
        );

        return (underlyingAmtToTranche, seniorAmtToDeposit);
    }
}
