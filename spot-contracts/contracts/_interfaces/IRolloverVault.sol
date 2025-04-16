// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IVault } from "./IVault.sol";
import { SubscriptionParams, TokenAmount } from "./CommonTypes.sol";

interface IRolloverVault is IVault {
    /// @notice Gradually transfers value between the perp and vault, to bring the system back into balance.
    /// @dev The rebalance function can be executed at-most once a day.
    function rebalance() external;

    /// @notice Batch operation to mint both perp and rollover vault tokens.
    /// @param underlyingAmtIn The amount of underlying tokens to be tranched.
    /// @return perpAmt The amount of perp tokens minted.
    /// @return vaultNoteAmt The amount of vault notes minted.
    function mint2(uint256 underlyingAmtIn) external returns (uint256 perpAmt, uint256 vaultNoteAmt);

    /// @notice Batch operation to redeem both perp and rollover vault tokens for the underlying collateral and tranches.
    /// @param perpAmtAvailable The amount of perp tokens available to redeem.
    /// @param vaultNoteAmtAvailable The amount of vault notes available to redeem.
    /// @return perpAmtBurnt The amount of perp tokens redeemed.
    /// @return vaultNoteAmtBurnt The amount of vault notes redeemed.
    /// @return returnedTokens The list of asset tokens and amounts returned.
    function redeem2(
        uint256 perpAmtAvailable,
        uint256 vaultNoteAmtAvailable
    ) external returns (uint256 perpAmtBurnt, uint256 vaultNoteAmtBurnt, TokenAmount[] memory returnedTokens);

    /// @notice Allows users to swap their underlying tokens for perps held by the vault.
    /// @param underlyingAmtIn The amount of underlying tokens swapped in.
    /// @return The amount of perp tokens swapped out.
    function swapUnderlyingForPerps(uint256 underlyingAmtIn) external returns (uint256);

    /// @notice Allows users to swap their perp tokens for underlying tokens held by the vault.
    /// @param perpAmtIn The amount of perp tokens swapped in.
    /// @return The amount of underlying tokens swapped out.
    function swapPerpsForUnderlying(uint256 perpAmtIn) external returns (uint256);

    /// @notice Computes the amount of perp tokens that are returned when user swaps a given number of underlying tokens.
    /// @param underlyingAmtIn The number of underlying tokens the user swaps in.
    /// @return perpAmtOut The number of perp tokens returned to the user.
    /// @return perpFeeAmtToBurn The amount of perp tokens to be paid to the perp contract as mint fees.
    /// @return s The pre-swap perp and vault subscription state.
    function computeUnderlyingToPerpSwapAmt(
        uint256 underlyingAmtIn
    ) external returns (uint256, uint256, SubscriptionParams memory);

    /// @notice Computes the amount of underlying tokens that are returned when user swaps a given number of perp tokens.
    /// @param perpAmtIn The number of perp tokens the user swaps in.
    /// @return underlyingAmtOut The number of underlying tokens returned to the user.
    /// @return perpFeeAmtToBurn The amount of perp tokens to be paid to the perp contract as burn fees.
    /// @return s The pre-swap perp and vault subscription state.
    function computePerpToUnderlyingSwapAmt(
        uint256 perpAmtIn
    ) external returns (uint256, uint256, SubscriptionParams memory);

    /// @return The system's current deviation ratio.
    function deviationRatio() external returns (uint256);
}
