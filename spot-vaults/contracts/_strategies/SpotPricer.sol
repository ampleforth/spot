// SPDX-License-Identifier: BUSL-1.1
// solhint-disable-next-line compiler-version
pragma solidity ^0.7.6;
pragma abicoder v2;

import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { UniswapV3PoolHelpers } from "../_utils/UniswapV3PoolHelpers.sol";

import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";
import { IERC20 } from "../_interfaces/external/IERC20.sol";
import { IWAMPL } from "../_interfaces/external/IWAMPL.sol";
import { IPerpetualTranche } from "../_interfaces/external/IPerpetualTranche.sol";
import { IChainlinkOracle } from "../_interfaces/external/IChainlinkOracle.sol";
import { IAMPL } from "../_interfaces/external/IAMPL.sol";
import { IAmpleforth } from "../_interfaces/external/IAmpleforth.sol";

import { IPerpPricer } from "../_interfaces/IPerpPricer.sol";
import { IMetaOracle } from "../_interfaces/IMetaOracle.sol";

/**
 * @title SpotPricer
 *
 * @notice A pricing oracle for SPOT, a perpetual claim on AMPL senior tranches.
 *
 *         Internally aggregates prices from multiple oracles.
 *         Chainlink for USDC and ETH prices,
 *         The Ampleforth monetary policy for the AMPL price target and
 *         UniV3 pools for current AMPL and SPOT market prices.
 *
 */
