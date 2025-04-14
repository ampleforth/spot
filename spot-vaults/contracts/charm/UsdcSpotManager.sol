// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { AlphaVaultHelpers } from "../_utils/AlphaVaultHelpers.sol";

import { IMetaOracle } from "../_interfaces/IMetaOracle.sol";
import { IAlphaProVault } from "../_interfaces/external/IAlphaProVault.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/// @title UsdcSpotManager
/// @notice This contract is a programmatic manager for the USDC-SPOT Charm AlphaProVault.
contract UsdcSpotManager is Ownable {
    //-------------------------------------------------------------------------
    // Libraries
    using AlphaVaultHelpers for IAlphaProVault;

    //-------------------------------------------------------------------------
    // Constants & Immutables

    /// @dev Decimals.
    uint256 public constant DECIMALS = 18;
    uint256 public constant ONE = (10 ** DECIMALS);

    /// @notice The USDC-SPOT charm alpha vault.
    IAlphaProVault public immutable VAULT;

    /// @notice The underlying USDC-SPOT univ3 pool.
    IUniswapV3Pool public immutable POOL;

    //-------------------------------------------------------------------------
    // Storage

    /// @notice The meta oracle which returns prices of AMPL asset family.
    IMetaOracle public oracle;

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

    //--------------------------------------------------------------------------
    // External write methods

    /// @notice Executes vault rebalance.
    function rebalance() public {
        (uint256 deviation, bool deviationValid) = oracle.spotPriceDeviation();

        // Execute rebalance.
        // NOTE: the vault.rebalance() will revert if enough time has not elapsed.
        // We thus override with a force rebalance.
        // https://learn.charm.fi/charm/technical-references/core/alphaprovault#rebalance
        (deviationValid && shouldForceRebalance(deviation, prevDeviation))
            ? VAULT.forceRebalance()
            : VAULT.rebalance();

        // Trim positions after rebalance.
        if (!deviationValid || shouldRemoveLimitRange(deviation)) {
            VAULT.removeLimitLiquidity(POOL);
        }

        // Update valid rebalance state.
        if (deviationValid) {
            prevDeviation = deviation;
        }
    }

    //-----------------------------------------------------------------------------
    // External/Public view methods

    /// @notice Checks if a rebalance has to be forced.
    function shouldForceRebalance(
        uint256 deviation,
        uint256 prevDeviation_
    ) public pure returns (bool) {
        // We rebalance if the deviation factor has crossed ONE (in either direction).
        return ((deviation <= ONE && prevDeviation_ > ONE) ||
            (deviation >= ONE && prevDeviation_ < ONE));
    }

    /// @notice Checks if limit range liquidity needs to be removed.
    function shouldRemoveLimitRange(uint256 deviation) public view returns (bool) {
        // We only activate the limit range liquidity, when
        // the vault sells SPOT and deviation is above ONE, or when
        // the vault buys SPOT and deviation is below ONE
        bool extraSpot = isOverweightSpot();
        bool activeLimitRange = ((deviation >= ONE && extraSpot) ||
            (deviation <= ONE && !extraSpot));
        return (!activeLimitRange);
    }

    /// @notice Checks the vault is overweight SPOT and looking to sell the extra SPOT for USDC.
    function isOverweightSpot() public view returns (bool) {
        // NOTE: In the underlying univ3 pool and token0 is USDC and token1 is SPOT.
        // Underweight Token0 implies that the limit range has less USDC and more SPOT.
        return VAULT.isUnderweightToken0();
    }

    /// @return Number of decimals representing 1.0.
    function decimals() external pure returns (uint8) {
        return uint8(DECIMALS);
    }
}
