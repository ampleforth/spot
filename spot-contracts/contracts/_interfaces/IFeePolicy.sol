// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { SubscriptionParams, RebalanceData } from "./CommonTypes.sol";

interface IFeePolicy {
    /// @return The percentage of the mint perp tokens to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    /// @dev Perp mint fees are paid to the vault.
    function computePerpMintFeePerc() external view returns (uint256);

    /// @return The percentage of the burnt perp tokens to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    /// @dev Perp burn fees are paid to the vault.
    function computePerpBurnFeePerc() external view returns (uint256);

    /// @return The percentage of the mint vault note amount to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function computeVaultMintFeePerc() external view returns (uint256);

    /// @return The percentage of the burnt vault note amount to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function computeVaultBurnFeePerc() external view returns (uint256);

    /// @param dr The current system deviation ratio.
    /// @param dr_ The deviation ratio of the system after the operation is complete.
    /// @return The percentage of perp tokens out to be charged as swap fees by the vault,
    ///         as a fixed-point numbers with {DECIMALS} decimal places.
    function computeUnderlyingToPerpVaultSwapFeePerc(uint256 dr, uint256 dr_) external view returns (uint256);

    /// @param dr The current system deviation ratio.
    /// @param dr_ The deviation ratio of the system after the operation is complete.
    /// @return The percentage of underlying tokens out to be charged as swap fees by the vault,
    ///         as a fixed-point numbers with {DECIMALS} decimal places.
    function computePerpToUnderlyingVaultSwapFeePerc(uint256 dr, uint256 dr_) external view returns (uint256);

    /// @return Number of decimals representing a multiplier of 1.0. So, 100% = 1*10**decimals.
    function decimals() external view returns (uint8);

    /// @param s The subscription parameters of both the perp and vault systems.
    /// @return The deviation ratio given the system subscription parameters.
    function computeDeviationRatio(SubscriptionParams memory s) external view returns (uint256);

    /// @param s The subscription parameters of both the perp and vault systems.
    /// @return r Rebalance data, magnitude and direction of value flow between perp and the rollover vault
    ///           expressed in the underlying token amount and the protocol's cut.
    function computeRebalanceData(SubscriptionParams memory s) external view returns (RebalanceData memory r);
}
