// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { Range } from "./CommonTypes.sol";

/// @notice A data structure to store various fees associated with BillBroker operations.
struct BillBrokerFees {
    /// @notice The percentage fee charged for minting BillBroker LP tokens.
    uint256 mintFeePerc;
    /// @notice The percentage fee charged for burning BillBroker LP tokens.
    uint256 burnFeePerc;
    /// @notice Range of fee factors for swapping from perp tokens to USD.
    /// @dev Factor of 1.02 implies a +2% fees, and 0.98 implies a -2% fees.
    Range perpToUSDSwapFeeFactors;
    /// @notice Range of fee factors for swapping from USD to perp tokens.
    Range usdToPerpSwapFeeFactors;
    /// @notice The percentage of the swap fees that goes to the protocol.
    uint256 protocolSwapSharePerc;
}

/// @notice A data structure to represent the BillBroker's reserve state.
struct ReserveState {
    /// @notice The reserve USD token balance.
    uint256 usdBalance;
    /// @notice The reserve perp token balance.
    uint256 perpBalance;
    /// @notice The price of USD tokens in dollars (or some common denomination).
    uint256 usdPrice;
    /// @notice The price of perp tokens in dollars (or some common denomination).
    uint256 perpPrice;
}
