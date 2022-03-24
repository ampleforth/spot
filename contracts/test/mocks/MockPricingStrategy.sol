// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

contract MockPricingStrategy {
    uint8 private _decimals;
    uint256 private _price;

    constructor() {
        _decimals = 8;
        _price = 10**8;
    }

    function setDecimals(uint8 d) external {
        _decimals = d;
    }

    function setPrice(uint256 p) external {
        _price = p;
    }

    // solhint-disable-next-line no-unused-vars
    function computeTranchePrice(address t) external returns (uint256) {
        return _price;
    }

    function decimals() external returns (uint8) {
        return _decimals;
    }
}
