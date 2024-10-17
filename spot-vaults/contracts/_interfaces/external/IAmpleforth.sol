// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

interface IAmpleforth {
    function getTargetRate() external returns (uint256, bool);
}
