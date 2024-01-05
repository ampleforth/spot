// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

/// @notice Expected contract call to be triggered by authorized caller.
error UnauthorizedCall();

/// @notice Expected transfer out asset to not be a reserve asset.
error UnauthorizedTransferOut();

/// @notice Expected contract reference to not be `address(0)`.
error UnacceptableReference();

/// @notice Expected interface contract to return a fixed point with a different number of decimals.
error UnexpectedDecimals();

/// @notice Expected asset to be a valid vault asset.
error UnexpectedAsset();

/// @notice Expected to mint a non-zero amount of notes.
error UnacceptableDeposit();

/// @notice Expected to redeem a non-zero amount of notes.
error UnacceptableRedemption();

/// @notice Updated parameters violate defined constraints.
error UnacceptableParams();

/// @notice Expected assets transferred into the vault to have non-zero value.
error ValuelessAssets();

/// @notice Storage array access out of bounds.
error OutOfBounds();

/// @notice Expected the operation not to decrease the system's tvl.
error TVLDecreased();

/// @notice Expected rollover to be acceptable.
error UnacceptableRollover();

/// @notice Expected to swap non-zero assets.
error UnacceptableSwap();

/// @notice Expected more assets to be deployed.
error InsufficientDeployment();

/// @notice Expected the number of vault assets deployed to be under the limit.
error DeployedCountOverLimit();
