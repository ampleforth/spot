// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { IFeePolicy } from "./_interfaces/IFeePolicy.sol";
import { SubscriptionParams } from "./_interfaces/CommonTypes.sol";
import { InvalidPerc, InvalidTargetSRBounds, InvalidDRBounds } from "./_interfaces/ProtocolErrors.sol";

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
/**
 *  @title FeePolicy
 *
 *  @notice This contract determines fees for interacting with the perp and vault systems.
 *
 *          The fee policy attempts to balance the demand for holding perp tokens with
 *          the demand for holding vault tokens; such that the total collateral in the vault
 *          supports rolling over all mature collateral backing perps.
 *
 *          Fees are computed based on the deviation between the system's current subscription ratio
 *          and the target subscription ratio.
 *              - `subscriptionRatio`   = (vaultTVL * seniorTR) / (perpTVL * 1-seniorTR)
 *              - `deviationRatio` (dr) = subscriptionRatio / targetSubscriptionRatio
 *
 *          When the system is "under-subscribed" (dr <= 1):
 *              - Rollover fees flow from perp holders to vault note holders.
 *              - Fees are charged for minting new perps.
 *              - No fees are charged for redeeming perps.
 *
 *          When the system is "over-subscribed" (dr > 1):
 *              - Rollover fees flow from vault note holders to perp holders.
 *              - No fees are charged for minting new perps.
 *              - Fees are charged for redeeming perps.
 *
 *          Regardless of the `deviationRatio`, the system charges a fixed percentage fee
 *          for minting and redeeming vault notes.
 *
 *
 *          The rollover fees are signed and can flow in either direction based on the `deviationRatio`.
 *          The fee function parameters are set by the owner.
 *
 *          CRITICAL: The rollover fee percentage is NOT annualized, the fee percentage is applied per rollover.
 *          The number of rollovers per year changes based on the duration of perp's minting bond.
 *
 *          We consider a `deviationRatio` of greater than 1.0 healthy (or "over-subscribed").
 *          In general, the system favors an elastic perp supply and an inelastic vault note supply.
 *
 *
 */
