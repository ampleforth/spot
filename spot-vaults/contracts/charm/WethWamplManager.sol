// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { AlphaVaultHelpers } from "../_utils/AlphaVaultHelpers.sol";
import { LineHelpers } from "../_utils/LineHelpers.sol";
import { Line } from "../_interfaces/types/CommonTypes.sol";

import { IMetaOracle } from "../_interfaces/IMetaOracle.sol";
import { IAlphaProVault } from "../_interfaces/external/IAlphaProVault.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/// @title WethWamplManager
/// @notice This contract is a programmatic manager for the WETH-WAMPL Charm AlphaProVault.
contract WethWamplManager is Ownable {
    //-------------------------------------------------------------------------
    // Libraries
    using AlphaVaultHelpers for IAlphaProVault;
    using SafeCast for uint256;
    using LineHelpers for Line;

    //-------------------------------------------------------------------------
    // Constants & Immutables

    /// @dev Decimals.
    uint256 public constant DECIMALS = 18;
    uint256 public constant ONE = (10 ** DECIMALS);

    /// @dev At all times active liquidity percentage is no lower than 20%.
    uint256 public constant MIN_ACTIVE_LIQ_PERC = ONE / 5; // 20%

    /// @notice The WETH-WAMPL charm alpha vault.
    IAlphaProVault public immutable VAULT;

    /// @notice The underlying WETH-WAMPL univ3 pool.
    IUniswapV3Pool public immutable POOL;

    //-------------------------------------------------------------------------
    // Storage

    /// @notice The meta oracle which returns prices of AMPL asset family.
    IMetaOracle public oracle;

    //-------------------------------------------------------------------------
    // Active percentage calculation parameters
    //
    // The deviation factor (or deviation) is defined as the ratio between
    // AMPL's current market price and its target price.
    // The deviation is 1.0, when AMPL is at the target.
    //
    // The active liquidity percentage (a value between 20% to 100%)
    // is computed based on pair-wise linear function, defined by the contract owner.
    //
    // If the current deviation is below ONE, function f1 is used
    // else function f2 is used. Both f1 and f2 are defined by the owner.
    // They are lines, with 2 {x,y} coordinates. The x coordinates are deviation factors,
    // and y coordinates are active liquidity percentages.
    //
    // Both deviation and active liquidity percentage and represented internally
    // as a fixed-point number with {DECIMALS} places.
    //

    /// @notice Active percentage calculation function for when deviation is below ONE.
    Line public activeLiqPercFn1;

    /// @notice Active percentage calculation function for when deviation is above ONE.
    Line public activeLiqPercFn2;

    /// @notice The delta between the current and last recorded active liquidity percentage values
    ///         outside which a rebalance is executed forcefully.
    uint256 public tolerableActiveLiqPercDelta;

    /// @notice The recorded deviation factor at the time of the last successful rebalance operation.
    uint256 public prevDeviation;

    //-----------------------------------------------------------------------------
    // Constructor and Initializer

    /// @notice Constructor initializes the contract with provided addresses.
    /// @param vault_ Address of the AlphaProVault contract.
    /// @param oracle_ Address of the MetaOracle contract.
    constructor(IAlphaProVault vault_, IMetaOracle oracle_) Ownable() {
        VAULT = vault_;
        POOL = vault_.pool();

        updateOracle(oracle_);

        activeLiqPercFn1 = Line({
            x1: ONE / 2, // 0.5
            y1: ONE / 5, // 20%
            x2: ONE, // 1.0
            y2: ONE // 100%
        });
        activeLiqPercFn2 = Line({
            x1: ONE, // 1.0
            y1: ONE, // 100%
            x2: ONE * 2, // 2.0
            y2: ONE / 5 // 20%
        });

        tolerableActiveLiqPercDelta = ONE / 10; // 10%
        prevDeviation = 0;
    }

    //--------------------------------------------------------------------------
    // Owner only methods

    /// @notice Updates the MetaOracle.
    function updateOracle(IMetaOracle oracle_) public onlyOwner {
        // solhint-disable-next-line custom-errors
        require(DECIMALS == oracle_.decimals(), "UnexpectedDecimals");
        oracle = oracle_;
    }

    /// @notice Updates the vault's liquidity range parameters.
    function setLiquidityRanges(
        int24 baseThreshold,
        uint24 fullRangeWeight,
        int24 limitThreshold
    ) external onlyOwner {
        // Update liquidity parameters on the vault.
        VAULT.setBaseThreshold(baseThreshold);
        VAULT.setFullRangeWeight(fullRangeWeight);
        VAULT.setLimitThreshold(limitThreshold);
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
        require(success, "VaultExecutionFailed");
        return r;
    }

    /// @notice Updates the active liquidity percentage calculation parameters.
    function setActivePercParams(
        uint256 tolerableActiveLiqPercDelta_,
        Line memory activeLiqPercFn1_,
        Line memory activeLiqPercFn2_
    ) external onlyOwner {
        tolerableActiveLiqPercDelta = tolerableActiveLiqPercDelta_;
        activeLiqPercFn1 = activeLiqPercFn1_;
        activeLiqPercFn2 = activeLiqPercFn2_;
    }

    //--------------------------------------------------------------------------
    // External write methods

    /// @notice Executes vault rebalance.
    function rebalance() public {
        // Get the current deviation factor.
        (uint256 deviation, bool deviationValid) = oracle.amplPriceDeviation();

        // Calculate the active liquidity percentages.
        uint256 activeLiqPerc = deviationValid
            ? computeActiveLiqPerc(deviation)
            : MIN_ACTIVE_LIQ_PERC;
        uint256 prevActiveLiqPerc = computeActiveLiqPerc(prevDeviation);
        uint256 activeLiqPercDelta = (activeLiqPerc > prevActiveLiqPerc)
            ? activeLiqPerc - prevActiveLiqPerc
            : prevActiveLiqPerc - activeLiqPerc;

        // Execute rebalance.
        // NOTE: the vault.rebalance() will revert if enough time has not elapsed.
        // We thus override with a force rebalance.
        // https://learn.charm.fi/charm/technical-references/core/alphaprovault#rebalance
        (deviationValid &&
            shouldForceRebalance(deviation, prevDeviation, activeLiqPercDelta))
            ? VAULT.forceRebalance()
            : VAULT.rebalance();

        // Trim positions after rebalance.
        VAULT.trimLiquidity(POOL, ONE - activeLiqPerc, ONE);
        if (!deviationValid || shouldRemoveLimitRange(deviation)) {
            VAULT.removeLimitLiquidity(POOL);
        }

        // Update valid rebalance state.
        if (deviationValid) {
            prevDeviation = deviation;
        }
    }

    //-----------------------------------------------------------------------------
    // External Public view methods

    /// @notice Computes active liquidity percentage based on the provided deviation factor.
    /// @return The computed active liquidity percentage.
    function computeActiveLiqPerc(uint256 deviation) public view returns (uint256) {
        Line memory fn = (deviation <= ONE) ? activeLiqPercFn1 : activeLiqPercFn2;
        return fn.computeY(deviation, MIN_ACTIVE_LIQ_PERC, ONE);
    }

    /// @notice Checks if a rebalance has to be forced.
    function shouldForceRebalance(
        uint256 deviation,
        uint256 prevDeviation_,
        uint256 activeLiqPercDelta
    ) public view returns (bool) {
        // We have to rebalance out of turn
        //   - if the active liquidity perc has deviated significantly, or
        //   - if the deviation factor has crossed ONE (in either direction).
        return
            (activeLiqPercDelta > tolerableActiveLiqPercDelta) ||
            ((deviation <= ONE && prevDeviation_ > ONE) ||
                (deviation >= ONE && prevDeviation_ < ONE));
    }

    /// @notice Checks if limit range liquidity needs to be removed.
    function shouldRemoveLimitRange(uint256 deviation) public view returns (bool) {
        // We only activate the limit range liquidity, when
        // the vault sells WAMPL and deviation is above ONE, or when
        // the vault buys WAMPL and deviation is below ONE
        bool extraWampl = isOverweightWampl();
        bool activeLimitRange = ((deviation >= ONE && extraWampl) ||
            (deviation <= ONE && !extraWampl));
        return (!activeLimitRange);
    }

    /// @notice Checks the vault is overweight WAMPL,
    ///         and looking to sell the extra WAMPL for WETH.
    function isOverweightWampl() public view returns (bool) {
        // NOTE: In the underlying univ3 pool and token0 is WETH and token1 is WAMPL.
        // Underweight Token0 implies that the limit range has less WETH and more WAMPL.
        return VAULT.isUnderweightToken0();
    }

    /// @return Number of decimals representing 1.0.
    function decimals() external pure returns (uint8) {
        return uint8(DECIMALS);
    }
}
