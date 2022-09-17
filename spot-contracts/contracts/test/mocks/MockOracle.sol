// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.17;

contract MockOracle {
    uint256 private data;
    bool private success;

    function getData() external view returns (uint256, bool) {
        return (data, success);
    }

    function setData(uint256 dt, bool v) external {
        data = dt;
        success = v;
    }
}
