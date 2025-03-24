// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { MockERC20 } from "./MockERC20.sol";

contract MockPerp is MockERC20 {
    uint256 private _tvl;
    function getTVL() public view returns (uint256) {
        return _tvl;
    }

    function setTVL(uint256 tvl) public {
        _tvl = tvl;
    }
}
