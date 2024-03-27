// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

contract SpotOracle {
    IERC20Upgradeable public immutable ampl;
    IChainlinkOracle public immutable usdOracle;

    uint256 private constant DECIMALS = 18;
    uint256 private constant ONE = (10 ** DECIMALS);

    uint256 public constant CL_ORACLE_DECIMALS = 8;
    uint256 public constant CL_ORACLE_STALENESS_TRESHOLD_SEC = 3600 * 24 * 7;

    uint256 public constant USD_LOWER_BOUND = (99 * ONE) / 100;
    uint256 public constant USD_UPPER_BOUND = (101 * ONE) / 100;

    uint256 public constant UNDERLYING_TARGET_LOWER_BOUND = 1 * ONE;
    uint256 public constant UNDERLYING_TARGET_UPPER_BOUND = 3 * ONE;

    constructor() {}

    function getUnderlyingTargetPrice() public returns (uint256, bool) {
        IPolicy policy = ampl.monetaryPolicy();
        IAmpleforthOracle cpiOracle = policy.cpiOracle();
        // TODO: Increase the time to activity to 1 week,
        (uint256 p, bool v) = cpiOracle.getData();
        v = v && p > UNDERLYING_TARGET_LOWER_BOUND && p < UNDERLYING_TARGET_UPPER_BOUND;
        return (p, v);
    }

    function getUSDPrice() public returns (uint256, bool) {
        (, int256 price, , uint256 updatedAt, ) = oracle.latestRoundData();
        uint256 p = uint256(price).mulDiv(ONE, 10 ** CL_ORACLE_DECIMALS);
        v =
            v &&
            p > USD_LOWER_BOUND &&
            p < USD_UPPER_BOUND &&
            ((block.timestamp - updatedAt) <= CL_ORACLE_STALENESS_TRESHOLD_SEC);
        return (p, v);
    }
}
