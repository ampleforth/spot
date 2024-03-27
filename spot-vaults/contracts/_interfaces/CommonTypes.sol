// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

struct LinearFn {
    uint256 x1;
    uint256 y1;
    uint256 x2;
    uint256 y2;
}

struct Range {
    uint256 lower;
    uint256 upper;
}

struct SystemFees {
    uint256 mintFeePerc;
    uint256 burnFeePerc;
    Range perpToUSDSwapFeePercs;
    Range usdToPerpSwapFeePercs;
    uint256 protocolSwapSharePerc;
}

struct ReserveState {
    uint256 usdReserve;
    uint256 perpReserve;
    uint256 usdPrice;
    uint256 perpPrice;
}
