// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IPerpetualTranche } from "@ampleforthorg/spot-contracts/contracts/_interfaces/IPerpetualTranche.sol";
import { IRolloverVault } from "@ampleforthorg/spot-contracts/contracts/_interfaces/IRolloverVault.sol";
import { Range } from "./types/CommonTypes.sol";

/// @title IDRBalancerVault
/// @notice Interface for DRBalancerVault - a vault that holds underlying and perp tokens
///         as liquidity and auto-rebalances to help maintain the SYSTEM's target deviation ratio
///         via IRolloverVault swaps.
///
///         The system's deviation ratio (DR) is defined by FeePolicy as:
///         DR = vaultTVL / perpTVL / targetSystemRatio
///
///         When DR < 1 (under-subscribed): vault TVL is too low relative to perp TVL
///         When DR > 1 (over-subscribed): vault TVL is too high relative to perp TVL
interface IDRBalancerVault is IERC20Upgradeable {
    //--------------------------------------------------------------------------
    // Events

    /// @notice Emitted when a user deposits underlying tokens.
    /// @param depositor The address of the depositor.
    /// @param underlyingAmtIn The amount of underlying tokens deposited.
    /// @param notesMinted The amount of vault notes minted.
    event Deposit(
        address indexed depositor,
        uint256 underlyingAmtIn,
        uint256 notesMinted
    );

    /// @notice Emitted when a user redeems vault notes.
    /// @param redeemer The address of the redeemer.
    /// @param notesBurnt The amount of vault notes burnt.
    /// @param underlyingAmtOut The amount of underlying tokens returned.
    /// @param perpAmtOut The amount of perp tokens returned.
    event Redeem(
        address indexed redeemer,
        uint256 notesBurnt,
        uint256 underlyingAmtOut,
        uint256 perpAmtOut
    );

    /// @notice Emitted when the vault rebalances to adjust system DR.
    /// @param drBefore The system deviation ratio before rebalance.
    /// @param drAfter The system deviation ratio after rebalance.
    /// @param underlyingAmt The amount of underlying involved in the swap.
    /// @param isUnderlyingIntoPerp True if underlying was swapped for perps, false if perps were swapped for underlying.
    event Rebalance(
        uint256 drBefore,
        uint256 drAfter,
        uint256 underlyingAmt,
        bool isUnderlyingIntoPerp
    );

    //--------------------------------------------------------------------------
    // Core Methods

    /// @notice Deposits underlying tokens and mints vault notes (LP tokens).
    /// @param underlyingAmtIn The amount of underlying tokens to deposit.
    /// @return notesMinted The amount of vault notes minted.
    function deposit(uint256 underlyingAmtIn) external returns (uint256 notesMinted);

    /// @notice Burns vault notes and returns proportional underlying and perp tokens.
    /// @param notesAmt The amount of vault notes to burn.
    /// @return underlyingAmtOut The amount of underlying tokens returned.
    /// @return perpAmtOut The amount of perp tokens returned.
    function redeem(
        uint256 notesAmt
    ) external returns (uint256 underlyingAmtOut, uint256 perpAmtOut);

    /// @notice Rebalances to help maintain the system's target deviation ratio.
    /// @dev Can only be called after cooldown period has elapsed.
    function rebalance() external;

    //--------------------------------------------------------------------------
    // View Methods

    /// @notice Returns this vault's total value locked in underlying denomination.
    /// @return The TVL of this vault (underlying + perp value).
    function getTVL() external returns (uint256);

    /// @notice Returns the current SYSTEM deviation ratio from the rollover vault.
    /// @dev DR = vaultTVL / perpTVL / targetSystemRatio (as defined in FeePolicy)
    /// @return The system deviation ratio as a fixed point number with 8 decimals.
    function getSystemDeviationRatio() external returns (uint256);

    /// @notice Computes the amount of underlying to swap for rebalancing.
    /// @return underlyingAmt The amount of underlying involved in the swap.
    /// @return isUnderlyingIntoPerp True if should swap underlying for perps, false otherwise.
    function computeRebalanceAmount()
        external
        returns (uint256 underlyingAmt, bool isUnderlyingIntoPerp);

    /// @notice Returns the underlying token balance held by this vault.
    /// @return The underlying token balance.
    function underlyingBalance() external view returns (uint256);

    /// @notice Returns the perp token balance held by this vault.
    /// @return The perp token balance.
    function perpBalance() external view returns (uint256);

    //--------------------------------------------------------------------------
    // Config Getters

    /// @notice The underlying rebasing token (e.g., AMPL).
    function underlying() external view returns (IERC20Upgradeable);

    /// @notice The perpetual tranche token (SPOT).
    function perp() external view returns (IPerpetualTranche);

    /// @notice The rollover vault used for swaps.
    function rolloverVault() external view returns (IRolloverVault);

    /// @notice The target system deviation ratio (typically 1.0 with 8 decimals).
    function targetDR() external view returns (uint256);

    /// @notice The equilibrium DR range where no rebalancing occurs.
    function equilibriumDR() external view returns (Range memory);

    /// @notice The lag factor for underlying->perp swaps (when DR is low).
    function lagFactorUnderlyingToPerp() external view returns (uint256);

    /// @notice The lag factor for perp->underlying swaps (when DR is high).
    function lagFactorPerpToUnderlying() external view returns (uint256);

    /// @notice The min/max percentage of TVL for underlying->perp swaps.
    function rebalancePercLimitsUnderlyingToPerp() external view returns (Range memory);

    /// @notice The min/max percentage of TVL for perp->underlying swaps.
    function rebalancePercLimitsPerpToUnderlying() external view returns (Range memory);

    /// @notice The minimum seconds between rebalances.
    function rebalanceFreqSec() external view returns (uint256);

    /// @notice The timestamp of the last rebalance.
    function lastRebalanceTimestampSec() external view returns (uint256);

    /// @notice The maximum swap fee percentage allowed during rebalance.
    function maxSwapFeePerc() external view returns (uint256);

    /// @notice The keeper address.
    function keeper() external view returns (address);
}
