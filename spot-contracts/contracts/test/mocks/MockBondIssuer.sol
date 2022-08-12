// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.15;

contract MockBondIssuer {
    address private _bond;
    address public collateralToken;

    constructor(address collateralToken_) {
        collateralToken = collateralToken_;
    }

    function setLatestBond(address b) external {
        _bond = b;
    }

    function getLatestBond() external view returns (address) {
        return _bond;
    }
}
