// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.18;

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
