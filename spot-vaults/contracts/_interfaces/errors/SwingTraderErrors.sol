// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @notice Exceeded max active redemption requests per account.
error TooManyRedemptionRequests();

/// @notice Exceeded enforced swap limit.
error SwapLimitExceeded();

/// @notice Wait time exceeded enforced limit.
error WaittimeTooHigh();
