// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { AlphaVaultHelpers } from "../_utils/AlphaVaultHelpers.sol";
import { Range } from "../_interfaces/types/CommonTypes.sol";

import { IMetaOracle } from "../_interfaces/IMetaOracle.sol";
import { IAlphaProVault } from "../_interfaces/external/IAlphaProVault.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/// @title UsdcSpotManager
/// @notice This contract is a programmatic manager for the USDC-SPOT Charm AlphaProVault.
///
/// @dev The vault's active zone is defined as lower and upper percentages of FMV.
///      For example, if the active zone is [0.95, 1.05]x and SPOT's FMV price is $1.35.
///      When the market price of SPOT is between [$1.28, $1.41] we consider price to be in the active zone.
///
///      When in the active zone, the vault provides concentrated liquidity around the market price.
///      When price is outside the active zone, the vault reverts to a full range position.
///
///
contract UsdcSpotManager is Ownable {
    //-------------------------------------------------------------------------
    // Libraries
    using AlphaVaultHelpers for IAlphaProVault;
    using Math for uint256;

    //-------------------------------------------------------------------------
    // Constants & Immutables

    /// @dev Decimals.
    uint256 public constant DECIMALS = 18;
    uint256 public constant ONE = (10 ** DECIMALS);

    /// @dev Vault parameter to set max full range weight (100%).
    uint24 public constant VAULT_MAX_FRW = (10 ** 6);
    int24 public constant POOL_MAX_TICK = 48000; // (-99.2/+12048.1%)

    /// @notice The USDC-SPOT charm alpha vault.
    IAlphaProVault public immutable VAULT;

    /// @notice The underlying USDC-SPOT univ3 pool.
    IUniswapV3Pool public immutable POOL;

    //-------------------------------------------------------------------------
    // Storage

    /// @notice The meta oracle which returns prices of AMPL asset family.
    IMetaOracle public oracle;

    /// @notice The lower and upper deviation factor within which
    ///         SPOT's price is considered to be in the active zone.
    Range public activeZoneDeviation;

    /// @notice The width of concentrated liquidity band,
    ///         SPOT's price is in the active zone.
    uint256 public concBandDeviationWidth;

    /// @notice The maximum USDC balance of the vault's full range position.
    uint256 public fullRangeMaxUsdcBal;

    /// @notice The maximum percentage of vault's balanced assets in the full range position.
    uint256 public fullRangeMaxPerc;

    /// @notice If price was within the active zone at the time of the last successful rebalance operation.
    bool public prevWithinActiveZone;

    //-----------------------------------------------------------------------------
    // Constructor and Initializer

    /// @notice Constructor initializes the contract with provided addresses.
    /// @param vault_ Address of the AlphaProVault contract.
    /// @param oracle_ Address of the MetaOracle contract.
    constructor(IAlphaProVault vault_, IMetaOracle oracle_) Ownable() {
        VAULT = vault_;
        POOL = vault_.pool();

        updateOracle(oracle_);

        prevWithinActiveZone = false;
        activeZoneDeviation = Range({
            lower: ((ONE * 95) / 100), // 0.95 or 95%
            upper: ((ONE * 105) / 100) // 1.05 or 105%
        });
        concBandDeviationWidth = (ONE / 20); // 0.05 or 5%
        fullRangeMaxUsdcBal = 250000 * (10 ** 6); // 250k USDC
        fullRangeMaxPerc = (ONE / 2); // 0.5 or 50%
    }

    //--------------------------------------------------------------------------
    // Owner only methods

    /// @notice Updates the MetaOracle.
    function updateOracle(IMetaOracle oracle_) public onlyOwner {
        // solhint-disable-next-line custom-errors
        require(DECIMALS == oracle_.decimals(), "UnexpectedDecimals");
        oracle = oracle_;
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

    /// @notice Updates the active zone definition.
    function updateActiveZone(Range memory activeZoneDeviation_) external onlyOwner {
        activeZoneDeviation = activeZoneDeviation_;
    }

    /// @notice Updates the width of the concentrated liquidity band.
    function updateConcentratedBand(uint256 concBandDeviationWidth_) external onlyOwner {
        concBandDeviationWidth = concBandDeviationWidth_;
    }

    /// @notice Updates the absolute and percentage maximum amount of liquidity
    ///         in the full range liquidity band.
    function updateFullRangeLiquidity(
        uint256 fullRangeMaxUsdcBal_,
        uint256 fullRangeMaxPerc_
    ) external onlyOwner {
        // solhint-disable-next-line custom-errors
        require(fullRangeMaxPerc_ <= ONE, "InvalidPerc");
        fullRangeMaxUsdcBal = fullRangeMaxUsdcBal_;
        fullRangeMaxPerc = fullRangeMaxPerc_;
    }

    //--------------------------------------------------------------------------
    // External write methods

    /// @notice Executes vault rebalance.
    function rebalance() public {
        (uint256 deviation, bool deviationValid) = oracle.spotPriceDeviation();
        bool withinActiveZone = (deviationValid && activeZone(deviation));
        bool shouldForceRebalance = (withinActiveZone != prevWithinActiveZone);

        // Set liquidity parameters.
        withinActiveZone ? _setupActiveZoneLiq(deviation) : _resetLiq();

        // Execute rebalance.
        // NOTE: the vault.rebalance() will revert if enough time has not elapsed.
        // We thus override with a force rebalance.
        // https://learn.charm.fi/charm/technical-references/core/alphaprovault#rebalance
        shouldForceRebalance ? VAULT.forceRebalance() : VAULT.rebalance();

        // Trim positions after rebalance.
        if (!withinActiveZone) {
            VAULT.trimLiquidity(POOL, ONE - activeFullRangePerc(), ONE);
            VAULT.removeLimitLiquidity(POOL);
        }

        // Update valid rebalance state.
        if (deviationValid) {
            prevWithinActiveZone = withinActiveZone;
        }
    }

    //-----------------------------------------------------------------------------
    // External/Public read methods

    /// @notice Based on the given deviation factor,
    ///         calculates if the pool needs to be in the active zone.
    function activeZone(uint256 deviation) public view returns (bool) {
        return (activeZoneDeviation.lower <= deviation &&
            deviation <= activeZoneDeviation.upper);
    }

    /// @notice Computes the percentage of liquidity to be deployed into the full range,
    ///         based on owner defined maximums.
    function activeFullRangePerc() public view returns (uint256) {
        (uint256 usdcBal, ) = VAULT.getTotalAmounts();
        return Math.min(ONE.mulDiv(fullRangeMaxUsdcBal, usdcBal), fullRangeMaxPerc);
    }

    /// @notice Checks the vault is overweight SPOT and looking to sell the extra SPOT for USDC.
    function isOverweightSpot() public view returns (bool) {
        // NOTE: In the underlying univ3 pool and token0 is USDC and token1 is SPOT.
        // Underweight Token0 implies that the limit range has less USDC and more SPOT.
        return VAULT.isUnderweightToken0();
    }

    /// @notice Calculates the Univ3 tick equivalent of the given deviation factor.
    function deviationToTicks(uint256 deviation) public pure returns (int24) {
        // 2% ~ 200 ticks -> (POOL.tickSpacing())
        // NOTE: width can't be zero, we set the minimum possible to 200.
        uint256 t = deviation.mulDiv(10000, ONE);
        t -= (t % 200);
        return (t >= 200 ? SafeCast.toInt24(SafeCast.toInt256(t)) : int24(200));
    }

    /// @return Number of decimals representing 1.0.
    function decimals() external pure returns (uint8) {
        return uint8(DECIMALS);
    }

    //-----------------------------------------------------------------------------
    // Private methods

    /// @dev Configures the vault to provide concentrated liquidity in the active zone.
    function _setupActiveZoneLiq(uint256 deviation) private {
        VAULT.setFullRangeWeight(
            SafeCast.toUint24(uint256(VAULT_MAX_FRW).mulDiv(activeFullRangePerc(), ONE))
        );

        // IMPORTANT:
        //
        // If price is exactly at the bounds of `activeZoneDeviation`,
        // the concentrated liquidity will be *at most*
        // `deviationToTicks(concBandDeviationWidth/2)` outside the bounds.
        //
        VAULT.setBaseThreshold(deviationToTicks(concBandDeviationWidth));
        VAULT.setLimitThreshold(
            deviationToTicks(
                isOverweightSpot()
                    ? Math.max(
                        activeZoneDeviation.upper - deviation,
                        concBandDeviationWidth / 2
                    )
                    : Math.max(
                        deviation - activeZoneDeviation.lower,
                        concBandDeviationWidth / 2
                    )
            )
        );
    }

    /// @dev Resets the vault to provide full range liquidity.
    function _resetLiq() private {
        VAULT.setFullRangeWeight(VAULT_MAX_FRW);
        VAULT.setBaseThreshold(POOL_MAX_TICK);
        VAULT.setLimitThreshold(POOL_MAX_TICK);
    }
}
