// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IBalancer } from "./IBalancer.sol";
import { IVault } from "./IVault.sol";
import { ITranche } from "./buttonwood/ITranche.sol";

interface IRolloverVault is IVault {
    /// @notice Deposits the tranche tokens from {msg.sender} into the vault and mints notes.
    /// @param trancheAmt The amount tranche tokens to be deposited into the vault.
    /// @return The amount of notes minted.
    function deposit(ITranche tranche, uint256 trancheAmt) external returns (uint256);

    /// @notice Computes the amount of notes minted when given amount of tranche tokens
    ///         are deposited into the system.
    /// @param trancheAmt The amount tranche tokens to be deposited into the vault.
    /// @return The amount of notes to be minted.
    function computeMintAmt(ITranche tranche, uint256 trancheAmt) external returns (uint256);

    /// @notice Allows users to swap their underlying tokens for perps held by the vault.
    /// @param underlyingAmtIn The amount of underlying tokens swapped in.
    /// @return The amount of perp tokens swapped out.
    function swapUnderlyingForPerps(uint256 underlyingAmtIn) external returns (uint256);

    /// @notice Allows users to swap their perp tokens for underlying tokens held by the vault.
    /// @param perpAmtIn The amount of perp tokens swapped in.
    /// @return The amount of underlying tokens swapped out.
    function swapPerpsForUnderlying(uint256 perpAmtIn) external returns (uint256);

    /// @notice The balancer contract which controls fees and orchestrates external actions with perp and vault systems.
    /// @return Address of the balancer contract.
    function balancer() external view returns (IBalancer);

    /// @return The system's current deviation ratio.
    function deviationRatio() external returns (uint256);
}
