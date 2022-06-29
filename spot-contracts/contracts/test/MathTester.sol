// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.15;

import { SignedMathHelpers } from "../_utils/SignedMathHelpers.sol";

contract MathTester {
    using SignedMathHelpers for int256;

    function sign(int256 a) public pure returns (int256) {
        return a.sign();
    }
}
