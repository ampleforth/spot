// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.15;

contract MockPricingStrategy {
    uint8 private _decimals;
    uint256 private _price;

    mapping(address => uint256) private _tranchePrice;
    mapping(address => bool) private _tranchePriceSet;

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

    function setTranchePrice(address t, uint256 p) external {
        _tranchePrice[t] = p;
        _tranchePriceSet[t] = true;
    }

    function computeTranchePrice(address t) external view returns (uint256) {
        return _tranchePriceSet[t] ? _tranchePrice[t] : _price;
    }

    function computeMatureTranchePrice(
        address t,
        uint256 /* collateralBalance */,
        uint256 /* debt */
    ) external view returns (uint256) {
        return _tranchePriceSet[t] ? _tranchePrice[t] : _price;
    }

    function decimals() external view returns (uint8) {
        return _decimals;
    }
}
