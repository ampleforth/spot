// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.15;

import {MockERC20} from "./MockERC20.sol";

contract MockTranche is MockERC20 {
    address public bond;

    function setBond(address b) external {
        bond = b;
    }
}
