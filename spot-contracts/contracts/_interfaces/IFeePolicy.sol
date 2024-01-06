// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IBondController } from "./buttonwood/IBondController.sol";

interface IFeePolicy {
    /// @param sr The current system subscription ratio.
    /// @return The percentage of the mint perp tokens to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function perpMintFeePerc(uint256 sr) external returns (uint256);

    /// @param sr The current system subscription ratio.
    /// @return The percentage of the burnt perp tokens to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function perpBurnFeePerc(uint256 sr) external returns (uint256);

    /// @param sr The current system subscription ratio.
    /// @return The applied exchange rate adjustment between tranches into perp and
    ///         tokens out of perp during a rollover,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    /// @dev - A fee of 0%, implies the rollover exchange rate is unaltered.
    ///         example) 100 tranchesIn for 100 tranchesOut
    ///      - A fee of 1%, implies the exchange rate is adjusted in favor of tranchesIn.
    ///         example) 100 tranchesIn for 99 tranchesOut
    ///      - A fee of -1%, implies the exchange rate is adjusted in favor of tranchesOut.
    ///         example) 99 tranchesIn for 100 tranchesOut
    function perpRolloverFeePerc(uint256 sr) external returns (int256);

    /// @return The percentage of the mint vault note amount to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function vaultMintFeePerc() external returns (uint256);

    /// @return The percentage of the burnt vault note amount to be charged as fees,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    function vaultBurnFeePerc() external returns (uint256);

    /// @return The fixed amount fee charged by the vault during each deployment,
    ///         denominated in the underlying collateral asset.
    function vaultDeploymentFee() external returns (uint256);

    /// @param sr The current system subscription ratio.
    /// @return perpFeePerc The percentage of perp tokens out to be charged as swap fees by perp,
    ///         as a fixed-point numbers with {DECIMALS} decimal places.
    /// @return vaultFeePerc The percentage of perp tokens out to be charged as swap fees by the vault,
    ///         as a fixed-point numbers with {DECIMALS} decimal places.
    function underlyingToPerpSwapFeePercs(uint256 sr) external returns (uint256 perpFeePerc, uint256 vaultFeePerc);

    /// @param sr The current system subscription ratio.
    /// @return perpFeePerc The percentage of underlying tokens out to be charged as swap fees by perp,
    ///         as a fixed-point numbers with {DECIMALS} decimal places.
    /// @return vaultFeePerc The percentage of underlying tokens out to be charged as swap fees by the vault,
    ///         as a fixed-point numbers with {DECIMALS} decimal places.
    function perpToUnderlyingSwapFeePercs(uint256 sr) external returns (uint256 perpFeePerc, uint256 vaultFeePerc);

    /// @return Number of decimals representing a multiplier of 1.0. So, 100% = 1*10**decimals.
    function decimals() external view returns (uint8);

    /// @notice The system subscription parameters.
    struct SubscriptionParams {
        /// @notice The tranche ratio of seniors accepted by perp.
        uint256 perpTR;
        /// @notice The remainder tranche ratio held in the vault.
        uint256 vaultTR;
        /// @notice The current TVL of perp denominated in the underlying.
        uint256 perpTVL;
        /// @notice The current TVL of the vault denominated in the underlying.
        uint256 vaultTVL;
    }

    /// @param s The subscription parameters of both the perp and vault systems.
    /// @return The subscription ratio given the system subscription parameters.
    function computeSubscriptionRatio(SubscriptionParams memory s) external returns (uint256);
}
