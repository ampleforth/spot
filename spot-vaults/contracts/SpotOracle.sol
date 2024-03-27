// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";

import { IChainlinkOracle } from "./_interfaces/external/IChainlinkOracle.sol";
import { IAMPL, IAmpleforth, IAmpleforthOracle } from "./_interfaces/external/IAmpleforth.sol";
import { IBillBrokerOracle } from "./_interfaces/IBillBrokerOracle.sol";

contract SpotOracle is IBillBrokerOracle {
    using MathUpgradeable for uint256;
    IAMPL public immutable AMPL;
    IPerpetualTranche public immutable SPOT;
    IChainlinkOracle public immutable AMPL_ORACLE;
    IChainlinkOracle public immutable USD_ORACLE;

    uint256 private constant DECIMALS = 18;
    uint256 private constant ONE = (10 ** DECIMALS);

    uint256 public constant CL_ORACLE_DECIMALS = 8;
    uint256 public constant CL_ORACLE_STALENESS_TRESHOLD_SEC = 3600 * 24;

    uint256 public constant USD_LOWER_BOUND = (99 * ONE) / 100;
    uint256 public constant USD_UPPER_BOUND = (101 * ONE) / 100;

    uint256 public constant AMPL_PRICE_DEVIATION_PERC_MIN = ONE / 2; // 0.5
    uint256 public constant AMPL_PRICE_DEVIATION_PERC_MAX = 2 * ONE; // 2.0
    uint256 public constant SPOT_MATURE_PERC_MIN = ONE / 2; // 50%

    constructor(IAMPL ampl, IPerpetualTranche spot, IChainlinkOracle amplOracle, IChainlinkOracle usdOracle) {
        AMPL = ampl;
        SPOT = spot;
        AMPL_ORACLE = amplOracle;
        USD_ORACLE = usdOracle;
    }

    function decimals() external pure override returns (uint8) {
        return uint8(DECIMALS);
    }

    function perp() external view override returns (IPerpetualTranche) {
        return SPOT;
    }

    function underlying() external view override returns (IERC20Upgradeable) {
        return AMPL;
    }

    function getPerpPrice() external override returns (uint256, bool) {
        // AMPL is the underlying token for SPOT.
        // The market price of AMPL is mean reverting and eventually converges to its target.
        // However, it can significantly deviate from the target in the near term.
        //
        // When AMPL's market prices hasn't deviated "too much" (as defined by the bounds)
        // from it's target, we use the long-run equilibrium price or the
        // target price to calculate the rough value of SPOT tokens.
        //
        // SPOT_PRICE = MULTIPLIER * AMPL_TARGET
        // MULTIPLIER = spot.getTVL() / spot.totalSupply(), which is it's enrichment/debasement factor.
        // To know more, read the spot documentation.
        //
        // We get the AMPL target price from AMPL's CPI oracle, which is also used by the protocol
        // to calculate the daily rebase percentage.
        //
        // TODO: Increase go through governance to increase the delay time of cpi oracle to 1 week,
        //       This ensures there's enough time to react to BEA's PCE data issues.
        //
        // OR we could store the previous targetPrice in the contract state and ensure
        // that is hasn't deviated too much. (TBD)
        IAmpleforth policy = AMPL.monetaryPolicy();
        IAmpleforthOracle cpiOracle = policy.cpiOracle();
        (uint256 targetPrice, bool targetPriceValid) = cpiOracle.getData();

        // We calculate the deviation of the market price from the target.
        // If AMPL market price has deviated too much from the target,
        // its an indication that the market is currently too volatile
        // and thus the oracle price might not be reliable.
        (uint256 marketPrice, bool marketPriceValid) = _getChainlinkOraclePrice(AMPL_ORACLE);
        uint256 deviationPerc = marketPrice.mulDiv(ONE, targetPrice);

        // We calculate the percentage of perp reserve which are held as raw AMPL.
        // A high percentage indicates the market could be too volatile and
        // prices may be unreliable.
        SPOT.recover();
        uint256 perpTVL = SPOT.getTVL();
        uint256 perpSupply = SPOT.totalSupply();
        uint256 maturePerc = AMPL.balanceOf(address(SPOT)).mulDiv(ONE, perpTVL);

        uint256 perpPrice = targetPrice.mulDiv(perpTVL, perpPrice);
        bool validity = (targetPriceValid &&
            marketPriceValid &&
            deviationPerc > AMPL_PRICE_DEVIATION_PERC_MIN &&
            deviationPerc < AMPL_PRICE_DEVIATION_PERC_MAX &&
            maturePerc < AMPL_PRICE_DEVIATION_PERC);
        return (perpPrice, validity);
    }

    function getUSDPrice() external view override returns (uint256, bool) {
        (uint256 price, bool valid) = _getChainlinkOraclePrice(USD_ORACLE);
        // If the market price of the USD coin has deviated too much from 1$,
        // it's an indication of some systemic issue
        // and thus the oracle price might not be reliable.
        return (price, (valid && price > USD_LOWER_BOUND && price < USD_UPPER_BOUND));
    }

    function _getChainlinkOraclePrice(IChainlinkOracle oracle) private view returns (uint256, bool) {
        (, int256 p, , uint256 updatedAt, ) = oracle.latestRoundData();
        uint256 price = uint256(p).mulDiv(10 ** DECIMALS, 10 ** CL_ORACLE_DECIMALS);
        return (price, (block.timestamp - updatedAt) <= CL_ORACLE_STALENESS_TRESHOLD_SEC);
    }
}
