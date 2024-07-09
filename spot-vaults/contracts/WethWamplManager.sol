// SPDX-License-Identifier: BUSL-1.1
// solhint-disable-next-line compiler-version
pragma solidity ^0.7.6;
pragma abicoder v2;

import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { PositionKey } from "@uniswap/v3-periphery/contracts/libraries/PositionKey.sol";
import { SafeCast } from "@uniswap/v3-core/contracts/libraries/SafeCast.sol";

import { IAlphaProVault } from "./_interfaces/external/IAlphaProVault.sol";
import { IChainlinkOracle } from "./_interfaces/external/IChainlinkOracle.sol";
import { IAmpleforthOracle } from "./_interfaces/external/IAmpleforthOracle.sol";
import { IWAMPL } from "./_interfaces/external/IWAMPL.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/// @title WethWamplManager
/// @notice This contract is a programmatic manager for the WETH-WAMPL Charm AlphaProVault.
contract WethWamplManager {
    /// @dev Constants for AMPL and WAMPL units and supply limits.
    uint256 public constant ONE_AMPL = 1e9;
    uint256 public constant ONE_WAMPL = 1e18;

    /// @dev Decimals.
    uint256 public constant DECIMALS = 18;
    uint256 public constant ONE = (10 ** DECIMALS);

    /// @dev At all times active liquidity percentage is no lower than 25%.
    uint256 public constant MIN_ACTIVE_LIQ_PERC = ONE / 4; // 25%

    /// @dev We bound the deviation factor to 100.0.
    uint256 public constant MAX_DEVIATION = 100 * ONE; // 100.0

    /// @dev Oracle constants.
    uint256 public constant CL_ORACLE_STALENESS_THRESHOLD_SEC = 3600 * 24; // 1 day

    //-------------------------------------------------------------------------
    // Storage

    /// @notice The WETH-WAMPL charm alpha vault.
    IAlphaProVault public immutable VAULT;

    /// @notice The underlying WETH-WAMPL univ3 pool.
    IUniswapV3Pool public immutable POOL;

    /// @notice The vault's token0, the WETH token.
    address public immutable WETH;

    /// @notice The vault's token1, the WAMPL token.
    IWAMPL public immutable WAMPL;

    /// @notice The cpi oracle which returns AMPL's price target in USD.
    IAmpleforthOracle public cpiOracle;

    /// @notice The chainlink oracle which returns ETH's current USD price.
    IChainlinkOracle public ethOracle;

    /// @notice The contract owner.
    address public owner;

    //-------------------------------------------------------------------------
    // Active percentage calculation parameters
    //
    // The deviation factor (or deviation) is defined as the ratio between
    // AMPL's current market price and its target price.
    // The deviation is 1.0, when AMPL is at the target.
    //
    // The active liquidity percentage (a value between 5% to 100%)
    // is computed based on pair-wise linear function, defined by the contract owner.
    //
    // If the current deviation is below the deviation cutoff, function f1 is used
    // else function f2 is used. Both f1 and f2 are defined by the owner.
    // They are lines, with 2 {x,y} coordinates. The x coordinates are deviation factors,
    // and y coordinates are active liquidity percentages.
    //
    // Both deviation and active liquidity percentage and represented internally
    // as a fixed-point number with {DECIMALS} places.
    //
    /// @notice The deviation cutoff which determines if either f1 or f2 is used
    ///         to compute the active liquidity percentage.
    uint256 public deviationCutoff;

    /// @notice A data structure to define a geometric Line with two points.
    struct Line {
        // x-coordinate of the first point.
        uint256 x1;
        // y-coordinate of the first point.
        uint256 y1;
        // x-coordinate of the second point.
        uint256 x2;
        // y-coordinate of the second point.
        uint256 y2;
    }

    /// @notice Active percentage calculation function for when deviation is below the cutoff.
    Line public activeLiqPercFn1;

    /// @notice Active percentage calculation function for when deviation is above the cutoff.
    Line public activeLiqPercFn2;

    /// @notice The recorded active liquidity percentage at the time of the last successful rebalance operation.
    uint256 public lastActiveLiqPerc;

    /// @notice The delta between the current and last recorded active liquidity percentage values
    ///         outside which a rebalance is executed forcefully.
    uint256 public tolerableActiveLiqPercDelta;

    //-------------------------------------------------------------------------
    // Limit range parameters
    //
    // Based on the deviation, the manager selectively updates the vault's limit threshold values.
    //
    // If the deviation is above the cutoff and the vault is WAMPL heavy,
    // Or if the deviation is below the cutoff and the vault is WETH heavy,
    // vault chooses a narrow limit range.
    // Otherwise, the vault uses a wide limit range.
    //
    // This strategy attempts to reduce IL using knowledge about the behavior of AMPL.
    // Put simply, The vault tries NOT to sell AMPL below the cutoff or buy AMPL above the cutoff.

    /// @notice The narrow limit range, in univ3 ticks.
    int24 public limitThresholdNarrow;

    /// @notice The default wide limit range, in univ3 ticks.
    int24 public limitThresholdWide;

    //--------------------------------------------------------------------------
    // Modifiers

    modifier onlyOwner() {
        // solhint-disable-next-line custom-errors
        require(msg.sender == owner, "Unauthorized caller");
        _;
    }

    //-----------------------------------------------------------------------------
    // Constructor and Initializer

    /// @notice Constructor initializes the contract with provided addresses.
    /// @param vault_ Address of the AlphaProVault contract.
    /// @param cpiOracle_ Address of the Ampleforth CPI oracle contract.
    /// @param ethOracle_ Address of the Chainlink ETH price oracle contract.
    constructor(
        IAlphaProVault vault_,
        IAmpleforthOracle cpiOracle_,
        IChainlinkOracle ethOracle_
    ) {
        owner = msg.sender;

        VAULT = vault_;
        POOL = vault_.pool();
        WETH = vault_.token0();
        WAMPL = IWAMPL(vault_.token1());

        cpiOracle = cpiOracle_;
        ethOracle = ethOracle_;

        deviationCutoff = ONE; // 1.0
        activeLiqPercFn1 = Line({
            x1: (ONE * 7) / 10, // 0.7
            y1: ONE / 4, // 25%
            x2: (ONE * 95) / 100, // 0.95
            y2: ONE // 100%
        });
        activeLiqPercFn2 = Line({
            x1: (ONE * 120) / 100, // 1.2
            y1: ONE, // 100%
            x2: (ONE * 5) / 2, // 2.5
            y2: ONE / 4 // 25%
        });
        lastActiveLiqPerc = ONE; // 100%
        tolerableActiveLiqPercDelta = ONE / 10; // 10%

        limitThresholdNarrow = 3200; // [-27.4%, 37.7%]
        limitThresholdWide = 887200; // ~Inf
    }

    //--------------------------------------------------------------------------
    // Owner only methods

    /// @notice Updates the owner role.
    function transferOwnership(address owner_) external onlyOwner {
        owner = owner_;
    }

    /// @notice Updates the ampleforth cpi oracle.
    function setCpiOracle(IAmpleforthOracle cpiOracle_) external onlyOwner {
        cpiOracle = cpiOracle_;
    }

    /// @notice Updates the chainlink eth usd price oracle.
    function setEthOracle(IChainlinkOracle ethOracle_) external onlyOwner {
        ethOracle = ethOracle_;
    }

    /// @notice Updates the active liquidity percentage calculation parameters.
    function setActivePercParams(
        uint256 deviationCutoff_,
        uint256 tolerableActiveLiqPercDelta_,
        Line memory activeLiqPercFn1_,
        Line memory activeLiqPercFn2_
    ) external onlyOwner {
        deviationCutoff = deviationCutoff_;
        tolerableActiveLiqPercDelta = tolerableActiveLiqPercDelta_;
        activeLiqPercFn1 = activeLiqPercFn1_;
        activeLiqPercFn2 = activeLiqPercFn2_;
    }

    /// @notice Updates the vault's liquidity range parameters.
    function setLiquidityRanges(
        int24 baseThreshold,
        uint24 fullRangeWeight,
        int24 limitThresholdNarrow_,
        int24 limitThresholdWide_
    ) external onlyOwner {
        // Update the base and full range parameters on the vault
        VAULT.setBaseThreshold(baseThreshold);
        VAULT.setFullRangeWeight(fullRangeWeight);

        // Update the limit range parameters on the manager
        limitThresholdNarrow = limitThresholdNarrow_;
        limitThresholdWide = limitThresholdWide_;
        VAULT.setLimitThreshold(limitThresholdWide_);
    }

    /// @notice Forwards the given calldata to the vault.
    /// @param callData The calldata to pass to the vault.
    /// @return The data returned by the vault method call.
    function execOnVault(
        bytes calldata callData
    ) external onlyOwner returns (bytes memory) {
        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory r) = address(VAULT).call(callData);
        // solhint-disable-next-line custom-errors
        require(success, "Vault call failed");
        return r;
    }

    //--------------------------------------------------------------------------
    // External write methods

    /// @notice Executes vault rebalance.
    function rebalance() public {
        uint256 deviation = computeDeviationFactor();
        uint256 activeLiqPerc = computeActiveLiqPerc(deviation);

        // Update limit range.
        inNarrowLimitRange(deviation)
            ? VAULT.setLimitThreshold(limitThresholdNarrow)
            : VAULT.setLimitThreshold(limitThresholdWide);

        // Execute rebalance.
        // NOTE: the vault.rebalance() will revert if enough time has not elapsed.
        // We thus override with a force rebalance.
        // https://learn.charm.fi/charm/technical-references/core/alphaprovault#rebalance
        uint256 activeLiqPercDelta = activeLiqPerc > lastActiveLiqPerc
            ? (activeLiqPerc - lastActiveLiqPerc)
            : (lastActiveLiqPerc - activeLiqPerc);
        activeLiqPercDelta > tolerableActiveLiqPercDelta
            ? _execForceRebalance()
            : VAULT.rebalance();

        // Trim position after rebalance.
        _trimLiquidity(activeLiqPerc);

        // Update the active liquidity percentage
        lastActiveLiqPerc = activeLiqPerc;
    }

    /// @notice Computes the deviation between AMPL's market price and target.
    /// @return The computed deviation factor.
    function computeDeviationFactor() public returns (uint256) {
        (uint256 ethUSDPrice, bool ethPriceValid) = getEthUSDPrice();
        uint256 marketPrice = getAmplUSDPrice(ethUSDPrice);
        (uint256 targetPrice, bool targetPriceValid) = _getAmpleforthOracleData(
            cpiOracle
        );
        uint256 deviation = (ethPriceValid && targetPriceValid)
            ? FullMath.mulDiv(marketPrice, ONE, targetPrice)
            : 0;
        return (deviation > MAX_DEVIATION) ? MAX_DEVIATION : deviation;
    }

    //-----------------------------------------------------------------------------
    // External Public view methods

    /// @notice Computes active liquidity percentage based on the provided deviation factor.
    /// @return The computed active liquidity percentage.
    function computeActiveLiqPerc(uint256 deviation) public view returns (uint256) {
        return
            (deviation <= deviationCutoff)
                ? _computeActiveLiqPerc(activeLiqPercFn1, deviation)
                : _computeActiveLiqPerc(activeLiqPercFn2, deviation);
    }

    /// @notice Checks if the vault is in the narrow limit range based on the current deviation factor.
    function inNarrowLimitRange(uint256 deviation) public view returns (bool) {
        int24 _marketPrice = VAULT.getTwap();
        int24 _limitLower = VAULT.limitLower();
        int24 _limitUpper = VAULT.limitUpper();
        int24 _limitPrice = (_limitLower + _limitUpper) / 2;
        // The limit range has more WAMPL than WETH if `_marketPrice >= _limitPrice`,
        // so the vault looks to sell WAMPL.
        // NOTE: This assumes that in the underlying univ3 pool
        // token0 is WETH and token1 is WAMPL.
        bool isWamplAsk = (_marketPrice >= _limitPrice);
        return ((deviation >= deviationCutoff && isWamplAsk) ||
            (deviation <= deviationCutoff && !isWamplAsk));
    }

    /// @notice Computes the AMPL price in USD.
    /// @param ethUSDPrice The ETH price in USD.
    /// @return The computed AMPL price in USD.
    function getAmplUSDPrice(uint256 ethUSDPrice) public view returns (uint256) {
        return
            FullMath.mulDiv(
                getWamplUSDPrice(ethUSDPrice),
                ONE_AMPL,
                WAMPL.wrapperToUnderlying(ONE_WAMPL) // #AMPL per WAMPL
            );
    }

    /// @notice Computes the WAMPL price in USD based on ETH price.
    /// @param ethUSDPrice The ETH price in USD.
    /// @return The computed WAMPL price in USD.
    function getWamplUSDPrice(uint256 ethUSDPrice) public view returns (uint256) {
        // We first get the WETH-WAMPL price from the pool and then convert that
        // to a USD price using the given ETH-USD price.
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(VAULT.getTwap());
        uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
        // NOTE: Since both weth and wampl have 18 decimals,
        // we don't adjust the `wamplPerWeth`.
        uint256 wamplPerWeth = FullMath.mulDiv(ONE, ratioX192, (1 << 192));
        return FullMath.mulDiv(ethUSDPrice, ONE, wamplPerWeth);
    }

    /// @notice Fetches the current ETH price in USD from the Chainlink oracle.
    /// @return The ETH price in USD and its validity.
    function getEthUSDPrice() public view returns (uint256, bool) {
        return _getCLOracleData(ethOracle);
    }

    /// @return Number of decimals representing 1.0.
    function decimals() external pure returns (uint8) {
        return uint8(DECIMALS);
    }

    //-----------------------------------------------------------------------------
    // Private methods

    /// @dev Trims the vault's current liquidity based on the active liquidity percentage.
    ///      To be invoked right after a rebalance operation, as it assumes that all of the vault's
    ///      liquidity has been deployed before trimming.
    function _trimLiquidity(uint256 activePerc) private {
        int24 _fullLower = VAULT.fullLower();
        int24 _fullUpper = VAULT.fullUpper();

        int24 _baseLower = VAULT.baseLower();
        int24 _baseUpper = VAULT.baseUpper();

        (uint128 fullLiquidity, , , , ) = _position(_fullLower, _fullUpper);
        (uint128 baseLiquidity, , , , ) = _position(_baseLower, _baseUpper);

        // Calculated baseLiquidityToBurn, baseLiquidityToBurn will be lesser than fullLiquidity, baseLiquidity
        // Thus, there's no risk of overflow.
        uint128 fullLiquidityToBurn = uint128(
            FullMath.mulDiv(uint256(fullLiquidity), ONE - activePerc, ONE)
        );
        uint128 baseLiquidityToBurn = uint128(
            FullMath.mulDiv(uint256(baseLiquidity), ONE - activePerc, ONE)
        );

        // docs: https://learn.charm.fi/charm/technical-references/core/alphaprovault#emergencyburn
        VAULT.emergencyBurn(_fullLower, _fullUpper, fullLiquidityToBurn);
        VAULT.emergencyBurn(_baseLower, _baseUpper, baseLiquidityToBurn);
        // NOTE: Limit liquidity remains unchanged here.
    }

    /// @dev Fetches most recent report from the given ampleforth oracle contract.
    ///      The returned report is a fixed point number with {DECIMALS} places.
    function _getAmpleforthOracleData(
        IAmpleforthOracle oracle
    ) private returns (uint256, bool) {
        (uint256 p, bool valid) = oracle.getData();
        return (FullMath.mulDiv(p, ONE, 10 ** oracle.DECIMALS()), valid);
    }

    /// @dev A low-level method, which interacts directly with the vault and executes
    ///      a rebalance even when enough time hasn't elapsed since the last rebalance.
    function _execForceRebalance() private {
        uint32 _period = VAULT.period();
        VAULT.setPeriod(0);
        VAULT.rebalance();
        VAULT.setPeriod(_period);
    }

    /// @dev Wrapper around `IUniswapV3Pool.positions()`.
    function _position(
        int24 tickLower,
        int24 tickUpper
    ) private view returns (uint128, uint256, uint256, uint128, uint128) {
        bytes32 positionKey = PositionKey.compute(address(VAULT), tickLower, tickUpper);
        return POOL.positions(positionKey);
    }

    /// @dev Fetches most recent report from the given chain link oracle contract.
    ///      The data is considered invalid if the latest report is stale.
    ///      The returned report is a fixed point number with {DECIMALS} places.
    function _getCLOracleData(
        IChainlinkOracle oracle
    ) private view returns (uint256, bool) {
        (, int256 p, , uint256 updatedAt, ) = oracle.latestRoundData();
        uint256 price = FullMath.mulDiv(uint256(p), ONE, 10 ** oracle.decimals());
        return (
            price,
            (block.timestamp - updatedAt) <= CL_ORACLE_STALENESS_THRESHOLD_SEC
        );
    }

    /// @dev We compute activeLiqPerc value given a linear fn and deviation.
    function _computeActiveLiqPerc(
        Line memory fn,
        uint256 deviation
    ) private pure returns (uint256) {
        deviation = (deviation > MAX_DEVIATION) ? MAX_DEVIATION : deviation;
        int256 dlY = SafeCast.toInt256(fn.y2) - SafeCast.toInt256(fn.y1);
        int256 dlX = SafeCast.toInt256(fn.x2) - SafeCast.toInt256(fn.x1);
        int256 activeLiqPerc = SafeCast.toInt256(fn.y2) +
            (((SafeCast.toInt256(deviation) - SafeCast.toInt256(fn.x2)) * dlY) / dlX);
        activeLiqPerc = (activeLiqPerc < int256(MIN_ACTIVE_LIQ_PERC))
            ? int256(MIN_ACTIVE_LIQ_PERC)
            : activeLiqPerc;
        activeLiqPerc = (activeLiqPerc > int256(ONE)) ? int256(ONE) : activeLiqPerc;
        // Casting from int256 to uint256 here is safe as activeLiqPerc >= 0.
        return uint256(activeLiqPerc);
    }
}
