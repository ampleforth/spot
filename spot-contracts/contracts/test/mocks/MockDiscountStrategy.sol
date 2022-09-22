// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.15;

contract MockDiscountStrategy {
    uint8 private _decimals;

    mapping(address => uint256) private _discounts;

    constructor() {
        _decimals = 18;
    }

    function setDecimals(uint8 d) external {
        _decimals = d;
    }

    function setTrancheDiscount(address t, uint256 y) external {
        _discounts[t] = y;
    }

    function computeTrancheDiscount(address t) external view returns (uint256) {
        return _discounts[t];
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }
}
