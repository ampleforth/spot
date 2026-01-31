// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { ERC20BurnableUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IERC20MetadataUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";

import { IPerpetualTranche } from "@ampleforthorg/spot-contracts/contracts/_interfaces/IPerpetualTranche.sol";
import { IRolloverVault } from "@ampleforthorg/spot-contracts/contracts/_interfaces/IRolloverVault.sol";
import { ERC20Helpers } from "@ampleforthorg/spot-contracts/contracts/_utils/ERC20Helpers.sol";
import { Range } from "./_interfaces/types/CommonTypes.sol";
import { UnauthorizedCall, InvalidPerc, InvalidRange } from "./_interfaces/errors/CommonErrors.sol";
import { InvalidDRBound, LastRebalanceTooRecent, SlippageTooHigh } from "./_interfaces/errors/DRBalancerErrors.sol";

/**
 *  @title DRBalancerVault
 *
 *  @notice A vault that holds underlying (e.g., AMPL) and perp (SPOT) tokens as liquidity,
 *          and auto-rebalances to help maintain the SYSTEM's target deviation ratio
 *          via IRolloverVault swaps.
 *
 *          The system's deviation ratio (DR) is defined by FeePolicy.
 *          When DR < 1 (under-subscribed): perpTVL is higher than it needs to be
 *          When DR > 1 (over-subscribed): perpTVL is lower than it needs to be
 *
 *          This vault monitors the system DR and:
 *          - When DR is below equilibrium: redeems perps to decrease perpTVL
 *          - When DR is above equilibrium: mints perps to increase perpTVL
 *
 *          LPs deposit underlying tokens and receive vault notes. They can redeem their notes
 *          for a proportional share of the vault's underlying and perp holdings.
 */
