// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { IFeePolicy } from "./_interfaces/IFeePolicy.sol";
import { SubscriptionParams, Range, Line, RebalanceData } from "./_interfaces/CommonTypes.sol";
import { InvalidPerc, InvalidTargetSRBounds, InvalidDRRange } from "./_interfaces/ProtocolErrors.sol";

import { LineHelpers } from "./_utils/LineHelpers.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

/**
 *  @title FeePolicy
 *
 *  @notice This contract determines fees and incentives for interacting with the perp and vault systems.
 *
 *          The fee policy attempts to balance the demand for holding perp tokens with
 *          the demand for holding vault tokens; such that the total collateral in the vault
 *          supports rolling over all mature collateral backing perps.
 *
 *          The system's balance is defined by it's `deviationRatio` which is defined as follows.
 *              - `subscriptionRatio`   = (vaultTVL * seniorTR) / (perpTVL * 1-seniorTR)
 *              - `deviationRatio` (dr) = subscriptionRatio / targetSubscriptionRatio
 *
 *          When the dr = 1, the system is considered perfectly balanced.
 *          When the dr < 1, it's considered "under-subscribed".
 *          When the dr > 1, it's considered "over-subscribed".
 *
 *          Fees:
 *          - The system charges users a static "entry" and "exit fees", i.e) fees when users mint/redeem perps and vault notes.
 *          - The rollover vault rents out excess liquidity if available for flash swaps for which it charges a fee.
 *
 *          Incentives:
 *          - When the system is "under-subscribed", value is transferred from perp to the vault at a predefined rate.
 *            This debases perp tokens gradually and enriches the rollover vault.
 *          - When the system is "over-subscribed", value is transferred from the vault to perp at a predefined rate.
 *            This enriches perp tokens gradually and debases the rollover vault.
 *          - This transfer is implemented through a daily "rebalance" operation, executed by the vault, and
 *            gradually nudges the system back into balance. On rebalance, the vault queries this policy
 *            to compute the magnitude and direction of value transfer.
 *
 *
 *          NOTE: All parameters are stored as fixed point numbers with {DECIMALS} decimal places.
 *
 *
 */
