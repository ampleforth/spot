// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { MockERC20 } from "./MockERC20.sol";

contract MockPerpetualTranche is MockERC20 {
    uint256 private _tvl;

    function setTVL(uint256 tvl_) external {
        _tvl = tvl_;
    }

    function getTVL() external view returns (uint256) {
        return _tvl;
    }
}
