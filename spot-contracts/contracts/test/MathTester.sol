// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.17;

import { SignedMathHelpers } from "../_utils/SignedMathHelpers.sol";

contract MathTester {
    using SignedMathHelpers for int256;

    function sign(int256 a) public pure returns (int256) {
        return a.sign();
    }
}
