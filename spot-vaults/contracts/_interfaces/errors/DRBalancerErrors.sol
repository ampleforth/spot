// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @notice Expected DR lower bound to be under the upper bound.
error InvalidDRBound();

/// @notice Rebalance called before cooldown elapsed.
error LastRebalanceTooRecent();

/// @notice Swap fee exceeded the maximum allowed percentage.
error SlippageTooHigh();
