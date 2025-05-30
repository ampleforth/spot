// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

struct TokenAmount {
    /// @notice The asset token redeemed.
    IERC20Upgradeable token;
    /// @notice The amount redeemed.
    uint256 amount;
}

/// @notice The system TVL parameters.
struct SystemTVL {
    /// @notice The current TVL of perp denominated in the underlying.
    uint256 perpTVL;
    /// @notice The current TVL of the vault denominated in the underlying.
    uint256 vaultTVL;
}

struct RolloverData {
    /// @notice The amount of tokens rolled out.
    uint256 tokenOutAmt;
    /// @notice The amount of trancheIn tokens rolled in.
    uint256 trancheInAmt;
}

/// @notice A data structure to define a numeric Range.
struct Range {
    // @dev Lower bound of the range.
    uint256 lower;
    // @dev Upper bound of the range.
    uint256 upper;
}

/// @notice A data structure to define a geometric Line with two points.
struct Line {
    // @dev x-coordinate of the first point.
    uint256 x1;
    // @dev y-coordinate of the first point.
    uint256 y1;
    // @dev x-coordinate of the second point.
    uint256 x2;
    // @dev y-coordinate of the second point.
    uint256 y2;
}
