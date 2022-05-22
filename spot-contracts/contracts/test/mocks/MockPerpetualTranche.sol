// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import { MockERC20 } from "./MockERC20.sol";

contract MockPerpetualTranche is MockERC20 {
    // solhint-disable-next-line no-empty-blocks
    constructor() MockERC20("MockPerpetualTranche", "PERP") {}

    function feeCollector() public view returns (address) {
        return address(this);
    }
}
