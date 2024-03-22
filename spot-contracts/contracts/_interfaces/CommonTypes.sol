// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

//-----------------------------------------------------------------------------
// Generic

struct TokenAmount {
    /// @notice The asset token redeemed.
    IERC20Upgradeable token;
    /// @notice The amount redeemed.
    uint256 amount;
}

struct Range {
    uint256 lower;
    uint256 upper;
}

struct SigmoidParams {
    int256 lower;
    int256 upper;
    int256 growth;
}

//-----------------------------------------------------------------------------

struct PairAmounts {
    // NOTE `perpAmt` and `noteAmt` have different base denominations.
    // @notice Amount of perp tokens.
    uint256 perpAmt;
    // @notice Amount of vault notes.
    uint256 noteAmt;
}

struct RolloverData {
    /// @notice The amount of tokens rolled out.
    uint256 tokenOutAmt;
    /// @notice The amount of trancheIn tokens rolled in.
    uint256 trancheInAmt;
}

/// @notice The system subscription parameters.
struct SubscriptionParams {
    /// @notice The current TVL of perp denominated in the underlying.
    uint256 perpTVL;
    /// @notice The current TVL of the vault denominated in the underlying.
    uint256 vaultTVL;
    /// @notice The tranche ratio of seniors accepted by perp.
    uint256 seniorTR;
}

struct SystemFees {
    // perp fees
    uint256 perpMintFeePerc;
    uint256 perpBurnFeePerc;
    // vault fees
    uint256 vaultMintFeePerc;
    uint256 vaultBurnFeePerc;
    // rollover fee
    SigmoidParams rolloverFee;
    // swap fee
    uint256 underlyingToPerpSwapFeePerc;
    uint256 perpToUnderlyingSwapFeePerc;
    uint256 protocolSwapSharePerc;
}
