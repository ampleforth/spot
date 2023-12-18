// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IBondController } from "./buttonwood/IBondController.sol";

interface IFeePolicy {
    /// @param valueIn The value of incoming assets used to mint perps.
    /// @return The percentage of the mint perp tokens to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function computePerpMintFeePerc(uint256 valueIn) external returns (uint256);

    /// @return The percentage of the burnt perp tokens to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function computePerpBurnFeePerc() external returns (uint256);

    /// @return The applied exchange rate adjustment between tranches into perp and
    ///         tokens out of perp during a rollover,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    /// @dev - A fee of 0%, implies the rollover exchange rate is unaltered.
    ///         example) 100 tranchesIn for 100 tranchesOut
    ///      - A fee of 1%, implies the exchange rate is adjusted in favor of tranchesIn.
    ///         example) 100 tranchesIn for 99 tranchesOut
    ///      - A fee of -1%, implies the exchange rate is adjusted in favor of tranchesOut.
    ///         example) 99 tranchesIn for 100 tranchesOut
    function computePerpRolloverFeePerc() external returns (int256);

    /// @return The percentage of the mint vault note amount to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function computeVaultMintFeePerc() external returns (uint256);

    /// @return The percentage of the burnt vault note amount to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function computeVaultBurnFeePerc() external returns (uint256);

    /// @return The fixed amount fee charged by the vault during each deployment,
    ///         denominated in the underlying collateral asset.
    function computeVaultDeploymentFee() external returns (uint256);

    /// @param valueIn The value of underlying tokens swapped in.
    /// @return The percentage of perp tokens out to be charged as swap fee by the perp and vault systems,
    ///         as a fixed-point numbers with {DECIMALS} decimal places.
    function computeUnderlyingToPerpSwapFeePercs(uint256 valueIn) external returns (uint256, uint256);

    /// @return The percentage of underlying tokens out to be charged as swap fee by the perp and vault systems,
    ///         as a fixed-point numbers with {DECIMALS} decimal places.
    function computePerpToUnderlyingSwapFeePercs() external returns (uint256, uint256);

    /// @return Number of decimals representing 1.0 or 100%.
    function decimals() external view returns (uint8);

    /// @dev The subscription state the vault system relative to the perp supply.
    struct SubscriptionState {
        /// @notice The recorded tvl of perp.
        uint256 perpTVL;
        /// @notice The recorded tvl of the rollover vault.
        uint256 vaultTVL;
        /// @notice Computed normalized subscription ratio.
        uint256 normalizedSubscriptionRatio;
    }

    /// @dev Computes the current subscription state of vault system.
    function computeSubscriptionState() external returns (SubscriptionState memory);
}
