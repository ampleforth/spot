// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.18;

contract MockBondIssuer {
    address private _bond;
    address public collateral;

    constructor(address collateral_) {
        collateral = collateral_;
    }

    function setLatestBond(address b) external {
        _bond = b;
    }

    function getLatestBond() external view returns (address) {
        return _bond;
    }
}
