// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.15;

contract MockYieldStrategy {
    uint8 private _decimals;

    mapping(address => uint256) private _yields;

    constructor() {
        _decimals = 18;
    }

    function setDecimals(uint8 d) external {
        _decimals = d;
    }

    function setTrancheYield(address t, uint256 y) external {
        _yields[t] = y;
    }

    function computeYield(address t) external view returns (uint256) {
        return _yields[t];
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }
}
