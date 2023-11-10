// SPDX-License-Identifier: GPL-3.0-or-later
// https://github.com/ampleforth/ampleforth-contracts/blob/master/contracts/UFragmentsPolicy.sol
pragma solidity ^0.8.19;

import { SafeMathInt } from "ampleforth-contracts/contracts/lib/SafeMathInt.sol";

/**
 *  @title Sigmoid
 *
 *  @notice Library with helper functions to compute y = sigmoid(x).
 *
 *  TODO: port over 2-pow and use plain math instead of the "safe math" lib.
 */
library Sigmoid {
    using SafeMathInt for int256;

    /// @notice Given number x and sigmoid parameters all represented as fixed-point number with
    ///         the same number of decimals, it computes y = sigmoid(x).
    /// @param x The sigmoid function input value.
    /// @param lower The lower asymptote.
    /// @param upper The upper asymptote.
    /// @param growth The growth parameter.
    /// @param target The target value of "x" for which sigmoid(target) returns zero 0.
    /// @return The computed value of sigmoid(x).
    function compute(
        int256 x,
        int256 lower,
        int256 upper,
        int256 growth,
        int256 target
    ) internal pure returns (int256) {
        int256 delta;

        delta = (x.sub(target));

        // Compute: (Upper-Lower)/(1-(Upper/Lower)/2^(Growth*delta))) + Lower

        int256 exponent = growth.mul(delta).div(target);
        // Cap exponent to guarantee it is not too big for twoPower
        if (exponent > target.mul(100)) {
            exponent = target.mul(100);
        }
        if (exponent < target.mul(-100)) {
            exponent = target.mul(-100);
        }

        int256 pow = SafeMathInt.twoPower(exponent, target); // 2^(Growth*Delta)
        if (pow == 0) {
            return lower;
        }
        int256 numerator = upper.sub(lower); //(Upper-Lower)
        int256 intermediate = upper.mul(target).div(lower);
        intermediate = intermediate.mul(target).div(pow);
        int256 denominator = target.sub(intermediate); // (1-(Upper/Lower)/2^(Growth*delta)))

        int256 y = (numerator.mul(target).div(denominator)).add(lower);
        return y;
    }
}
