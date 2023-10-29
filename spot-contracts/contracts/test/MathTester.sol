// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { SignedMathHelpers } from "../_utils/SignedMathHelpers.sol";
import { Sigmoid } from "../_utils/Sigmoid.sol";

contract MathTester {
    using SignedMathHelpers for int256;

    function sign(int256 a) public pure returns (int256) {
        return a.sign();
    }

    function compute(
        int256 x,
        int256 lower,
        int256 upper,
        int256 growth,
        uint8 decimals
    ) public pure returns (int256) {
        return Sigmoid.compute(x, lower, upper, growth, decimals);
    }
}
