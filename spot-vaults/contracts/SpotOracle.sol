// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IChainlinkOracle } from "./_interfaces/external/IChainlinkOracle.sol";
import { IAMPL, IAmpleforth, IAmpleforthOracle } from "./_interfaces/external/IAmpleforth.sol";
import { IBillBrokerOracle } from "./_interfaces/IBillBrokerOracle.sol";

contract SpotOracle is IBillBrokerOracle {
    using MathUpgradeable for uint256;

    IAMPL public immutable AMPL;
    IChainlinkOracle public immutable USD_ORACLE;

    uint256 private constant DECIMALS = 18;
    uint256 private constant ONE = (10 ** DECIMALS);

    uint256 public constant CL_ORACLE_DECIMALS = 8;
    uint256 public constant CL_ORACLE_STALENESS_TRESHOLD_SEC = 3600 * 24 * 7;

    uint256 public constant USD_LOWER_BOUND = (99 * ONE) / 100;
    uint256 public constant USD_UPPER_BOUND = (101 * ONE) / 100;

    uint256 public constant UNDERLYING_TARGET_LOWER_BOUND = 1 * ONE;
    uint256 public constant UNDERLYING_TARGET_UPPER_BOUND = 3 * ONE;

    constructor(IAMPL ampl, IChainlinkOracle usdOracle) {
        AMPL = ampl;
        USD_ORACLE = usdOracle;
    }

    function decimals() external pure override returns (uint8) {
        return uint8(DECIMALS);
    }

    function getUnderlyingTargetPrice() external override returns (uint256, bool) {
        IAmpleforth policy = AMPL.monetaryPolicy();
        IAmpleforthOracle cpiOracle = policy.cpiOracle();
        // TODO: Increase the time to activity to 1 week,
        (uint256 p, bool v) = cpiOracle.getData();
        v = v && p > UNDERLYING_TARGET_LOWER_BOUND && p < UNDERLYING_TARGET_UPPER_BOUND;
        return (p, v);
    }

    function getUSDPrice() external view override returns (uint256, bool) {
        (, int256 price, , uint256 updatedAt, ) = USD_ORACLE.latestRoundData();
        uint256 p = uint256(price).mulDiv(ONE, 10 ** CL_ORACLE_DECIMALS);
        bool v = (p > USD_LOWER_BOUND &&
            p < USD_UPPER_BOUND &&
            ((block.timestamp - updatedAt) <= CL_ORACLE_STALENESS_TRESHOLD_SEC));
        return (p, v);
    }
}