contract FeePolicy is IFeePolicy, OwnableUpgradeable {
    // Libraries
    using MathUpgradeable for uint256;
    using SignedMathUpgradeable for int256;
    using SafeCastUpgradeable for uint256;
    using SafeCastUpgradeable for int256;

    // Replicating value used here:
    // https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 private constant TRANCHE_RATIO_GRANULARITY = 1000;

    /// @notice The returned fee percentages are fixed point numbers with {DECIMALS} places.
    /// @dev The decimals should line up with value expected by consumer (perp, vault).
    ///      NOTE: 10**DECIMALS => 100% or 1.0
    uint8 public constant DECIMALS = 8;

    /// @notice Fixed point representation of 1.0 or 100%.
    uint256 public constant ONE = (1 * 10 ** DECIMALS);

    /// @notice Target subscription ratio lower bound, 0.75 or 75%.
    uint256 public constant TARGET_SR_LOWER_BOUND = (ONE * 75) / 100;

    /// @notice Target subscription ratio higher bound, 2.0 or 200%.
    uint256 public constant TARGET_SR_UPPER_BOUND = 2 * ONE;

    //-----------------------------------------------------------------------------
    /// @notice The target subscription ratio i.e) the normalization factor.
    /// @dev The ratio under which the system is considered "under-subscribed".
    ///      Adds a safety buffer to ensure that rollovers are better sustained.
    uint256 public targetSubscriptionRatio;

    /// @notice The lower and upper deviation ratio bounds outside which
    ///         flash swaps which move dr away from 1.0 are disabled.
    Range public drHardBound;

    /// @notice The deviation ratio bounds outside which flash swaps are still functional but,
    ///         the swap fees transition from a constant fee to a linear function.
    Range public drSoftBound;

    /// @notice The deviation ratio bounds inside which rebalancing is disabled.
    Range public rebalEqDr;

    //-----------------------------------------------------------------------------
    // Fee parameters

    /// @notice The percentage fee charged on minting perp tokens.
    uint256 public perpMintFeePerc;

    /// @notice The percentage fee charged on burning perp tokens.
    uint256 public perpBurnFeePerc;

    /// @notice The percentage fee charged on minting vault notes.
    uint256 public vaultMintFeePerc;

    /// @notice The percentage fee charged on burning vault notes.
    uint256 public vaultBurnFeePerc;

    /// @notice Lower and upper fee percentages for flash minting.
    Range public flashMintFeePercs;

    /// @notice Lower and upper fee percentages for flash redemption.
    Range public flashRedeemFeePercs;

    //-----------------------------------------------------------------------------
    // Incentive parameters

    /// @notice The percentage of system TVL transferred out of perp on every rebalance (when dr <= 1).
    uint256 public debasementSystemTVLPerc;

    /// @notice The percentage of system TVL transferred into perp on every rebalance (when dr > 1).
    uint256 public enrichmentSystemTVLPerc;

    /// @notice The percentage of the debasement value charged by the protocol as fees.
    uint256 public debasementProtocolSharePerc;

    /// @notice The percentage of the enrichment value charged by the protocol as fees.
    uint256 public enrichmentProtocolSharePerc;

    //-----------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Contract initializer.
    function init() external initializer {
        __Ownable_init();

        targetSubscriptionRatio = (ONE * 150) / 100; // 1.5
        drHardBound = Range({
            lower: (ONE * 75) / 100, // 0.75
            upper: 2 * ONE // 2.0
        });
        drSoftBound = Range({
            lower: (ONE * 90) / 100, // 0.9
            upper: (5 * ONE) / 4 // 1.25
        });
        rebalEqDr = Range({
            lower: ONE, // 1.0
            upper: ONE // 1.0
        });

        // initializing fees
        perpMintFeePerc = 0;
        perpBurnFeePerc = 0;
        vaultMintFeePerc = 0;
        vaultBurnFeePerc = 0;

        // initializing swap fees to 100%, to disable swapping initially
        flashMintFeePercs = Range({ lower: ONE, upper: ONE });
        flashRedeemFeePercs = Range({ lower: ONE, upper: ONE });

        // initializing incentives
        debasementSystemTVLPerc = ONE / 1000; // 0.1% or 10 bps
        enrichmentSystemTVLPerc = ONE / 666; // ~0.15% or 15 bps
        debasementProtocolSharePerc = 0;
        enrichmentProtocolSharePerc = 0;
    }

    //-----------------------------------------------------------------------------
    // Owner only

    /// @notice Updates the target subscription ratio.
    /// @param targetSubscriptionRatio_ The new target subscription ratio as a fixed point number with {DECIMALS} places.
    function updateTargetSubscriptionRatio(uint256 targetSubscriptionRatio_) external onlyOwner {
        if (targetSubscriptionRatio_ < TARGET_SR_LOWER_BOUND || targetSubscriptionRatio_ > TARGET_SR_UPPER_BOUND) {
            revert InvalidTargetSRBounds();
        }
        targetSubscriptionRatio = targetSubscriptionRatio_;
    }

    /// @notice Updates the deviation ratio bounds.
    /// @param drHardBound_ The new hard lower and upper deviation ratio bound as fixed point number with {DECIMALS} places.
    /// @param drSoftBound_ The new soft lower and upper deviation ratio bound as fixed point number with {DECIMALS} places.
    function updateDRBounds(Range memory drHardBound_, Range memory drSoftBound_) external onlyOwner {
        bool validBounds = (drHardBound_.lower <= drSoftBound_.lower &&
            drSoftBound_.lower <= drSoftBound_.upper &&
            drSoftBound_.upper <= drHardBound_.upper);
        if (!validBounds) {
            revert InvalidDRRange();
        }
        drHardBound = drHardBound_;
        drSoftBound = drSoftBound_;
    }

    /// @notice Updates rebalance equilibrium DR range within which rebalancing is disabled.
    /// @param rebalEqDr_ The lower and upper equilibrium deviation ratio range as fixed point number with {DECIMALS} places.
    function updateRebalanceEquilibriumDR(Range memory rebalEqDr_) external onlyOwner {
        if (rebalEqDr_.upper < rebalEqDr_.lower || rebalEqDr_.lower > ONE || rebalEqDr_.upper < ONE) {
            revert InvalidDRRange();
        }
        rebalEqDr = rebalEqDr_;
    }

    /// @notice Updates the perp mint fee parameters.
    /// @param perpMintFeePerc_ The new perp mint fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updatePerpMintFees(uint256 perpMintFeePerc_) external onlyOwner {
        if (perpMintFeePerc_ > ONE) {
            revert InvalidPerc();
        }
        perpMintFeePerc = perpMintFeePerc_;
    }

    /// @notice Updates the perp burn fee parameters.
    /// @param perpBurnFeePerc_ The new perp burn fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updatePerpBurnFees(uint256 perpBurnFeePerc_) external onlyOwner {
        if (perpBurnFeePerc_ > ONE) {
            revert InvalidPerc();
        }
        perpBurnFeePerc = perpBurnFeePerc_;
    }

    /// @notice Updates the vault mint fee parameters.
    /// @param vaultMintFeePerc_ The new vault mint fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updateVaultMintFees(uint256 vaultMintFeePerc_) external onlyOwner {
        if (vaultMintFeePerc_ > ONE) {
            revert InvalidPerc();
        }
        vaultMintFeePerc = vaultMintFeePerc_;
    }

    /// @notice Updates the vault burn fee parameters.
    /// @param vaultBurnFeePerc_ The new vault burn fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updateVaultBurnFees(uint256 vaultBurnFeePerc_) external onlyOwner {
        if (vaultBurnFeePerc_ > ONE) {
            revert InvalidPerc();
        }
        vaultBurnFeePerc = vaultBurnFeePerc_;
    }

    /// @notice Updates the vault flash swap fee percentages.
    /// @param flashMintFeePercs_ The lower and upper flash mint fee percentages as a fixed point numbers with {DECIMALS} places.
    /// @param flashRedeemFeePercs_ The lower and upper flash redemption fee percentages  as a fixed point numbers with {DECIMALS} places.
    function updateFlashFees(Range memory flashMintFeePercs_, Range memory flashRedeemFeePercs_) external onlyOwner {
        if (
            flashMintFeePercs_.lower > ONE ||
            flashMintFeePercs_.upper > ONE ||
            flashRedeemFeePercs_.lower > ONE ||
            flashRedeemFeePercs_.upper > ONE
        ) {
            revert InvalidPerc();
        }
        flashMintFeePercs = flashMintFeePercs_;
        flashRedeemFeePercs = flashRedeemFeePercs_;
    }

    /// @notice Updates the rebalance rate.
    /// @param debasementSystemTVLPerc_ The percentage of system tvl out of perp on debasement.
    /// @param enrichmentSystemTVLPerc_ The percentage of system tvl into perp on enrichment.
    function updateMaxRebalancePerc(
        uint256 debasementSystemTVLPerc_,
        uint256 enrichmentSystemTVLPerc_
    ) external onlyOwner {
        debasementSystemTVLPerc = debasementSystemTVLPerc_;
        enrichmentSystemTVLPerc = enrichmentSystemTVLPerc_;
    }

    /// @notice Updates the protocol share of the daily debasement and enrichment.
    /// @param debasementProtocolSharePerc_ The share of the debasement which goes to the protocol.
    /// @param enrichmentProtocolSharePerc_ The share of the enrichment which goes to the protocol.
    function updateProtocolSharePerc(
        uint256 debasementProtocolSharePerc_,
        uint256 enrichmentProtocolSharePerc_
    ) external onlyOwner {
        if (debasementProtocolSharePerc_ > ONE || enrichmentProtocolSharePerc_ > ONE) {
            revert InvalidPerc();
        }

        debasementProtocolSharePerc = debasementProtocolSharePerc_;
        enrichmentProtocolSharePerc = enrichmentProtocolSharePerc_;
    }

    //-----------------------------------------------------------------------------
    // Public methods

    /// @inheritdoc IFeePolicy
    /// @dev Minting perps reduces system dr, i.e) drPost < drPre.
    function computePerpMintFeePerc() public view override returns (uint256) {
        return perpMintFeePerc;
    }

    /// @inheritdoc IFeePolicy
    /// @dev Burning perps increases system dr, i.e) drPost > drPre.
    function computePerpBurnFeePerc() public view override returns (uint256) {
        return perpBurnFeePerc;
    }

    /// @inheritdoc IFeePolicy
    /// @dev Minting vault notes increases system dr, i.e) drPost > drPre.
    function computeVaultMintFeePerc() external view override returns (uint256) {
        return vaultMintFeePerc;
    }

    /// @inheritdoc IFeePolicy
    function computeVaultBurnFeePerc() external view override returns (uint256) {
        return vaultBurnFeePerc;
    }

    /// @inheritdoc IFeePolicy
    /// @dev Swapping by minting perps reduces system dr, i.e) drPost < drPre.
    function computeUnderlyingToPerpVaultSwapFeePerc(
        uint256 drPre,
        uint256 drPost
    ) external view override returns (uint256) {
        // When the after op deviation ratio is below the bound,
        // swapping is disabled. (fees are set to 100%)
        if (drPost <= drHardBound.lower) {
            return ONE;
        }
        return
            LineHelpers
                .computePiecewiseAvgY(
                    Line({
                        x1: drHardBound.lower,
                        y1: flashMintFeePercs.upper,
                        x2: drSoftBound.lower,
                        y2: flashMintFeePercs.lower
                    }),
                    Line({
                        x1: drSoftBound.lower,
                        y1: flashMintFeePercs.lower,
                        x2: drHardBound.upper,
                        y2: flashMintFeePercs.lower
                    }),
                    Range({ lower: drPost, upper: drPre }),
                    drSoftBound.lower
                )
                .toUint256();
    }

    /// @inheritdoc IFeePolicy
    /// @dev Swapping by burning perps increases system dr, i.e) drPost > drPre.
    function computePerpToUnderlyingVaultSwapFeePerc(
        uint256 drPre,
        uint256 drPost
    ) external view override returns (uint256) {
        // When the after op deviation ratio is above the bound,
        // swapping is disabled. (fees are set to 100%)
        if (drPost >= drHardBound.upper) {
            return ONE;
        }
        return
            LineHelpers
                .computePiecewiseAvgY(
                    Line({
                        x1: drHardBound.lower,
                        y1: flashRedeemFeePercs.lower,
                        x2: drSoftBound.upper,
                        y2: flashRedeemFeePercs.lower
                    }),
                    Line({
                        x1: drSoftBound.upper,
                        y1: flashRedeemFeePercs.lower,
                        x2: drHardBound.upper,
                        y2: flashRedeemFeePercs.upper
                    }),
                    Range({ lower: drPre, upper: drPost }),
                    drSoftBound.upper
                )
                .toUint256();
    }

    /// @inheritdoc IFeePolicy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    /// @inheritdoc IFeePolicy
    function computeDeviationRatio(SubscriptionParams memory s) public view override returns (uint256) {
        // NOTE: We assume that perp's TVL and vault's TVL values have the same base denomination.
        uint256 juniorTR = TRANCHE_RATIO_GRANULARITY - s.seniorTR;
        return (s.vaultTVL * s.seniorTR).mulDiv(ONE, (s.perpTVL * juniorTR)).mulDiv(ONE, targetSubscriptionRatio);
    }

    /// @inheritdoc IFeePolicy
    function computeRebalanceData(SubscriptionParams memory s) external view override returns (RebalanceData memory r) {
        // We skip rebalancing if dr is close to 1.0
        uint256 dr = computeDeviationRatio(s);
        if (dr >= rebalEqDr.lower && dr <= rebalEqDr.upper) {
            return r;
        }

        uint256 juniorTR = (TRANCHE_RATIO_GRANULARITY - s.seniorTR);
        uint256 drNormalizedSeniorTR = ONE.mulDiv(
            (s.seniorTR * ONE),
            (s.seniorTR * ONE) + (juniorTR * targetSubscriptionRatio)
        );

        uint256 totalTVL = s.perpTVL + s.vaultTVL;
        uint256 reqPerpTVL = totalTVL.mulDiv(drNormalizedSeniorTR, ONE);
        r.underlyingAmtIntoPerp = reqPerpTVL.toInt256() - s.perpTVL.toInt256();

        // We limit `r.underlyingAmtIntoPerp` to allowed limits
        bool perpDebasement = r.underlyingAmtIntoPerp <= 0;
        if (perpDebasement) {
            r.underlyingAmtIntoPerp = SignedMathUpgradeable.max(
                -totalTVL.mulDiv(debasementSystemTVLPerc, ONE).toInt256(),
                r.underlyingAmtIntoPerp
            );
        } else {
            r.underlyingAmtIntoPerp = SignedMathUpgradeable.min(
                totalTVL.mulDiv(enrichmentSystemTVLPerc, ONE).toInt256(),
                r.underlyingAmtIntoPerp
            );
        }

        // Compute protocol fee
        r.protocolFeeUnderlyingAmt = r.underlyingAmtIntoPerp.abs().mulDiv(
            (perpDebasement ? debasementProtocolSharePerc : enrichmentProtocolSharePerc),
            ONE,
            MathUpgradeable.Rounding.Up
        );

        // Deduct protocol fee from value transfer
        r.underlyingAmtIntoPerp -= (perpDebasement ? int256(-1) : int256(1)) * r.protocolFeeUnderlyingAmt.toInt256();
    }
}
