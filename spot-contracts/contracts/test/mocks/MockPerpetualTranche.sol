// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.15;

import { MockERC20 } from "./MockERC20.sol";

contract MockPerpetualTranche is MockERC20 {
    uint256 private _reserveTrancheBalance;
    uint256 public matureTrancheBalance;
    address public collateral;

    function feeCollector() public view returns (address) {
        return address(this);
    }

    function getReserveTrancheBalance(
        address /* token */
    ) public view returns (uint256) {
        return _reserveTrancheBalance;
    }

    function setReserveTrancheBalance(uint256 b) external {
        _reserveTrancheBalance = b;
    }

    function setMatureTrancheBalance(uint256 b) external {
        matureTrancheBalance = b;
    }

    function setCollateral(address c) external {
        collateral = c;
    }
}