contract DRBalancerVault is
    ERC20BurnableUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    //-------------------------------------------------------------------------
    // Libraries

    using SafeERC20Upgradeable for IERC20Upgradeable;
    using SafeERC20Upgradeable for IPerpetualTranche;
    using ERC20Helpers for IERC20Upgradeable;
    using MathUpgradeable for uint256;

    //-------------------------------------------------------------------------
    // Constants

    uint256 public constant DECIMALS = 18;
    uint256 public constant ONE = (10 ** DECIMALS);

    /// @dev DR values use 8 decimals to match FeePolicy.
    uint256 public constant DR_DECIMALS = 8;
    uint256 public constant DR_ONE = (10 ** DR_DECIMALS);

    //-------------------------------------------------------------------------
    // Storage

    /// @notice The underlying rebasing token (e.g., AMPL).
    IERC20Upgradeable public underlying;

    /// @notice The perpetual tranche token (SPOT).
    IPerpetualTranche public perp;

    /// @notice The rollover vault used for underlying<->perp swaps.
    IRolloverVault public rolloverVault;

    /// @notice The fixed-point amount of underlying tokens equivalent to 1.0.
    uint256 public underlyingUnitAmt;

    /// @notice The fixed-point amount of perp tokens equivalent to 1.0.
    uint256 public perpUnitAmt;

    /// @notice Reference to the address that has the ability to pause/unpause operations.
    address public keeper;

    /// @notice The target system deviation ratio (typically 1.0 = DR_ONE, using 8 decimals).
    uint256 public targetDR;

    /// @notice The equilibrium DR range where no rebalancing occurs (using 8 decimals).
    /// @dev When system DR is within this range, the system is considered balanced.
    Range public equilibriumDR;

    /// @notice The lag factor for underlying->perp swaps (when DR is low).
    uint256 public lagFactorUnderlyingToPerp;

    /// @notice The lag factor for perp->underlying swaps (when DR is high).
    uint256 public lagFactorPerpToUnderlying;

    /// @notice The min/max percentage of TVL for underlying->perp swaps.
    Range public rebalancePercLimitsUnderlyingToPerp;

    /// @notice The min/max percentage of TVL for perp->underlying swaps.
    Range public rebalancePercLimitsPerpToUnderlying;

    /// @notice Minimum seconds between rebalances.
    uint256 public rebalanceFreqSec;

    /// @notice Timestamp of the last rebalance.
    uint256 public lastRebalanceTimestampSec;

    /// @notice Maximum swap fee percentage allowed during rebalance (slippage protection).
    uint256 public maxSwapFeePerc;

    //--------------------------------------------------------------------------
    // Events

    /// @notice Emitted when a user deposits underlying tokens.
    event Deposit(
        address indexed depositor,
        uint256 underlyingAmtIn,
        uint256 notesMinted
    );

    /// @notice Emitted when a user redeems vault notes.
    event Redeem(
        address indexed redeemer,
        uint256 notesBurnt,
        uint256 underlyingAmtOut,
        uint256 perpAmtOut
    );

    /// @notice Emitted when the vault rebalances to adjust system DR.
    /// @param drBefore The system deviation ratio before rebalance.
    /// @param drAfter The system deviation ratio after rebalance.
    /// @param underlyingAmt The amount of underlying involved in the swap.
    /// @param isUnderlyingIntoPerp True if underlying was swapped for perps, false if perps were swapped for underlying.
    event Rebalance(
        uint256 drBefore,
        uint256 drAfter,
        uint256 underlyingAmt,
        bool isUnderlyingIntoPerp
    );

    //--------------------------------------------------------------------------
    // Modifiers

    /// @dev Throws if called by any account other than the keeper.
    modifier onlyKeeper() {
        if (msg.sender != keeper) {
            revert UnauthorizedCall();
        }
        _;
    }

    //-----------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Contract initializer.
    /// @param name ERC-20 Name of the vault LP token.
    /// @param symbol ERC-20 Symbol of the vault LP token.
    /// @param underlying_ Address of the underlying token.
    /// @param perp_ Address of the perp token.
    /// @param rolloverVault_ Address of the rollover vault for swaps.
    function init(
        string memory name,
        string memory symbol,
        IERC20Upgradeable underlying_,
        IPerpetualTranche perp_,
        IRolloverVault rolloverVault_
    ) public initializer {
        __ERC20_init(name, symbol);
        __ERC20Burnable_init();
        __Ownable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        underlying = underlying_;
        perp = perp_;
        rolloverVault = rolloverVault_;

        underlyingUnitAmt =
            10 ** IERC20MetadataUpgradeable(address(underlying_)).decimals();
        perpUnitAmt = 10 ** IERC20MetadataUpgradeable(address(perp_)).decimals();

        updateKeeper(owner());

        // Default configuration
        // Target DR is 1.0 (system in balance) with 8 decimals
        targetDR = DR_ONE;
        // Equilibrium zone: 95% - 105% (matches FeePolicy defaults) with 8 decimals
        equilibriumDR = Range({
            lower: (DR_ONE * 95) / 100,
            upper: (DR_ONE * 105) / 100
        });
        // Default lag factors
        lagFactorUnderlyingToPerp = 3;
        lagFactorPerpToUnderlying = 3;
        // Min/max percentage of this vault's TVL per rebalance: 10% - 50%
        rebalancePercLimitsUnderlyingToPerp = Range({ lower: ONE / 10, upper: ONE / 2 });
        rebalancePercLimitsPerpToUnderlying = Range({ lower: ONE / 10, upper: ONE / 2 });
        rebalanceFreqSec = 86400; // 1 day
        maxSwapFeePerc = ONE / 100; // 1% default max fee
    }

    //--------------------------------------------------------------------------
    // Owner only methods

    /// @notice Updates the reference to the keeper.
    /// @param keeper_ The address of the new keeper.
    function updateKeeper(address keeper_) public onlyOwner {
        keeper = keeper_;
    }

    /// @notice Updates the target system deviation ratio.
    /// @param targetDR_ The new target DR as a fixed point number with 8 decimals.
    function updateTargetDR(uint256 targetDR_) external onlyOwner {
        targetDR = targetDR_;
    }

    /// @notice Updates the equilibrium DR range.
    /// @param equilibriumDR_ The new equilibrium DR range.
    function updateEquilibriumDR(Range memory equilibriumDR_) external onlyOwner {
        if (equilibriumDR_.lower > equilibriumDR_.upper) {
            revert InvalidDRBound();
        }
        equilibriumDR = equilibriumDR_;
    }

    /// @notice Updates the rebalance configuration for underlying->perp swaps (when DR is low).
    /// @param lagFactor_ The new lag factor.
    /// @param rebalancePercLimits_ The new min/max rebalance percentage limits.
    function updateRebalanceConfigUnderlyingToPerp(
        uint256 lagFactor_,
        Range memory rebalancePercLimits_
    ) external onlyOwner {
        if (rebalancePercLimits_.lower > rebalancePercLimits_.upper) {
            revert InvalidRange();
        }
        lagFactorUnderlyingToPerp = lagFactor_;
        rebalancePercLimitsUnderlyingToPerp = rebalancePercLimits_;
    }

    /// @notice Updates the rebalance configuration for perp->underlying swaps (when DR is high).
    /// @param lagFactor_ The new lag factor.
    /// @param rebalancePercLimits_ The new min/max rebalance percentage limits.
    function updateRebalanceConfigPerpToUnderlying(
        uint256 lagFactor_,
        Range memory rebalancePercLimits_
    ) external onlyOwner {
        if (rebalancePercLimits_.lower > rebalancePercLimits_.upper) {
            revert InvalidRange();
        }
        lagFactorPerpToUnderlying = lagFactor_;
        rebalancePercLimitsPerpToUnderlying = rebalancePercLimits_;
    }

    /// @notice Updates the rebalance frequency.
    /// @param rebalanceFreqSec_ The new rebalance frequency in seconds.
    function updateRebalanceFreqSec(uint256 rebalanceFreqSec_) external onlyOwner {
        rebalanceFreqSec = rebalanceFreqSec_;
    }

    /// @notice Updates the maximum swap fee percentage allowed during rebalance.
    /// @param maxSwapFeePerc_ The new maximum swap fee percentage.
    function updateMaxSwapFeePerc(uint256 maxSwapFeePerc_) external onlyOwner {
        if (maxSwapFeePerc_ > ONE) {
            revert InvalidPerc();
        }
        maxSwapFeePerc = maxSwapFeePerc_;
    }

    //--------------------------------------------------------------------------
    // Keeper only methods

    /// @notice Pauses deposits, withdrawals and rebalances.
    function pause() external onlyKeeper {
        _pause();
    }

    /// @notice Unpauses deposits, withdrawals and rebalances.
    function unpause() external onlyKeeper {
        _unpause();
    }

    //--------------------------------------------------------------------------
    // External & Public write methods

    /// @notice Deposits underlying tokens and mints vault notes (LP tokens).
    /// @param underlyingAmtIn The amount of underlying tokens to deposit.
    /// @return notesMinted The amount of vault notes minted.
    function deposit(
        uint256 underlyingAmtIn
    ) external nonReentrant whenNotPaused returns (uint256 notesMinted) {
        if (underlyingAmtIn <= 0) {
            return 0;
        }

        notesMinted = computeMintAmt(underlyingAmtIn);
        if (notesMinted <= 0) {
            return 0;
        }

        // Transfer underlying tokens from the user
        underlying.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // Mint vault notes to the user
        _mint(msg.sender, notesMinted);

        emit Deposit(msg.sender, underlyingAmtIn, notesMinted);
    }

    /// @notice Burns vault notes and returns proportional underlying and perp tokens.
    /// @param notesAmt The amount of vault notes to burn.
    /// @return underlyingAmtOut The amount of underlying tokens returned.
    /// @return perpAmtOut The amount of perp tokens returned.
    function redeem(
        uint256 notesAmt
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 underlyingAmtOut, uint256 perpAmtOut)
    {
        (underlyingAmtOut, perpAmtOut) = computeRedemptionAmts(notesAmt);
        if (underlyingAmtOut <= 0 && perpAmtOut <= 0) {
            return (0, 0);
        }

        // Burn vault notes
        _burn(msg.sender, notesAmt);

        // Return funds
        if (underlyingAmtOut > 0) {
            underlying.safeTransfer(msg.sender, underlyingAmtOut);
        }
        if (perpAmtOut > 0) {
            perp.safeTransfer(msg.sender, perpAmtOut);
        }

        emit Redeem(msg.sender, notesAmt, underlyingAmtOut, perpAmtOut);
    }

    /// @notice Rebalances to help maintain the system's target deviation ratio.
    /// @dev Can only be called after rebalance frequency period has elapsed.
    ///      Swaps underlying<->perps via the rollover vault to push system DR toward equilibrium.
    function rebalance() external nonReentrant whenNotPaused {
        // Enforce rebalance frequency
        if (block.timestamp < lastRebalanceTimestampSec + rebalanceFreqSec) {
            revert LastRebalanceTooRecent();
        }

        // Query perp state once before any swaps
        uint256 perpTVL = perp.getTVL();
        uint256 perpTotalSupply = perp.totalSupply();

        uint256 drBefore = getSystemDeviationRatio();
        (
            uint256 underlyingValSwapped,
            bool isUnderlyingIntoPerp
        ) = _computeRebalanceAmount(drBefore, perpTVL, perpTotalSupply);

        if (underlyingValSwapped <= 0) {
            lastRebalanceTimestampSec = block.timestamp;
            emit Rebalance(drBefore, drBefore, 0, isUnderlyingIntoPerp);
            return;
        }

        uint256 underlyingValOut;
        if (isUnderlyingIntoPerp) {
            // DR too high: perpTVL is too low, mint perps to increase it
            underlying.checkAndApproveMax(address(rolloverVault), underlyingValSwapped);
            uint256 perpAmtOut = rolloverVault.swapUnderlyingForPerps(
                underlyingValSwapped
            );
            // Convert perp output to underlying value using pre-swap price
            underlyingValOut = perpAmtOut.mulDiv(perpTVL, perpTotalSupply);
        } else {
            // DR too low: perpTVL is too high, redeem perps to decrease it
            // Convert underlying value to perp amount using pre-swap price
            uint256 perpAmtIn = underlyingValSwapped.mulDiv(perpTotalSupply, perpTVL);
            IERC20Upgradeable(address(perp)).checkAndApproveMax(
                address(rolloverVault),
                perpAmtIn
            );
            underlyingValOut = rolloverVault.swapPerpsForUnderlying(perpAmtIn);
        }

        // Check slippage: compare underlying value out to underlying value in
        uint256 feePerc = ONE - underlyingValOut.mulDiv(ONE, underlyingValSwapped);
        if (feePerc > maxSwapFeePerc) {
            revert SlippageTooHigh();
        }

        uint256 drAfter = getSystemDeviationRatio();
        lastRebalanceTimestampSec = block.timestamp;

        emit Rebalance(drBefore, drAfter, underlyingValSwapped, isUnderlyingIntoPerp);
    }

    //-----------------------------------------------------------------------------
    // Public methods

    /// @notice Computes the amount of vault notes minted for a given underlying deposit.
    /// @param underlyingAmtIn The amount of underlying tokens to deposit.
    /// @return notesMinted The amount of vault notes that would be minted.
    function computeMintAmt(
        uint256 underlyingAmtIn
    ) public returns (uint256 notesMinted) {
        uint256 totalSupply_ = totalSupply();

        if (underlyingAmtIn <= 0) {
            return 0;
        }

        notesMinted = (totalSupply_ > 0)
            ? totalSupply_.mulDiv(underlyingAmtIn, getTVL())
            : underlyingAmtIn.mulDiv(ONE, underlyingUnitAmt);
    }

    /// @notice Computes the amounts of underlying and perp tokens returned for burning vault notes.
    /// @param notesAmt The amount of vault notes to burn.
    /// @return underlyingAmtOut The amount of underlying tokens returned.
    /// @return perpAmtOut The amount of perp tokens returned.
    function computeRedemptionAmts(
        uint256 notesAmt
    ) public view returns (uint256 underlyingAmtOut, uint256 perpAmtOut) {
        if (notesAmt <= 0) {
            return (0, 0);
        }

        uint256 totalSupply_ = totalSupply();
        if (totalSupply_ <= 0) {
            return (0, 0);
        }

        underlyingAmtOut = underlying.balanceOf(address(this)).mulDiv(
            notesAmt,
            totalSupply_
        );
        perpAmtOut = perp.balanceOf(address(this)).mulDiv(notesAmt, totalSupply_);
    }

    /// @notice Returns this vault's total value locked in underlying denomination.
    /// @return tvl The TVL of this vault (underlying + perp value).
    function getTVL() public returns (uint256 tvl) {
        uint256 underlyingBal = underlying.balanceOf(address(this));
        uint256 perpBal = perp.balanceOf(address(this));

        // Perp value = perpBalance * perpTVL / perpTotalSupply
        uint256 perpValue = 0;
        uint256 perpTotalSupply = perp.totalSupply();
        if (perpTotalSupply > 0 && perpBal > 0) {
            perpValue = perpBal.mulDiv(perp.getTVL(), perpTotalSupply);
        }

        tvl = underlyingBal + perpValue;
    }

    /// @notice Returns the current SYSTEM deviation ratio from the rollover vault.
    /// @dev DR = vaultTVL / perpTVL / targetSystemRatio (as defined in FeePolicy)
    /// @return The system deviation ratio as a fixed point number with 8 decimals.
    function getSystemDeviationRatio() public returns (uint256) {
        return rolloverVault.deviationRatio();
    }

    /// @notice Computes the amount of underlying to swap for rebalancing the system DR.
    /// @return underlyingAmt The amount of underlying involved in the swap.
    /// @return isUnderlyingIntoPerp True if should swap underlying for perps, false otherwise.
    function computeRebalanceAmount()
        public
        returns (uint256 underlyingAmt, bool isUnderlyingIntoPerp)
    {
        return
            _computeRebalanceAmount(
                getSystemDeviationRatio(),
                perp.getTVL(),
                perp.totalSupply()
            );
    }

    /// @dev Computes rebalance amount based on perpTVL.
    ///
    /// System context:
    ///   DR = rolloverVaultTVL / perpTVL / targetSystemRatio
    ///   When DR < 1: perpTVL is too high, redeem perps to decrease it
    ///   When DR > 1: perpTVL is too low, mint perps to increase it
    ///
    /// Formula:
    ///   Since rolloverVaultTVL doesn't change during flash mint/redeem:
    ///   requiredChange = perpTVL × |dr - targetDR|
    ///
    /// Liquidity limits are based on swap direction:
    ///   - DR < 1 (redeem perps): limit by perpValue held by this vault
    ///   - DR > 1 (mint perps): limit by underlying balance held by this vault
    ///
    /// Example 1: DR = 0.80 (too low, redeem perps)
    ///   Given: perpTVL = 10,000, perpValue = 2,000 (this vault's perp holdings)
    ///   - drDelta = 1.0 - 0.80 = 0.20
    ///   - requiredChange = 10,000 × 0.20 = 2,000
    ///   - adjustedChange = 2,000 / 3 (lagFactor) = 666
    ///   - availableLiquidity = 2,000 (perpValue)
    ///   - minAmt = 2,000 × 10% = 200, maxAmt = 2,000 × 50% = 1,000
    ///   - 666 is within [200, 1,000], so underlyingAmt = 666
    ///   - Result: Redeem 666 AMPL worth of perps
    ///
    /// Example 2: DR = 1.20 (too high, mint perps)
    ///   Given: perpTVL = 10,000, underlyingBalance = 5,000
    ///   - drDelta = 1.20 - 1.0 = 0.20
    ///   - requiredChange = 10,000 × 0.20 = 2,000
    ///   - adjustedChange = 2,000 / 3 = 666
    ///   - availableLiquidity = 5,000 (underlyingBalance)
    ///   - minAmt = 500, maxAmt = 2,500
    ///   - 666 is within [500, 2,500], so underlyingAmt = 666
    ///   - Result: Swap 666 AMPL for perps
    ///
    /// Example 3: Large perp holdings with overshoot prevention
    ///   Given: perpTVL = 10,000, perpValue = 50,000, DR = 0.80
    ///   - requiredChange = 2,000, adjustedChange = 2,000 / 3 = 666
    ///   - availableLiquidity = 50,000 (perpValue)
    ///   - minAmt = 5,000, maxAmt = 25,000
    ///   - 666 < 5,000, so underlyingAmt = 5,000 (clipped to min)
    ///   - But 5,000 > requiredChange (2,000), so underlyingAmt = 2,000 (overshoot prevention)
    ///   - Result: Redeem 2,000 AMPL worth of perps
    ///
    function _computeRebalanceAmount(
        uint256 dr,
        uint256 perpTVL,
        uint256 perpTotalSupply
    ) private view returns (uint256 underlyingAmt, bool isUnderlyingIntoPerp) {
        // Skip if in equilibrium zone
        if (dr >= equilibriumDR.lower && dr <= equilibriumDR.upper) {
            return (0, true);
        }

        if (perpTVL <= 0) {
            return (0, true);
        }

        // Determine direction, magnitude, and available liquidity for the swap
        // If DR < target: perpTVL is too high, redeem perps to decrease it
        // If DR > target: perpTVL is too low, mint perps to increase it
        uint256 drDelta;
        uint256 lagFactor_;
        Range memory percLimits;
        uint256 availableLiquidity;

        if (dr < targetDR) {
            isUnderlyingIntoPerp = false;
            drDelta = targetDR - dr;
            lagFactor_ = lagFactorPerpToUnderlying;
            percLimits = rebalancePercLimitsPerpToUnderlying;
            // Swapping perps for underlying: limit by perp balance (in underlying terms)
            availableLiquidity = perp.balanceOf(address(this)).mulDiv(
                perpTVL,
                perpTotalSupply
            );
        } else {
            isUnderlyingIntoPerp = true;
            drDelta = dr - targetDR;
            lagFactor_ = lagFactorUnderlyingToPerp;
            percLimits = rebalancePercLimitsUnderlyingToPerp;
            // Swapping underlying for perps: limit by underlying balance
            availableLiquidity = underlying.balanceOf(address(this));
        }

        // Compute required change:
        // Since rolloverVaultTVL doesn't change during flash mint/redeem,
        // only perpTVL changes, so: requiredChange = perpTVL × |dr - targetDR|
        uint256 requiredChange = perpTVL.mulDiv(drDelta, DR_ONE);

        // Apply lag factor (gradual adjustment)
        uint256 adjustedChange = requiredChange / lagFactor_;

        // Clip by min/max percentage of this vault's available liquidity for the swap direction
        uint256 minAmt = availableLiquidity.mulDiv(percLimits.lower, ONE);
        uint256 maxAmt = availableLiquidity.mulDiv(percLimits.upper, ONE);

        if (adjustedChange < minAmt) {
            underlyingAmt = minAmt;
        } else if (adjustedChange > maxAmt) {
            underlyingAmt = maxAmt;
        } else {
            underlyingAmt = adjustedChange;
        }

        // Prevent overshoot: don't swap more than required
        if (underlyingAmt > requiredChange) {
            underlyingAmt = requiredChange;
        }
    }

    //-----------------------------------------------------------------------------
    // External view methods

    /// @notice Returns the underlying token balance held by this vault.
    /// @return The underlying token balance.
    function underlyingBalance() external view returns (uint256) {
        return underlying.balanceOf(address(this));
    }

    /// @notice Returns the perp token balance held by this vault.
    /// @return The perp token balance.
    function perpBalance() external view returns (uint256) {
        return perp.balanceOf(address(this));
    }
}
