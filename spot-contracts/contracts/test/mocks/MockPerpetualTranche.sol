// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import { MockERC20 } from "./MockERC20.sol";

contract MockPerpetualTranche is MockERC20 {
    function feeCollector() public view returns (address) {
        return address(this);
    }
}
