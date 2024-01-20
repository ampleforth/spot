// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";
import { IPerpetualTranche } from "../_interfaces/IPerpetualTranche.sol";

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
    /// @dev If this function errs, it is guaranteed to err by overestimating, ie) when you tranche the estimated amount
    ///      of underlying tokens, then and use the senior tranches to mint perps,
    ///      you might end up minting slightly more than `perpAmtToMint`.
    /// @param perp The address of the perp contract.
    /// @param perpTVL The current TVL of perp.
    /// @param perpAmtToMint The required number of perp tokens to mint.
    /// @return underylingAmtToTranche The number of underlying tokens to tranche.
    /// @return seniorAmtToDeposit The number of minted seniors to then deposit into perp.
    /// @return depositBond The current deposit bond.
    /// @return depositTranche The current deposit tranche.
    function estimateUnderlyingAmtToTranche(
        IPerpetualTranche perp,
        uint256 perpTVL,
        uint256 perpAmtToMint
    )
        internal
        returns (
            uint256,
            uint256,
            IBondController,
            ITranche
        )
    {
        // We assume that:
        //  - Perp only accepts the "most" senior tranche from the deposit bond.
        //  - The deposit bond is NOT mature.
        //  - No fees are withheld while tranching

        // Get the minting bond and tranche data
        IBondController depositBond = perp.getDepositBond();
        ITranche depositTranche = depositBond.getSeniorTranche();
        (uint256 seniorTR, ) = depositBond.getSeniorJuniorRatios();

        uint256 bondCollateralBalance = IERC20Upgradeable(depositBond.collateralToken()).balanceOf(
            address(depositBond)
        );
        uint256 seniorAmtToDeposit = _estimateDepositAmt(
            perpTVL,
            perp.totalSupply(),
            depositTranche.totalSupply(),
            bondCollateralBalance,
            perpAmtToMint
        );

        uint256 underlyingAmtToTranche = seniorAmtToDeposit
            .mulDiv(bondCollateralBalance, depositBond.totalDebt(), MathUpgradeable.Rounding.Up)
            .mulDiv(TRANCHE_RATIO_GRANULARITY, seniorTR, MathUpgradeable.Rounding.Up);

        return (underlyingAmtToTranche, seniorAmtToDeposit, depositBond, depositTranche);
    }

    /// @notice This function estimates the amount of tranche tokens that need to be deposited
    ///         to mint the given number of perp tokens.
    /// @dev This function is guaranteed to over-estimate, ie) when you deposit the estimated amount
    ///      of tranche tokens tokens, you might end up minting slightly more than `perpAmtToMint`.
    ///      This function is an inverse of the `perp.computeMintAmt` function.
    /// @param perpTVL The current TVL of perp.
    /// @param perpSupply The total supply of perp tokens.
    /// @param seniorSupply The total supply of the most "senior" tranche of the deposit bond currently accepted by perp.
    /// @param bondCollateralBalance The parent bond's collateral balance.
    /// @param perpAmtToMint The required number of perp tokens to mint.
    /// @return seniorAmtToDeposit The number of seniors to deposit into perp.
    function _estimateDepositAmt(
        uint256 perpTVL,
        uint256 perpSupply,
        uint256 seniorSupply,
        uint256 bondCollateralBalance,
        uint256 perpAmtToMint
    ) private pure returns (uint256) {
        uint256 seniorClaim = MathUpgradeable.min(seniorSupply, bondCollateralBalance);
        return
            perpAmtToMint.mulDiv(perpTVL, perpSupply, MathUpgradeable.Rounding.Up).mulDiv(
                seniorSupply,
                seniorClaim,
                MathUpgradeable.Rounding.Up
            );
    }
}
