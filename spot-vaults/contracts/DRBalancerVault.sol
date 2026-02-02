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
import { UnauthorizedCall, InvalidPerc } from "./_interfaces/errors/CommonErrors.sol";
import { LastRebalanceTooRecent, SlippageTooHigh, InvalidLagFactor } from "./_interfaces/errors/DRBalancerErrors.sol";

/**
 *  @title DRBalancerVault
 *
 *  @notice A vault that holds underlying (e.g., AMPL) and perp (SPOT) tokens as liquidity,
 *          and auto-rebalances to help maintain the SYSTEM's target deviation ratio
 *          via IRolloverVault swaps.
 *
 *          The system's deviation ratio (DR) is defined by FeePolicy:
 *            DR = stamplTVL / perpTVL / targetSystemRatio
 *
 *          When DR < 1 (under-subscribed): perpTVL is too high, redeem perps to decrease it
 *          When DR > 1 (over-subscribed): perpTVL is too low, mint perps to increase it
 *
 *          LPs deposit underlying and/or perp tokens and receive vault notes. They can redeem
 *          their notes for a proportional share of the vault's underlying and perp holdings.
 *
 *  @dev Rebalance Math:
 *
 *       Since stamplTVL doesn't change during flash mint/redeem:
 *         requiredChange = perpTVL × |dr - targetDR|
 *         adjustedChange = requiredChange / lagFactor
 *
 *       The adjusted change is capped by:
 *         - minRebalanceVal: skip rebalance if below this threshold
 *         - availableLiquidity: perp value (DR < 1) or underlying balance (DR > 1)
 *         - requiredChange: prevent overshoot
 *
 *       Example: DR = 0.80 (too low, redeem perps)
 *         Given: perpTVL = 10,000, lagFactor = 3, minRebalanceVal = 100
 *         - drDelta = 1.0 - 0.80 = 0.20
 *         - requiredChange = 10,000 × 0.20 = 2,000
 *         - adjustedChange = 2,000 / 3 = 666
 *         - 666 >= minRebalanceVal, so proceed
 *         - Result: Redeem 666 AMPL worth of perps (capped by available liquidity)
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

    /// @notice The STAMPL rollover vault used for underlying<->perp swaps.
    IRolloverVault public stampl;

    /// @notice The fixed-point amount of underlying tokens equivalent to 1.0.
    uint256 public underlyingUnitAmt;

    /// @notice The fixed-point amount of perp tokens equivalent to 1.0.
    uint256 public perpUnitAmt;

    /// @notice Reference to the address that has the ability to pause/unpause operations.
    address public keeper;

    /// @notice The target system deviation ratio (typically 1.0 = DR_ONE, using 8 decimals).
    uint256 public targetDR;

    /// @notice The lag factor for underlying->perp swaps (when DR is high).
    uint256 public lagFactorUnderlyingToPerp;

    /// @notice The lag factor for perp->underlying swaps (when DR is low).
    uint256 public lagFactorPerpToUnderlying;

    /// @notice Minimum rebalance amount per rebalance (underlying denominated).
    uint256 public minRebalanceVal;

    /// @notice Minimum seconds between rebalances.
    uint256 public rebalanceFreqSec;

    /// @notice Timestamp of the last rebalance.
    uint256 public lastRebalanceTimestampSec;

    /// @notice Maximum swap fee percentage allowed during rebalance (slippage protection).
    uint256 public maxSwapFeePerc;

    //--------------------------------------------------------------------------
    // Events

    /// @notice Emitted when a user deposits tokens.
    event Deposited(
        address indexed depositor,
        uint256 underlyingAmtIn,
        uint256 perpAmtIn,
        uint256 notesMinted
    );

    /// @notice Emitted when a user redeems vault notes.
    event Redeemed(
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
    event Rebalanced(
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
    /// @param stampl_ Address of the STAMPL rollover vault for swaps.
    function init(
        string memory name,
        string memory symbol,
        IERC20Upgradeable underlying_,
        IPerpetualTranche perp_,
        IRolloverVault stampl_
    ) public initializer {
        __ERC20_init(name, symbol);
        __ERC20Burnable_init();
        __Ownable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        underlying = underlying_;
        perp = perp_;
        stampl = stampl_;

        underlyingUnitAmt =
            10 ** IERC20MetadataUpgradeable(address(underlying_)).decimals();
        perpUnitAmt = 10 ** IERC20MetadataUpgradeable(address(perp_)).decimals();

        updateKeeper(owner());

        // Default configuration
        // Target DR is 1.0 (system in balance) with 8 decimals
        targetDR = DR_ONE;
        // Default lag factors
        lagFactorUnderlyingToPerp = 3;
        lagFactorPerpToUnderlying = 3;
        // Minimum rebalance amount (in underlying token units)
        minRebalanceVal = 0;
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

    /// @notice Updates the lag factors for rebalancing.
    /// @param lagFactorUnderlyingToPerp_ The new lag factor for underlying->perp swaps.
    /// @param lagFactorPerpToUnderlying_ The new lag factor for perp->underlying swaps.
    function updateLagFactors(
        uint256 lagFactorUnderlyingToPerp_,
        uint256 lagFactorPerpToUnderlying_
    ) external onlyOwner {
        if (lagFactorUnderlyingToPerp_ <= 0 || lagFactorPerpToUnderlying_ <= 0) {
            revert InvalidLagFactor();
        }
        lagFactorUnderlyingToPerp = lagFactorUnderlyingToPerp_;
        lagFactorPerpToUnderlying = lagFactorPerpToUnderlying_;
    }

    /// @notice Updates the minimum rebalance amount.
    /// @param minRebalanceVal_ The new minimum underlying amount to deploy per rebalance.
    function updateMinRebalanceAmt(uint256 minRebalanceVal_) external onlyOwner {
        minRebalanceVal = minRebalanceVal_;
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

    /// @notice Deposits underlying and/or perp tokens and mints vault notes (LP tokens).
    /// @param underlyingAmtMax The maximum amount of underlying tokens to deposit.
    /// @param perpAmtMax The maximum amount of perp tokens to deposit.
    /// @param minNotesMinted The minimum amount of vault notes to mint (slippage protection).
    /// @return notesMinted The amount of vault notes minted.
    function deposit(
        uint256 underlyingAmtMax,
        uint256 perpAmtMax,
        uint256 minNotesMinted
    ) external nonReentrant whenNotPaused returns (uint256 notesMinted) {
        uint256 underlyingAmtIn;
        uint256 perpAmtIn;
        (notesMinted, underlyingAmtIn, perpAmtIn) = computeMintAmt(
            underlyingAmtMax,
            perpAmtMax
        );

        if (notesMinted <= 0) {
            return 0;
        }

        if (notesMinted < minNotesMinted) {
            revert SlippageTooHigh();
        }

        // Transfer tokens from the user
        if (underlyingAmtIn > 0) {
            underlying.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);
        }
        if (perpAmtIn > 0) {
            perp.safeTransferFrom(msg.sender, address(this), perpAmtIn);
        }

        // Mint vault notes to the user
        _mint(msg.sender, notesMinted);

        emit Deposited(msg.sender, underlyingAmtIn, perpAmtIn, notesMinted);
    }

    /// @notice Burns vault notes and returns proportional underlying and perp tokens.
    /// @param notesAmt The amount of vault notes to burn.
    /// @param minUnderlyingAmtOut The minimum amount of underlying tokens to receive (slippage protection).
    /// @param minPerpAmtOut The minimum amount of perp tokens to receive (slippage protection).
    /// @return underlyingAmtOut The amount of underlying tokens returned.
    /// @return perpAmtOut The amount of perp tokens returned.
    function redeem(
        uint256 notesAmt,
        uint256 minUnderlyingAmtOut,
        uint256 minPerpAmtOut
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

        if (underlyingAmtOut < minUnderlyingAmtOut || perpAmtOut < minPerpAmtOut) {
            revert SlippageTooHigh();
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

        emit Redeemed(msg.sender, notesAmt, underlyingAmtOut, perpAmtOut);
    }

    /// @notice Rebalances to help maintain the system's target deviation ratio.
    /// @dev Can only be called after rebalance frequency period has elapsed.
    ///      Swaps underlying<->perps via STAMPL to push system DR toward equilibrium.
    function rebalance() external nonReentrant whenNotPaused {
        // Enforce rebalance frequency
        if (block.timestamp < lastRebalanceTimestampSec + rebalanceFreqSec) {
            revert LastRebalanceTooRecent();
        }

        // Query perp state once before any swaps
        uint256 perpTVL = perp.getTVL();
        uint256 perpTotalSupply = perp.totalSupply();

        uint256 drBefore = stampl.deviationRatio();
        (
            uint256 underlyingValSwapped,
            bool isUnderlyingIntoPerp
        ) = _computeRebalanceAmount(drBefore, perpTVL, perpTotalSupply);

        if (underlyingValSwapped <= 0) {
            lastRebalanceTimestampSec = block.timestamp;
            emit Rebalanced(drBefore, drBefore, 0, isUnderlyingIntoPerp);
            return;
        }

        uint256 underlyingValOut;
        if (isUnderlyingIntoPerp) {
            // DR too high: perpTVL is too low, mint perps to increase it
            underlying.checkAndApproveMax(address(stampl), underlyingValSwapped);
            uint256 perpAmtMint = stampl.swapUnderlyingForPerps(underlyingValSwapped);
            // Convert perp output to underlying value using pre-swap price
            underlyingValOut = perpAmtMint.mulDiv(perpTVL, perpTotalSupply);
        } else {
            // DR too low: perpTVL is too high, redeem perps to decrease it
            // Convert underlying value to perp amount using pre-swap price
            uint256 perpAmtToRedeem = underlyingValSwapped.mulDiv(
                perpTotalSupply,
                perpTVL
            );
            IERC20Upgradeable(address(perp)).checkAndApproveMax(
                address(stampl),
                perpAmtToRedeem
            );
            underlyingValOut = stampl.swapPerpsForUnderlying(perpAmtToRedeem);
        }

        // Check slippage: compare underlying value out to underlying value in
        uint256 feePerc = ONE - underlyingValOut.mulDiv(ONE, underlyingValSwapped);
        if (feePerc > maxSwapFeePerc) {
            revert SlippageTooHigh();
        }

        uint256 drAfter = stampl.deviationRatio();
        lastRebalanceTimestampSec = block.timestamp;

        emit Rebalanced(drBefore, drAfter, underlyingValSwapped, isUnderlyingIntoPerp);
    }

    //-----------------------------------------------------------------------------
    // Public methods

    /// @notice Computes the amount of vault notes minted for a given deposit of underlying and/or perp tokens.
    /// @param underlyingAmtMax The maximum amount of underlying tokens to deposit.
    /// @param perpAmtMax The maximum amount of perp tokens to deposit.
    /// @return notesMinted The amount of vault notes that would be minted.
    /// @return underlyingAmtIn The actual amount of underlying tokens to deposit.
    /// @return perpAmtIn The actual amount of perp tokens to deposit.
    function computeMintAmt(
        uint256 underlyingAmtMax,
        uint256 perpAmtMax
    )
        public
        view
        returns (uint256 notesMinted, uint256 underlyingAmtIn, uint256 perpAmtIn)
    {
        uint256 totalSupply_ = totalSupply();

        if (underlyingAmtMax <= 0 && perpAmtMax <= 0) {
            return (0, 0, 0);
        }

        if (totalSupply_ <= 0) {
            // First deposit: accept any ratio
            underlyingAmtIn = underlyingAmtMax;
            perpAmtIn = perpAmtMax;
            // Mint notes based on combined value (normalized to 18 decimals)
            notesMinted =
                underlyingAmtIn.mulDiv(ONE, underlyingUnitAmt) +
                perpAmtIn.mulDiv(ONE, perpUnitAmt);
        } else {
            // Subsequent deposits: enforce vault ratio
            uint256 underlyingBal = underlying.balanceOf(address(this));
            uint256 perpBal = perp.balanceOf(address(this));

            if (perpBal <= 0) {
                // Vault has only underlying
                underlyingAmtIn = underlyingAmtMax;
                perpAmtIn = 0;
                notesMinted = totalSupply_.mulDiv(underlyingAmtIn, underlyingBal);
            } else if (underlyingBal <= 0) {
                // Vault has only perps
                underlyingAmtIn = 0;
                perpAmtIn = perpAmtMax;
                notesMinted = totalSupply_.mulDiv(perpAmtIn, perpBal);
            } else {
                // Vault has both: calculate proportional amounts
                underlyingAmtIn = underlyingAmtMax;
                perpAmtIn = perpBal.mulDiv(underlyingAmtIn, underlyingBal);
                if (perpAmtIn > perpAmtMax) {
                    perpAmtIn = perpAmtMax;
                    underlyingAmtIn = underlyingBal.mulDiv(perpAmtIn, perpBal);
                }
                notesMinted = totalSupply_.mulDiv(underlyingAmtIn, underlyingBal);
            }
        }
    }

    /// @notice Computes the amounts of underlying and perp tokens returned for burning vault notes.
    /// @param notesAmt The amount of vault notes to burn.
    /// @return underlyingAmtOut The amount of underlying tokens returned.
    /// @return perpAmtOut The amount of perp tokens returned.
    function computeRedemptionAmts(
        uint256 notesAmt
    ) public view returns (uint256 underlyingAmtOut, uint256 perpAmtOut) {
        uint256 totalSupply_ = totalSupply();
        if (notesAmt <= 0 || totalSupply_ <= 0) {
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

    /// @notice Computes the amount of underlying to swap for rebalancing the system DR.
    /// @return underlyingAmt The amount of underlying involved in the swap.
    /// @return isUnderlyingIntoPerp True if should swap underlying for perps, false otherwise.
    function computeRebalanceAmount()
        public
        returns (uint256 underlyingAmt, bool isUnderlyingIntoPerp)
    {
        return
            _computeRebalanceAmount(
                stampl.deviationRatio(),
                perp.getTVL(),
                perp.totalSupply()
            );
    }

    /// @dev Computes rebalance amount. See contract-level documentation for math details.
    function _computeRebalanceAmount(
        uint256 dr,
        uint256 perpTVL,
        uint256 perpTotalSupply
    ) private view returns (uint256 underlyingAmt, bool isUnderlyingIntoPerp) {
        if (perpTVL <= 0) {
            return (0, false);
        }

        // Determine direction, magnitude, and available liquidity for the swap
        // If DR < target: perpTVL is too high, redeem perps to decrease it
        // If DR > target: perpTVL is too low, mint perps to increase it
        uint256 drDelta;
        uint256 lagFactor_;
        uint256 availableLiquidity;

        if (dr < targetDR) {
            isUnderlyingIntoPerp = false;
            drDelta = targetDR - dr;
            lagFactor_ = lagFactorPerpToUnderlying;
            // Swapping perps for underlying: limit by perp balance (in underlying terms)
            availableLiquidity = perp.balanceOf(address(this)).mulDiv(
                perpTVL,
                perpTotalSupply
            );
        } else {
            isUnderlyingIntoPerp = true;
            drDelta = dr - targetDR;
            lagFactor_ = lagFactorUnderlyingToPerp;
            // Swapping underlying for perps: limit by underlying balance
            availableLiquidity = underlying.balanceOf(address(this));
        }

        // Compute required change:
        // Since stamplTVL doesn't change during flash mint/redeem,
        // only perpTVL changes, so: requiredChange = perpTVL × |dr - targetDR|
        uint256 requiredChange = perpTVL.mulDiv(drDelta, DR_ONE);

        // Apply lag factor (gradual adjustment)
        uint256 adjustedChange = requiredChange / lagFactor_;

        // Skip if below minimum rebalance amount
        if (adjustedChange < minRebalanceVal) {
            return (0, isUnderlyingIntoPerp);
        }

        // Cap by available liquidity and required change (prevent overshoot)
        underlyingAmt = adjustedChange;
        if (underlyingAmt > availableLiquidity) {
            underlyingAmt = availableLiquidity;
        }
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