contract SpotPricer is IPerpPricer, IMetaOracle {
    using FullMath for uint256;

    //-------------------------------------------------------------------------
    // Constants

    /// @dev Standardizes prices from various oracles and returns the final value
    ///      as a fixed point number with {DECIMALS} places.
    uint256 private constant DECIMALS = 18;
    uint256 private constant ONE = (10 ** DECIMALS);

    /// @dev We bound the deviation factor to 100.0.
    uint256 public constant MAX_DEVIATION = 100 * ONE; // 100.0

    /// @dev Token denominations.
    uint256 private constant ONE_USDC = 1e6;
    uint256 private constant ONE_WETH = 1e18;
    uint256 private constant ONE_SPOT = 1e9;
    uint256 private constant ONE_AMPL = 1e9;
    uint256 private constant ONE_WAMPL = 1e18;

    /// @dev Oracle constants.
    uint256 private constant CL_ETH_ORACLE_STALENESS_THRESHOLD_SEC = 3600 * 12; // 12 hours
    uint256 private constant CL_USDC_ORACLE_STALENESS_THRESHOLD_SEC = 3600 * 48; // 2 day
    uint256 private constant USDC_UPPER_BOUND = (101 * ONE) / 100; // 1.01$
    uint256 private constant USDC_LOWER_BOUND = (99 * ONE) / 100; // 0.99$
    uint32 private constant TWAP_DURATION = 3600;

    //-------------------------------------------------------------------------
    // Storage

    /// @notice Address of the WETH-WAMPL univ3 pool.
    IUniswapV3Pool public immutable WETH_WAMPL_POOL;

    /// @notice Address of the USDC-SPOT univ3 pool.
    IUniswapV3Pool public immutable USDC_SPOT_POOL;

    /// @notice Address of the ETH token market price oracle.
    IChainlinkOracle public immutable ETH_ORACLE;

    /// @notice Address of the USD token market price oracle.
    IChainlinkOracle public immutable USDC_ORACLE;

    /// @notice Address of the Ampleforth monetary policy.
    ///         (provides the inflation-adjusted target price for AMPL)
    IAmpleforth public immutable AMPLEFORTH_POLICY;

    /// @notice Address of the WAMPL ERC-20 token contract.
    IWAMPL public immutable WAMPL;

    /// @notice Address of the USDC ERC-20 token contract.
    IERC20 public immutable USDC;

    /// @notice Address of the SPOT (perpetual tranche) ERC-20 token contract.
    IPerpetualTranche public immutable SPOT;

    /// @notice Address of the AMPL ERC-20 token contract.
    IERC20 public immutable AMPL;

    //-----------------------------------------------------------------------------
    // Constructor

    /// @notice Contract constructor.
    /// @param wethWamplPool Address of the WETH-WAMPL univ3 pool.
    /// @param usdcSpotPool Address of the USDC-SPOT univ3 pool.
    /// @param ethOracle Address of the ETH market price oracle.
    /// @param usdcOracle Address of the USD coin market price oracle.
    constructor(
        IUniswapV3Pool wethWamplPool,
        IUniswapV3Pool usdcSpotPool,
        IChainlinkOracle ethOracle,
        IChainlinkOracle usdcOracle
    ) {
        WETH_WAMPL_POOL = wethWamplPool;
        USDC_SPOT_POOL = usdcSpotPool;

        ETH_ORACLE = ethOracle;
        USDC_ORACLE = usdcOracle;

        WAMPL = IWAMPL(wethWamplPool.token1());
        USDC = IERC20(usdcSpotPool.token0());

        IPerpetualTranche spot = IPerpetualTranche(usdcSpotPool.token1());
        SPOT = spot;
        address ampl = spot.underlying();
        AMPL = IERC20(ampl);

        AMPLEFORTH_POLICY = IAmpleforth(IAMPL(ampl).monetaryPolicy());
    }

    //--------------------------------------------------------------------------
    // IPerpPricer methods

    /// @inheritdoc IPerpPricer
    function decimals() external pure override(IPerpPricer, IMetaOracle) returns (uint8) {
        return uint8(DECIMALS);
    }

    /// @inheritdoc IPerpPricer
    function usdPrice() external view override returns (uint256, bool) {
        return usdcPrice();
    }

    /// @inheritdoc IPerpPricer
    function perpUsdPrice() external view override returns (uint256, bool) {
        return spotUsdPrice();
    }

    /// @inheritdoc IPerpPricer
    function underlyingUsdPrice() external view override returns (uint256, bool) {
        return amplUsdPrice();
    }

    /// @inheritdoc IPerpPricer
    function perpFmvUsdPrice() external override returns (uint256, bool) {
        return spotFmvUsdPrice();
    }

    //--------------------------------------------------------------------------
    // IMetaOracle methods

    /// @inheritdoc IMetaOracle
    function usdcPrice() public view override returns (uint256, bool) {
        (uint256 p, bool v) = _getCLOracleData(
            USDC_ORACLE,
            CL_USDC_ORACLE_STALENESS_THRESHOLD_SEC
        );
        // If the market price of the USD coin deviated too much from 1$,
        // it's an indication of some systemic issue with the USD token
        // and thus its price should be considered unreliable.
        return (ONE, (v && p < USDC_UPPER_BOUND && p > USDC_LOWER_BOUND));
    }

    /// @inheritdoc IMetaOracle
    function spotPriceDeviation() public override returns (uint256, bool) {
        (uint256 marketPrice, bool marketPriceValid) = spotUsdPrice();
        (uint256 targetPrice, bool targetPriceValid) = spotFmvUsdPrice();
        uint256 deviation = (targetPrice > 0)
            ? marketPrice.mulDiv(ONE, targetPrice)
            : type(uint256).max;
        if (deviation > MAX_DEVIATION) {
            deviation = MAX_DEVIATION;
        }
        return (deviation, (marketPriceValid && targetPriceValid));
    }

    /// @inheritdoc IMetaOracle
    function amplPriceDeviation() public override returns (uint256, bool) {
        (uint256 marketPrice, bool marketPriceValid) = amplUsdPrice();
        (uint256 targetPrice, bool targetPriceValid) = amplTargetUsdPrice();
        uint256 deviation = (targetPrice > 0)
            ? marketPrice.mulDiv(ONE, targetPrice)
            : type(uint256).max;
        if (deviation > MAX_DEVIATION) {
            deviation = MAX_DEVIATION;
        }
        return (deviation, (marketPriceValid && targetPriceValid));
    }

    /// @inheritdoc IMetaOracle
    function spotUsdPrice() public view override returns (uint256, bool) {
        uint256 usdcPerSpot = UniswapV3PoolHelpers.calculateTwap(
            UniswapV3PoolHelpers.getTwapTick(USDC_SPOT_POOL, TWAP_DURATION),
            ONE_USDC,
            ONE_SPOT,
            ONE
        );
        (, bool usdcPriceValid) = usdcPrice();
        return (usdcPerSpot, usdcPriceValid);
    }

    /// @inheritdoc IMetaOracle
    function amplUsdPrice() public view override returns (uint256, bool) {
        (uint256 wamplPrice, bool wamplPriceValid) = wamplUsdPrice();
        uint256 amplPrice = wamplPrice.mulDiv(
            ONE_AMPL,
            WAMPL.wrapperToUnderlying(ONE_WAMPL)
        );
        return (amplPrice, wamplPriceValid);
    }

    /// @inheritdoc IMetaOracle
    function spotFmvUsdPrice() public override returns (uint256, bool) {
        (uint256 targetPrice, bool targetPriceValid) = amplTargetUsdPrice();
        return (targetPrice.mulDiv(SPOT.getTVL(), SPOT.totalSupply()), targetPriceValid);
    }

    /// @inheritdoc IMetaOracle
    function amplTargetUsdPrice() public override returns (uint256, bool) {
        // NOTE: Since {DECIMALS} == {AMPLEFORTH_POLICY_DECIMALS} == 18
        // we don't adjust the returned values.
        return AMPLEFORTH_POLICY.getTargetRate();
    }

    /// @inheritdoc IMetaOracle
    function wamplUsdPrice() public view override returns (uint256, bool) {
        uint256 wethPerWampl = UniswapV3PoolHelpers.calculateTwap(
            UniswapV3PoolHelpers.getTwapTick(WETH_WAMPL_POOL, TWAP_DURATION),
            ONE_WETH,
            ONE_WAMPL,
            ONE
        );
        (uint256 ethPrice, bool ethPriceValid) = ethUsdPrice();
        uint256 wamplPrice = ethPrice.mulDiv(wethPerWampl, ONE);
        return (wamplPrice, ethPriceValid);
    }

    /// @inheritdoc IMetaOracle
    function ethUsdPrice() public view override returns (uint256, bool) {
        return _getCLOracleData(ETH_ORACLE, CL_ETH_ORACLE_STALENESS_THRESHOLD_SEC);
    }

    //--------------------------------------------------------------------------
    // Private methods

    /// @dev Fetches price from a given Chainlink oracle.
    function _getCLOracleData(
        IChainlinkOracle oracle,
        uint256 stalenessThresholdSec
    ) private view returns (uint256, bool) {
        (, int256 p, , uint256 updatedAt, ) = oracle.latestRoundData();
        uint256 price = uint256(p).mulDiv(ONE, 10 ** oracle.decimals());
        return (price, (block.timestamp - updatedAt) <= stalenessThresholdSec);
    }
}
