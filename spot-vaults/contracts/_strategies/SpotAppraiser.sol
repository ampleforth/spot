// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { ITranche } from "@ampleforthorg/spot-contracts/contracts/_interfaces/buttonwood/ITranche.sol";
import { IBondController } from "@ampleforthorg/spot-contracts/contracts/_interfaces/buttonwood/IBondController.sol";
import { IPerpetualTranche } from "@ampleforthorg/spot-contracts/contracts/_interfaces/IPerpetualTranche.sol";
import { IBalancer } from "@ampleforthorg/spot-contracts/contracts/_interfaces/IBalancer.sol";
import { IChainlinkOracle } from "../_interfaces/external/IChainlinkOracle.sol";
import { IAmpleforth } from "../_interfaces/external/IAmpleforth.sol";
import { IAmpleforthOracle } from "../_interfaces/external/IAmpleforthOracle.sol";
import { IAMPL } from "../_interfaces/external/IAMPL.sol";
import { IBillBrokerPricingStrategy } from "../_interfaces/IBillBrokerPricingStrategy.sol";
import { Range } from "../_interfaces/CommonTypes.sol";
import { InvalidPerc, InvalidSeniorCDRBound } from "../_interfaces/ProtocolErrors.sol";

/**
 * @title SpotAppraiser
 *
 * @notice Pricing strategy adapter for a BillBroker vault which accepts
 *         SPOT (as the perp token) and dollar tokens like USDC.
 *
 *         AMPL is the underlying token for SPOT.
 *         The market price of AMPL is mean reverting and eventually converges to its target.
 *         However, it can significantly deviate from the target in the near term.
 *
 *         SPOT is a perpetual claim on AMPL senior tranches. Insofar as SPOT is fully backed by
 *         healthy senior tranches, we can price spot reliably using the following strategy:
 *
 *         SPOT_PRICE = MULTIPLIER * AMPL_TARGET
 *         MULTIPLIER = spot.getTVL() / spot.totalSupply(), which is it's enrichment/debasement factor.
 *         To know more, read the spot documentation.
 *
 *         We get the AMPL target price from Ampleforth's CPI oracle,
 *         which is also used by the protocol to adjust AMPL supply through rebasing.
 *
 *         And the MULTIPLIER is directly queried from the SPOT contract.
 *
 */
