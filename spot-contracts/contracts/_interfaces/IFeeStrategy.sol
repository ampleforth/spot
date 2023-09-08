// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IBondController } from "./buttonwood/IBondController.sol";

interface IFeeStrategy {
    /// @notice The percentage of the rollover amount to be used as fee.
    /// @dev Represented as a fixed-point number with {PRICE_DECIMAL} decimal places.
    ///      - A fee of 0%, implies the rollover exchange rate is unaltered.
    ///         example) 100 tranchesIn for 100 tranchesOut
    ///      - A fee of 1%, implies the exchange rate is adjusted in favor of tranchesIn.
    ///         example) 100 tranchesIn for 99 tranchesOut
    ///      - A fee of -1%, implies the exchange rate is adjusted in favor of tranchesOut.
    ///         example) 99 tranchesIn for 100 tranchesOut
    function computeRolloverFeePerc() external returns (int256);

    /// @notice DEPRECATED.
    function feeToken() external view returns (IERC20Upgradeable);

    /// @notice DEPRECATED.
    function computeMintFees(uint256 amount) external view returns (int256 reserveFee, uint256 protocolFee);

    /// @notice DEPRECATED.
    function computeBurnFees(uint256 amount) external view returns (int256 reserveFee, uint256 protocolFee);

    /// @notice DEPRECATED.
    function computeRolloverFees(uint256 amount) external view returns (int256 reserveFee, uint256 protocolFee);
}
