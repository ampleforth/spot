// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @notice TODO
interface IBillBrokerOracle {
    function decimals() external pure returns (uint8);
    function getPerpPrice() external returns (uint256, bool);
    function getUSDPrice() external returns (uint256, bool);
}
