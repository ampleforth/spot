// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

contract MockBondIssuer {
    address private _bond;

    function setLatestBond(address b) external {
        _bond = b;
    }

    function getLatestBond() external returns (address) {
        return _bond;
    }
}
