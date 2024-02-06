// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { SubscriptionParams } from "./CommonTypes.sol";

interface IFeePolicy {
    /// @param dr The current system deviation ratio.
    /// @return The percentage of the mint perp tokens to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function computePerpMintFeePerc(uint256 dr) external view returns (uint256);

    /// @param dr The current system deviation ratio.
    /// @return The percentage of the burnt perp tokens to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function computePerpBurnFeePerc(uint256 dr) external view returns (uint256);

    /// @param dr The current system deviation ratio.
    /// @return The applied exchange rate adjustment between tranches into perp and
    ///         tokens out of perp during a rollover,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    /// @dev - A fee of 0%, implies the rollover exchange rate is unaltered.
    ///         example) 100 tranchesIn for 100 tranchesOut
    ///      - A fee of 1%, implies the exchange rate is adjusted in favor of tranchesIn.
    ///         example) 100 tranchesIn for 99 tranchesOut; i.e) perp enrichment
    ///      - A fee of -1%, implies the exchange rate is adjusted in favor of tranchesOut.
    ///         example) 99 tranchesIn for 100 tranchesOut
    function computePerpRolloverFeePerc(uint256 dr) external view returns (int256);

    /// @return The percentage of the mint vault note amount to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function computeVaultMintFeePerc() external view returns (uint256);

    /// @return The percentage of the burnt vault note amount to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function computeVaultBurnFeePerc() external view returns (uint256);

    /// @return The fixed amount fee charged by the vault during each deployment,
    ///         denominated in the underlying collateral asset.
    function computeVaultDeploymentFee() external view returns (uint256);

    /// @param dr The current system deviation ratio.
    /// @return perpFeePerc The percentage of perp tokens out to be charged as swap fees by perp,
    ///         as a fixed-point numbers with {DECIMALS} decimal places.
    /// @return vaultFeePerc The percentage of perp tokens out to be charged as swap fees by the vault,
    ///         as a fixed-point numbers with {DECIMALS} decimal places.
    function computeUnderlyingToPerpSwapFeePercs(
        uint256 dr
    ) external view returns (uint256 perpFeePerc, uint256 vaultFeePerc);

    /// @param dr The current system deviation ratio.
    /// @return perpFeePerc The percentage of underlying tokens out to be charged as swap fees by perp,
    ///         as a fixed-point numbers with {DECIMALS} decimal places.
    /// @return vaultFeePerc The percentage of underlying tokens out to be charged as swap fees by the vault,
    ///         as a fixed-point numbers with {DECIMALS} decimal places.
    function computePerpToUnderlyingSwapFeePercs(
        uint256 dr
    ) external view returns (uint256 perpFeePerc, uint256 vaultFeePerc);

    /// @return Number of decimals representing a multiplier of 1.0. So, 100% = 1*10**decimals.
    function decimals() external view returns (uint8);

    /// @param s The subscription parameters of both the perp and vault systems.
    /// @return The deviation ratio given the system subscription parameters.
    function computeDeviationRatio(SubscriptionParams memory s) external view returns (uint256);

    /// @param perpTVL  The current TVL of perp denominated in the underlying.
    /// @param vaultTVL The current TVL of the vault denominated in the underlying.
    /// @param seniorTR The tranche ratio of seniors accepted by perp.
    /// @return The deviation ratio given the system subscription parameters.
    function computeDeviationRatio(uint256 perpTVL, uint256 vaultTVL, uint256 seniorTR) external view returns (uint256);

    /// @notice The target subscription ratio i.e) the normalization factor.
    function targetSubscriptionRatio() external view returns (uint256);
}
