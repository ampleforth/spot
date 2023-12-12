// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IBondController } from "./buttonwood/IBondController.sol";

interface IFeePolicy {
    /// @notice The percentage of the mint perp tokens to be withheld as fees,
    ///         as a fixed-point number with {PRICE_DECIMAL} decimal places.
    function computePerpMintFeePerc() external returns (uint256);

    /// @notice The percentage of the burnt perp tokens to be withheld as fees,
    ///         as a fixed-point number with {PRICE_DECIMAL} decimal places.
    function computePerpBurnFeePerc() external returns (uint256);

    /// @notice The applied exchange rate adjustment between tranches into perp and
    ///         tokens out of perp during a rollover,
    ///         as a fixed-point number with {PRICE_DECIMAL} decimal places.
    ///      - A fee of 0%, implies the rollover exchange rate is unaltered.
    ///         example) 100 tranchesIn for 100 tranchesOut
    ///      - A fee of 1%, implies the exchange rate is adjusted in favor of tranchesIn.
    ///         example) 100 tranchesIn for 99 tranchesOut
    ///      - A fee of -1%, implies the exchange rate is adjusted in favor of tranchesOut.
    ///         example) 99 tranchesIn for 100 tranchesOut
    function computePerpRolloverFeePerc() external returns (int256);

    /// @notice The percentage of the mint vault note amount to be withheld as fees,
    ///         as a fixed-point number with {PRICE_DECIMAL} decimal places.
    function computeVaultMintFeePerc() external returns (uint256);

    /// @notice The percentage of the burnt vault note amount to be withheld as fees,
    ///         as a fixed-point number with {PRICE_DECIMAL} decimal places.
    function computeVaultBurnFeePerc() external returns (uint256);

    /// @notice The fixed amount fee withheld by the vault during each deployment,
    ///         denominated in the underlying collateral asset.
    function computeVaultDeploymentFee() external returns (uint256);

    /// @notice Number of decimals representing 1.0 or 100%.
    function decimals() external view returns (uint8);
}