contract SpotAppraiser is Ownable, IBillBrokerPricingStrategy {
    //-------------------------------------------------------------------------
    // Libraries
    using Math for uint256;

    //-------------------------------------------------------------------------
    // Constants & Immutables

    uint256 private constant DECIMALS = 18;
    uint256 private constant ONE = (10 ** DECIMALS);
    uint256 public constant CL_ORACLE_DECIMALS = 8;
    uint256 public constant CL_ORACLE_STALENESS_TRESHOLD_SEC = 3600 * 24; // 1 day
    uint256 public constant USD_LOWER_BOUND = (99 * ONE) / 100; // 0.99$
    uint256 public constant AMPL_DUST_AMT = 1000; // 1000 AMPL

    /// @notice Address of the AMPL ERC-20 token contract.
    IAMPL public immutable AMPL;

    /// @notice Address of the SPOT (perpetual tranche) ERC-20 token contract.
    IPerpetualTranche public immutable SPOT;

    /// @notice Address of the USD token market price oracle.
    IChainlinkOracle public immutable USD_ORACLE;

    /// @notice Address of the Ampleforth market price oracle.
    IChainlinkOracle public immutable AMPL_ORACLE;

    /// @notice Fixed point amount of 1.0 AMPL.
    uint256 public immutable UNIT_AMPL;

    //-------------------------------------------------------------------------
    // Storage

    /// @notice Tolerable deviation between AMPL and it's target price outside which price oracle inputs are deemed unreliable.
    Range public tolAMPLPriceDeviationPercs;

    /// @notice The minimum "deviation ratio" of the SPOT outside which it's considered unhealthy.
    uint256 public minSPOTDR;

    /// @notice The minimum CDR of senior tranches backing SPOT outside which it's considered unhealthy.
    uint256 public minSeniorCDR;

    //-----------------------------------------------------------------------------
    // Constructor

    /// @notice Contract constructor.
    /// @param ampl Address of the AMPL token.
    /// @param spot Address of the SPOT token.
    /// @param usdOracle Address of the USD token market price oracle token.
    /// @param amplOracle Address of the AMPL market price oracle token.
    constructor(
        IAMPL ampl,
        IPerpetualTranche spot,
        IChainlinkOracle usdOracle,
        IChainlinkOracle amplOracle
    ) Ownable() {
        AMPL = ampl;
        SPOT = spot;
        AMPL_ORACLE = amplOracle;
        USD_ORACLE = usdOracle;
        UNIT_AMPL = 10 ** IERC20Metadata(address(AMPL)).decimals();

        tolAMPLPriceDeviationPercs = Range({
            lower: (ONE * 8) / 10, // 0.8
            upper: (ONE * 7) / 4 // 1.75
        });
        minSPOTDR = (ONE * 8) / 10; // 0.8
        minSeniorCDR = (ONE * 5) / 4; // 125%
    }

    //--------------------------------------------------------------------------
    // Owner only methods

    /// @notice Controls the tolerable AMPL price volatility outside which the pricing strategy is considered unreliable.
    /// @param tolAMPLPriceDeviationPercs_ The lower and upper percentage deviation of AMPL price.
    function updateAllowedPriceDeviationPercs(
        Range memory tolAMPLPriceDeviationPercs_
    ) external onlyOwner {
        if (
            tolAMPLPriceDeviationPercs_.lower > ONE ||
            tolAMPLPriceDeviationPercs_.upper < ONE
        ) {
            revert InvalidPerc();
        }
        tolAMPLPriceDeviationPercs = tolAMPLPriceDeviationPercs_;
    }

    /// @notice Controls the minimum `deviationRatio` ratio of SPOT below which SPOT is considered unhealthy.
    /// @param minSPOTDR_ The minimum SPOT `deviationRatio`.
    function updateMinSPOTDR(uint256 minSPOTDR_) external onlyOwner {
        minSPOTDR = minSPOTDR_;
    }

    /// @notice Controls the minimum CDR of SPOT's senior tranche below which SPOT is considered unhealthy.
    /// @param minSeniorCDR_ The minimum senior tranche CDR.
    function updateMinPerpCollateralCDR(uint256 minSeniorCDR_) external onlyOwner {
        if (minSeniorCDR_ < ONE) {
            revert InvalidSeniorCDRBound();
        }
        minSeniorCDR = minSeniorCDR_;
    }

    //--------------------------------------------------------------------------
    // External methods

    /// @return p The price of the usd token in dollars.
    /// @return v True if the price is valid and can be used by downstream consumers.
    function usdPrice() external view override returns (uint256, bool) {
        (uint256 p, bool v) = _getCLOracleData(USD_ORACLE);
        // If the market price of the USD coin fallen too much below 1$,
        // it's an indication of some systemic issue with the USD token
        // and thus its price should be considered unreliable.
        return (ONE, (v && p > USD_LOWER_BOUND));
    }

    /// @return p The price of the spot token in dollars.
    /// @return v True if the price is valid and can be used by downstream consumers.
    function perpPrice() external override returns (uint256, bool) {
        //
        // TODO:
        // Go through governance to increase the delay time of cpi oracle to 1 week,
        // This ensures there's enough time to react to BEA's PCE data issues.
        // OR we could store the previous targetPrice in the contract state and ensure
        // that is hasn't deviated too much. (TBD)
        //
        IAmpleforth policy = AMPL.monetaryPolicy();
        IAmpleforthOracle cpiOracle = policy.cpiOracle();
        (uint256 targetPrice, bool targetPriceValid) = cpiOracle.getData();

        // We calculate the deviation of the market price from the target.
        // If AMPL market price has deviated too much from the target,
        // its an indication that the market is currently too volatile
        // and the current strategy of pricing spot based on the AMPL
        // target is unreliable.
        //
        // Recall, that though AMPL price eventually returns to the target
        // there could be periods of time in the short/medium term when
        // it is significantly away from the target.
        (uint256 marketPrice, bool marketPriceValid) = _getCLOracleData(AMPL_ORACLE);
        uint256 priceDeviationPerc = marketPrice.mulDiv(ONE, targetPrice);
        bool amplTooVolatile = (priceDeviationPerc < tolAMPLPriceDeviationPercs.lower ||
            priceDeviationPerc > tolAMPLPriceDeviationPercs.upper);

        uint256 p = targetPrice.mulDiv(SPOT.getTVL(), SPOT.totalSupply());
        bool v = (targetPriceValid &&
            marketPriceValid &&
            !amplTooVolatile &&
            isSPOTHealthy());
        return (p, v);
    }

    /// @return Number of decimals representing a price of 1.0 USD.
    function decimals() external pure override returns (uint8) {
        return uint8(DECIMALS);
    }

    //-----------------------------------------------------------------------------
    // Public methods

    /// @return If the spot token is healthy.
    function isSPOTHealthy() public view returns (bool) {
        // If the SPOT's `deviationRatio` is lower than the defined bound
        // i.e) it doesn't have enough capital to cover future rollovers,
        // we consider it unhealthy.
        IBalancer balancer = SPOT.balancer();
        uint256 spotDR = balancer.deviationRatio().mulDiv(ONE, 10 ** balancer.decimals());
        if (spotDR < minSPOTDR) {
            return false;
        }

        // We compute the CDR of all the senior tranches backing perp.
        // If any one of the seniors is mature or has a CDR below below the defined minimum,
        // we consider it unhealthy.
        // NOTE: Any CDR below 100%, means that the tranche is impaired
        // and is roughly equivalent to holding AMPL.
        uint8 reserveCount = uint8(SPOT.reserveCount());
        for (uint8 i = 1; i < reserveCount; i++) {
            ITranche tranche = ITranche(address(SPOT.reserveAt(i)));
            IBondController bond = IBondController(tranche.bond());
            if (bond.isMature()) {
                return false;
            }
            uint256 seniorCDR = AMPL.balanceOf(address(bond)).mulDiv(
                ONE,
                tranche.totalSupply()
            );
            if (seniorCDR < minSeniorCDR) {
                return false;
            }
        }

        // If SPOT has ANY raw AMPL as collateral, we consider it unhealthy.
        // NOTE: In practice some dust might exist or someone could grief this check
        // by transferring some dust AMPL into the spot contract.
        // We consider SPOT unhealthy if it has more than `AMPL_DUST_AMT` AMPL.
        if (AMPL.balanceOf(address(SPOT)) > (AMPL_DUST_AMT * UNIT_AMPL)) {
            return false;
        }

        return true;
    }

    //-----------------------------------------------------------------------------
    // Private methods

    /// @dev Fetches most recent report from the given chain link oracle contract.
    ///      The data is considered invalid if the latest report is stale.
    function _getCLOracleData(
        IChainlinkOracle oracle
    ) private view returns (uint256, bool) {
        (, int256 p, , uint256 updatedAt, ) = oracle.latestRoundData();
        uint256 price = uint256(p).mulDiv(10 ** DECIMALS, 10 ** CL_ORACLE_DECIMALS);
        return (price, (block.timestamp - updatedAt) <= CL_ORACLE_STALENESS_TRESHOLD_SEC);
    }
}
