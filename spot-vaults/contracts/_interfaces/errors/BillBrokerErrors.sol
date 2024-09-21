// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @notice Expect AR lower bound to be under the upper bound.
error InvalidARBound();

/// @notice Expected pre and post swap AR delta to be non-increasing or non-decreasing.
error UnexpectedARDelta();