contract FeePolicy is IFeePolicy, OwnableUpgradeable {
    // Libraries
    using MathUpgradeable for uint256;
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

    /// @notice The lower bound of deviation ratio, below which some operations (which decrease the dr) are disabled.
    uint256 public deviationRatioBoundLower;

    /// @notice The upper bound of deviation ratio, above which some operations (which increase the dr) are disabled.
    uint256 public deviationRatioBoundUpper;

    //-----------------------------------------------------------------------------

    //-----------------------------------------------------------------------------
    // Perp fee parameters

    /// @notice The percentage fee charged on minting perp tokens.
    uint256 public perpMintFeePerc;

    /// @notice The percentage fee charged on burning perp tokens.
    uint256 public perpBurnFeePerc;

    /// @dev NOTE: We updated the type of the parameters from int256 to uint256, which is an upgrade safe operation.
    struct RolloverFeeParams {
        /// @notice The maximum debasement rate for perp,
        ///         i.e) the maximum rate perp pays the vault for rollovers.
        /// @dev This is represented as fixed point number with {DECIMALS} places.
        ///      For example, setting this to (0.1 / 13), would mean that the yearly perp debasement rate is capped at ~10%.
        uint256 maxPerpDebasementPerc;
        /// @notice The slope of the linear fee curve when (dr <= 1).
        /// @dev This is represented as fixed point number with {DECIMALS} places.
        ///      Setting it to (1.0 / 13), would mean that it would take 1 year for dr to increase to 1.0.
        ///      (assuming no other changes to the system)
        uint256 m1;
        /// @notice The slope of the linear fee curve when (dr > 1).
        /// @dev This is represented as fixed point number with {DECIMALS} places.
        ///      Setting it to (1.0 / 13), would mean that it would take 1 year for dr to decrease to 1.0.
        ///      (assuming no other changes to the system)
        uint256 m2;
    }

    /// @notice Parameters which control the perp rollover fee,
    ///         i.e) the funding rate for holding perps.
    RolloverFeeParams public perpRolloverFee;

    //-----------------------------------------------------------------------------

    //-----------------------------------------------------------------------------
    // Vault fee parameters

    /// @notice The percentage fee charged on minting vault notes.
    uint256 public vaultMintFeePerc;

    /// @notice The percentage fee charged on burning vault notes.
    uint256 public vaultBurnFeePerc;

    /// @notice The percentage fee charged by the vault to swap underlying tokens for perp tokens.
    uint256 public vaultUnderlyingToPerpSwapFeePerc;

    /// @notice The percentage fee charged by the vault to swap perp tokens for underlying tokens.
    uint256 public vaultPerpToUnderlyingSwapFeePerc;

    //-----------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Contract initializer.
    function init() external initializer {
        __Ownable_init();

        // initializing mint/burn fees to zero
        perpMintFeePerc = 0;
        perpBurnFeePerc = 0;
        vaultMintFeePerc = 0;
        vaultBurnFeePerc = 0;

        // initializing swap fees to 100%, to disable swapping initially
        vaultUnderlyingToPerpSwapFeePerc = ONE;
        vaultPerpToUnderlyingSwapFeePerc = ONE;

        // NOTE: With the current bond length of 28 days, rollover rate is annualized by dividing by: 365/28 ~= 13
        perpRolloverFee.maxPerpDebasementPerc = ONE / (10 * 13); // 0.1/13 = 0.0077 (10% annualized)
        perpRolloverFee.m1 = ONE / (3 * 13); // 0.025
        perpRolloverFee.m2 = ONE / (3 * 13); // 0.025

        targetSubscriptionRatio = (ONE * 133) / 100; // 1.33
        deviationRatioBoundLower = (ONE * 75) / 100; // 0.75
        deviationRatioBoundUpper = 2 * ONE; // 2.0
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
    /// @param deviationRatioBoundLower_ The new lower deviation ratio bound as fixed point number with {DECIMALS} places.
    /// @param deviationRatioBoundUpper_ The new upper deviation ratio bound as fixed point number with {DECIMALS} places.
    function updateDeviationRatioBounds(
        uint256 deviationRatioBoundLower_,
        uint256 deviationRatioBoundUpper_
    ) external onlyOwner {
        if (deviationRatioBoundLower_ > ONE || deviationRatioBoundUpper_ < ONE) {
            revert InvalidDRBounds();
        }
        deviationRatioBoundLower = deviationRatioBoundLower_;
        deviationRatioBoundUpper = deviationRatioBoundUpper_;
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

    /// @notice Update the parameters determining the rollover fee curve.
    /// @dev Back into the per-rollover percentage based on the bond duration, and thus number of rollovers per year.
    /// @param p Paramters are fixed point numbers with {DECIMALS} places.
    function updatePerpRolloverFees(RolloverFeeParams calldata p) external onlyOwner {
        perpRolloverFee = p;
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

    /// @notice Updates the vault's share of the underlying to perp swap fee.
    /// @param feePerc The new fee percentage.
    function updateVaultUnderlyingToPerpSwapFeePerc(uint256 feePerc) external onlyOwner {
        if (feePerc > ONE) {
            revert InvalidPerc();
        }
        vaultUnderlyingToPerpSwapFeePerc = feePerc;
    }

    /// @notice Updates the vault's share of the perp to underlying swap fee.
    /// @param feePerc The new fee percentage.
    function updateVaultPerpToUnderlyingSwapFeePerc(uint256 feePerc) external onlyOwner {
        if (feePerc > ONE) {
            revert InvalidPerc();
        }
        vaultPerpToUnderlyingSwapFeePerc = feePerc;
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
    function computePerpRolloverFeePerc(uint256 dr) external view override returns (int256) {
        if (dr <= ONE) {
            uint256 negPerpRate = MathUpgradeable.min(
                perpRolloverFee.m1.mulDiv(ONE - dr, ONE),
                perpRolloverFee.maxPerpDebasementPerc
            );
            return -1 * negPerpRate.toInt256();
        } else {
            uint256 perpRate = perpRolloverFee.m2.mulDiv(dr - ONE, ONE);
            return perpRate.toInt256();
        }
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
        uint256 /*drPre*/,
        uint256 drPost
    ) external view override returns (uint256) {
        // When the after op deviation ratio is below the bound,
        // swapping is disabled. (fees are set to 100%)
        return (drPost < deviationRatioBoundLower ? ONE : vaultUnderlyingToPerpSwapFeePerc);
    }

    /// @inheritdoc IFeePolicy
    /// @dev Swapping by burning perps increases system dr, i.e) drPost > drPre.
    function computePerpToUnderlyingVaultSwapFeePerc(
        uint256 /*drPre*/,
        uint256 drPost
    ) external view override returns (uint256) {
        // When the after op deviation ratio is above the bound,
        // swapping is disabled. (fees are set to 100%)
        return (drPost > deviationRatioBoundUpper ? ONE : vaultPerpToUnderlyingSwapFeePerc);
    }

    /// @inheritdoc IFeePolicy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    /// @inheritdoc IFeePolicy
    function computeDeviationRatio(SubscriptionParams memory s) public view returns (uint256) {
        // NOTE: We assume that perp's TVL and vault's TVL values have the same base denomination.
        uint256 juniorTR = TRANCHE_RATIO_GRANULARITY - s.seniorTR;
        return (s.vaultTVL * s.seniorTR).mulDiv(ONE, (s.perpTVL * juniorTR)).mulDiv(ONE, targetSubscriptionRatio);
    }
}
