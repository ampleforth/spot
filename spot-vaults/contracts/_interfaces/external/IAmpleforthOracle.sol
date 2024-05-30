// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

interface IAmpleforthOracle {
    // solhint-disable-next-line func-name-mixedcase
    function DECIMALS() external returns (uint8);
    function getData() external returns (uint256, bool);
}
