// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { IFeePolicy } from "./_interfaces/IFeePolicy.sol";
import { SubscriptionParams } from "./_interfaces/CommonTypes.sol";

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Sigmoid } from "./_utils/Sigmoid.sol";

/// @notice Expected perc value to be at most (1 * 10**DECIMALS), i.e) 1.0 or 100%.
error InvalidPerc();

/// @notice Expected target subscription ratio to be within defined bounds.
error InvalidTargetSRBounds();

/// @notice Expected deviation ratio bounds to be valid.
error InvalidDRBounds();

/// @notice Expected sigmoid asymptotes to be within defined bounds.
error InvalidSigmoidAsymptotes();

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
 *          The fee is a percentage is computed through a sigmoid function.
 *          The slope and asymptotes are set by the owner.
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

    // Replicating value used here:
    // https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 private constant TRANCHE_RATIO_GRANULARITY = 1000;

    /// @dev The returned fee percentages are fixed point numbers with {DECIMALS} places.
    ///      The decimals should line up with value expected by consumer (perp, vault).
    ///      NOTE: 10**DECIMALS => 100% or 1.0
    uint8 public constant DECIMALS = 8;
    uint256 public constant ONE = (1 * 10 ** DECIMALS); // 1.0 or 100%

    /// @dev SIGMOID_BOUND is set to 1%, i.e) the rollover fee can be at most 1% on either direction.
    uint256 public constant SIGMOID_BOUND = ONE / 100; // 0.01 or 1%

    uint256 public constant TARGET_SR_LOWER_BOUND = (ONE * 75) / 100; // 0.75 or 75%
    uint256 public constant TARGET_SR_UPPER_BOUND = 2 * ONE; // 2.0 or 200%

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

    struct RolloverFeeSigmoidParams {
        /// @notice Lower asymptote
        int256 lower;
        /// @notice Upper asymptote
        int256 upper;
        /// @notice sigmoid slope
        int256 growth;
    }

    /// @notice Parameters which control the asymptotes and the slope of the perp token's rollover fee.
    RolloverFeeSigmoidParams public perpRolloverFee;

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

    /// @notice The fixed amount vault fee charged during each deployment.
    /// @dev Denominated in the underlying collateral asset and
    ///      Paid by the vault note holders to the system owner.
    uint256 public vaultDeploymentFee;

    //-----------------------------------------------------------------------------

    /// @notice Contract initializer.
    function init() public initializer {
        __Ownable_init();

        // initializing mint/burn fees to zero
        perpMintFeePerc = 0;
        perpBurnFeePerc = 0;
        vaultMintFeePerc = 0;
        vaultBurnFeePerc = 0;
        vaultDeploymentFee = 0;

        // initializing swap fees to 100%, to disable swapping initially
        vaultUnderlyingToPerpSwapFeePerc = ONE;
        vaultPerpToUnderlyingSwapFeePerc = ONE;

        // NOTE: With the current bond length of 28 days, rollover rate is annualized by dividing by: 365/28 ~= 13
        perpRolloverFee.lower = -int256(ONE) / (30 * 13); // -0.033/13 = -0.00253 (3.3% annualized)
        perpRolloverFee.upper = int256(ONE) / (10 * 13); // 0.1/13 = 0.00769 (10% annualized)
        perpRolloverFee.growth = 5 * int256(ONE); // 5.0

        targetSubscriptionRatio = (ONE * 133) / 100; // 1.33
        deviationRatioBoundLower = 0; // 0
        deviationRatioBoundUpper = 5 * ONE; // 5.0
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
        if (
            deviationRatioBoundLower_ > ONE ||
            deviationRatioBoundUpper_ < ONE ||
            deviationRatioBoundLower_ > deviationRatioBoundUpper_
        ) {
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

    /// @notice Update the parameters determining the slope and asymptotes of the sigmoid fee curve.
    /// @param p Lower, Upper and Growth sigmoid paramters are fixed point numbers with {DECIMALS} places.
    function updatePerpRolloverFees(RolloverFeeSigmoidParams calldata p) external onlyOwner {
        // If the bond duration is 28 days and 13 rollovers happen per year,
        // perp can be inflated or enriched up to ~13% annually.
        if (p.lower < -int256(SIGMOID_BOUND) || p.upper > int256(SIGMOID_BOUND) || p.lower > p.upper) {
            revert InvalidSigmoidAsymptotes();
        }
        perpRolloverFee.lower = p.lower;
        perpRolloverFee.upper = p.upper;
        perpRolloverFee.growth = p.growth;
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

    /// @notice Updates the vault's deployment fee parameters.
    /// @param vaultDeploymentFee_ The new deployment fee denominated in the underlying tokens.
    function updateVaultDeploymentFees(uint256 vaultDeploymentFee_) external onlyOwner {
        vaultDeploymentFee = vaultDeploymentFee_;
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
    function computePerpMintFeePerc(uint256 dr) public view override returns (uint256) {
        // When the system is over-subscribed we charge a perp mint fee.
        return (dr <= ONE) ? perpMintFeePerc : 0;
    }

    /// @inheritdoc IFeePolicy
    function computePerpBurnFeePerc(uint256 dr) public view override returns (uint256) {
        // When the system is over-subscribed we charge a perp redemption fee.
        return (dr > ONE) ? perpBurnFeePerc : 0;
    }

    /// @inheritdoc IFeePolicy
    function computePerpRolloverFeePerc(uint256 dr) external view override returns (int256) {
        return
            Sigmoid.compute(
                dr.toInt256(),
                perpRolloverFee.lower,
                perpRolloverFee.upper,
                perpRolloverFee.growth,
                ONE.toInt256()
            );
    }

    /// @inheritdoc IFeePolicy
    function computeVaultMintFeePerc(uint256 dr) external view override returns (uint256) {
        // When the system is over-subscribed the vault changes a mint fee.
        return (dr > ONE) ? vaultMintFeePerc : 0;
    }

    /// @inheritdoc IFeePolicy
    function computeVaultBurnFeePerc(uint256 /*dr*/) external view override returns (uint256) {
        return vaultBurnFeePerc;
    }

    /// @inheritdoc IFeePolicy
    function computeVaultDeploymentFee() external view override returns (uint256) {
        return vaultDeploymentFee;
    }

    /// @inheritdoc IFeePolicy
    function computeUnderlyingToPerpSwapFeePercs(uint256 dr) external view override returns (uint256, uint256) {
        // When the deviation ratio is below the bound, swapping is disabled. (fees are set to 100%)
        return (computePerpMintFeePerc(dr), (dr < deviationRatioBoundLower) ? ONE : vaultUnderlyingToPerpSwapFeePerc);
    }

    /// @inheritdoc IFeePolicy
    function computePerpToUnderlyingSwapFeePercs(uint256 dr) external view override returns (uint256, uint256) {
        // When the deviation ratio is above the bound, swapping is disabled. (fees are set to 100%)
        return (computePerpBurnFeePerc(dr), (dr > deviationRatioBoundUpper) ? ONE : vaultPerpToUnderlyingSwapFeePerc);
    }

    /// @inheritdoc IFeePolicy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    /// @inheritdoc IFeePolicy
    function computeDeviationRatio(SubscriptionParams memory s) public view returns (uint256) {
        return computeDeviationRatio(s.perpTVL, s.vaultTVL, s.seniorTR);
    }

    /// @inheritdoc IFeePolicy
    function computeDeviationRatio(uint256 perpTVL, uint256 vaultTVL, uint256 seniorTR) public view returns (uint256) {
        // NOTE: We assume that perp's TVL and vault's TVL values have the same base denomination.
        uint256 juniorTR = TRANCHE_RATIO_GRANULARITY - seniorTR;
        return (vaultTVL * seniorTR).mulDiv(ONE, (perpTVL * juniorTR)).mulDiv(ONE, targetSubscriptionRatio);
    }
}
