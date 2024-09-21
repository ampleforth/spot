// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

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

/// @notice A data structure to define a numeric Range.
struct Range {
    // @dev Lower bound of the range.
    uint256 lower;
    // @dev Upper bound of the range.
    uint256 upper;
}
