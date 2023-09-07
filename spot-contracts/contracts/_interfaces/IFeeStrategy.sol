// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

interface IFeeStrategy {
    /// @notice Fixed percentage of the rollover amount to be used as fee.
    /// @dev Represented as a fixed-point number with {PRICE_DECIMAL} decimal places.
    function rolloverFeePerc() external returns (int256);

    /// @notice DEPRECATED.
    function feeToken() external view returns (IERC20Upgradeable);

    /// @notice DEPRECATED.
    function computeMintFees(uint256 amount) external view returns (int256 reserveFee, uint256 protocolFee);

    /// @notice DEPRECATED.
    function computeBurnFees(uint256 amount) external view returns (int256 reserveFee, uint256 protocolFee);

    /// @notice DEPRECATED.
    function computeRolloverFees(uint256 amount) external view returns (int256 reserveFee, uint256 protocolFee);
}
