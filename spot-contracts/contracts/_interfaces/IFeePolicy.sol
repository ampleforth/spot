// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { SystemState } from "./CommonTypes.sol";

interface IFeePolicy {
    /// @return The percentage of the mint perp tokens to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    /// @dev Perp mint fees are paid to the vault.
    function computeFeePerc(uint256 drPre, uint256 drPost) external view returns (uint256);

    /// @return Number of decimals representing a multiplier of 1.0. So, 100% = 1*10**decimals.
    function decimals() external view returns (uint8);

    /// @param s The subscription parameters of both the perp and vault systems.
    /// @return The deviation ratio given the system subscription parameters.
    function computeDeviationRatio(SystemState memory s) external view returns (uint256);

    /// @return The target system ratio as a fixed-point number with {DECIMALS} decimal places.
    function targetSystemRatio() external view returns (uint256);

    /// @notice Computes magnitude and direction of value flow between perp and the rollover vault
    ///         expressed in underlying tokens.
    /// @param s The subscription parameters of both the perp and vault systems.
    /// @return underlyingAmtIntoPerp The value in underlying tokens, that need to flow from the vault into perp.
    function computeRebalanceAmount(SystemState memory s) external view returns (int256 underlyingAmtIntoPerp);

    /// @return The share of the system tvl paid to the protocol owner as fees.
    function protocolSharePerc() external view returns (uint256);

    /// @return Frequency of the periodic rebalance operation.
    function rebalanceFreqSec() external view returns (uint256);

    /// @return The fee collector address.
    function protocolFeeCollector() external view returns (address);
}
