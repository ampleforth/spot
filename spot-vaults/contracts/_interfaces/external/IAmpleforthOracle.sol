// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

interface IAmpleforthOracle {
    function getData() external returns (uint256, bool);
}
