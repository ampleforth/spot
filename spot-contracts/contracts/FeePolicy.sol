// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IFeePolicy } from "./_interfaces/IFeePolicy.sol";
import { IPerpetualTranche, IBondController } from "./_interfaces/IPerpetualTranche.sol";
import { IVault } from "./_interfaces/IVault.sol";

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Sigmoid } from "./_utils/Sigmoid.sol";

import { UnacceptableSwap } from "./_interfaces/ProtocolErrors.sol";

/**
 *  @title FeePolicy
 *
 *  @notice This contract determines fees for interacting with the perp and vault systems.
 *
 *          The fee policy attempts to balance the demand for holding perp tokens with
 *          the demand for holding vault tokens; such that the total collateral in the vault
 *          supports rolling over all mature collateral backing perps.
 *
 *          Fees are computed based on the system's subscription ratio which is calculated.
 *              - `subscriptionRatio`  = ((vaultTVL * perpTR) / (perpTVL * vaultTR)) / targetSubscriptionRatio
 *
 *          When the system is "under-subscribed" (sr <= 1):
 *              - Rollover fees flow from perp holders to vault note holders.
 *              - Fees are charged for minting new perps.
 *              - No fees are charged for redeeming perps.
 *
 *          When the system is "over-subscribed" (sr > 1):
 *              - Rollover fees flow from vault note holders to perp holders.
 *              - No fees are charged for minting new perps.
 *              - Fees are charged for redeeming perps.
 *
 *          Regardless of the subscription ratio, the system charges a fixed percentage fee
 *          for minting and redeeming vault notes.
 *
 *          The system favors an elastic perp supply and an inelastic vault note supply.
 *
 *          The rollover fees are signed and can flow in either direction based on the subscription ratio.
 *          The fee is a percentage is computed through a sigmoid function.
 *          The slope and asymptotes are set by the owner.
 *          CRITICAL: The rollover fee percentage is NOT annualized, the fee percentage is applied per rollover.
 *          The number of rollovers per year changes based on the duration of perp's minting bond.
 *
 *          We consider a `normalizedSubscriptionRatio` of greater than 1.0 healthy.
 *          Minting additional perps or redeeming vault notes reduces the subscription ratio.
 *
 */
contract FeePolicy is IFeePolicy, OwnableUpgradeable {
    // Libraries
    using MathUpgradeable for uint256;
    using SafeCastUpgradeable for uint256;

    /// @dev The returned fee percentages are fixed point numbers with {DECIMALS} places.
    ///      The decimals should line up with value expected by consumer (perp, vault).
    ///      NOTE: 10**DECIMALS => 100% or 1.0
    uint8 public constant DECIMALS = 8;
    uint256 public constant ONE = (1 * 10**DECIMALS); // 1.0 or 100%

    uint256 public constant SIGMOID_BOUND = ONE / 100; // 0.01 or 1%
    uint256 public constant SR_LOWER_BOUND = (ONE * 75) / 100; // 0.75 or 75%
    uint256 public constant SR_UPPER_BOUND = 2 * ONE; // 2.0 or 200%

    //-----------------------------------------------------------------------------
    /// @notice The target subscription ratio i.e) the normalization factor.
    /// @dev The ratio above which the system is considered "over-subscribed".
    ///      Adds a safety buffer to ensure that rollovers are better sustained.
    uint256 public targetSubscriptionRatio;

    //-----------------------------------------------------------------------------

    //-----------------------------------------------------------------------------
    // Perp fee parameters

    /// @notice The percentage fee charged on minting perp tokens.
    uint256 private _perpMintFeePerc;

    /// @notice The percentage fee charged on burning perp tokens.
    uint256 private _perpBurnFeePerc;

    struct RolloverFeeSigmoidParams {
        /// @notice Lower asymptote
        int256 lower;
        /// @notice Upper asymptote
        int256 upper;
        /// @notice sigmoid slope
        int256 growth;
    }

    /// @notice Parameters which control the asymptotes and the slope of the perp token's rollover fee.
    RolloverFeeSigmoidParams private _perpRolloverFee;

    //-----------------------------------------------------------------------------

    //-----------------------------------------------------------------------------
    // Vault fee parameters

    /// @notice The percentage fee charged on minting vault notes.
    uint256 private _vaultMintFeePerc;

    /// @notice The percentage fee charged on burning vault notes.
    uint256 private _vaultBurnFeePerc;

    /// @notice The percentage fee charged by the vault to swap underlying tokes for perp tokens.
    uint256 private _vaultUnderlyingToPerpSwapFeePerc;

    /// @notice The percentage fee charged by the vault to swap perp tokens for underlying tokes.
    uint256 private _vaultPerpToUnderlyingSwapFeePerc;

    /// @notice The fixed amount vault fee charged during each deployment.
    /// @dev Denominated in the underlying collateral asset and
    ///      Paid by the vault note holders to the system owner.
    uint256 private _vaultDeploymentFee;

    //-----------------------------------------------------------------------------

    /// @notice Contract initializer.
    function init() public initializer {
        __Ownable_init();

        // initializing mint/burn fees to zero
        _perpMintFeePerc = 0;
        _perpBurnFeePerc = 0;
        _vaultMintFeePerc = 0;
        _vaultBurnFeePerc = 0;

        // initializing swap fees to 100%, to disable swapping initially
        _vaultUnderlyingToPerpSwapFeePerc = ONE;
        _vaultPerpToUnderlyingSwapFeePerc = ONE;

        // NOTE: With the current bond length of 28 days, rollover rate is annualized by dividing by: 365/28 ~= 13
        _perpRolloverFee.lower = -int256(ONE) / (30 * 13); // -0.033/13 = -0.00253 (3.3% annualized)
        _perpRolloverFee.upper = int256(ONE) / (10 * 13); // 0.1/13 = 0.00769 (10% annualized)
        _perpRolloverFee.growth = 5 * int256(ONE); // 5.0

        targetSubscriptionRatio = (ONE * 133) / 100; // 1.33
    }

    //-----------------------------------------------------------------------------
    // Owner only

    /// @notice Updates the target subscription ratio.
    /// @param targetSubscriptionRatio_ The new target subscription ratio as a fixed point number with {DECIMALS} places.
    function updateTargetSubscriptionRatio(uint256 targetSubscriptionRatio_) external onlyOwner {
        require(targetSubscriptionRatio_ > SR_LOWER_BOUND, "FeeStrategy: sr too low");
        require(targetSubscriptionRatio_ <= SR_UPPER_BOUND, "FeeStrategy: sr high low");
        targetSubscriptionRatio = targetSubscriptionRatio_;
    }

    /// @notice Updates the perp mint fee parameters.
    /// @param perpMintFeePerc_ The new perp mint fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updatePerpMintFees(uint256 perpMintFeePerc_) external onlyOwner {
        require(perpMintFeePerc_ <= ONE, "FeeStrategy: perc too high");
        _perpMintFeePerc = perpMintFeePerc_;
    }

    /// @notice Updates the perp burn fee parameters.
    /// @param perpBurnFeePerc_ The new perp burn fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updatePerpBurnFees(uint256 perpBurnFeePerc_) external onlyOwner {
        require(perpBurnFeePerc_ <= ONE, "FeeStrategy: perc too high");
        _perpMintFeePerc = perpBurnFeePerc_;
    }

    /// @notice Update the parameters determining the slope and asymptotes of the sigmoid fee curve.
    /// @param p Lower, Upper and Growth sigmoid paramters are fixed point numbers with {DECIMALS} places.
    function updatePerpRolloverFees(RolloverFeeSigmoidParams calldata p) external onlyOwner {
        require(p.lower >= -int256(SIGMOID_BOUND), "FeeStrategy: sigmoid lower bound too low");
        require(p.upper <= int256(SIGMOID_BOUND), "FeeStrategy: sigmoid upper bound too high");
        require(p.lower <= p.upper, "FeeStrategy: sigmoid asymptotes invalid");
        _perpRolloverFee.lower = p.lower;
        _perpRolloverFee.upper = p.upper;
        _perpRolloverFee.growth = p.growth;
    }

    /// @notice Updates the vault mint fee parameters.
    /// @param vaultMintFeePerc_ The new vault mint fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updateVaultMintFees(uint256 vaultMintFeePerc_) external onlyOwner {
        require(vaultMintFeePerc_ <= ONE, "FeeStrategy: perc too high");
        _vaultMintFeePerc = vaultMintFeePerc_;
    }

    /// @notice Updates the vault burn fee parameters.
    /// @param vaultBurnFeePerc_ The new vault burn fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updateVaultBurnFees(uint256 vaultBurnFeePerc_) external onlyOwner {
        require(vaultBurnFeePerc_ <= ONE, "FeeStrategy: perc too high");
        _vaultBurnFeePerc = vaultBurnFeePerc_;
    }

    /// @notice Updates the vault's deployment fee parameters.
    /// @param vaultDeploymentFee_ The new deployment fee denominated in the underlying tokens.
    function updateVaultDeploymentFees(uint256 vaultDeploymentFee_) external onlyOwner {
        _vaultDeploymentFee = vaultDeploymentFee_;
    }

    /// @notice Updates the vault's share of the underlying to perp swap fee.
    /// @dev Setting fees to 100% or 1.0 will effectively pause swapping.
    /// @param feePerc The new fee percentage.
    function updateVaultUnderlyingToPerpSwapFeePerc(uint256 feePerc) external onlyOwner {
        require(feePerc > ONE, "FeeStrategy: perc too high");
        _vaultUnderlyingToPerpSwapFeePerc = feePerc;
    }

    /// @notice Updates the vault's share of the perp to underlying swap fee.
    /// @dev Setting fees to 100% or 1.0 will effectively pause swapping.
    /// @param feePerc The new fee percentage.
    function updateVaultPerpToUnderlyingSwapFeePerc(uint256 feePerc) external onlyOwner {
        require(feePerc > ONE, "FeeStrategy: perc too high");
        _vaultPerpToUnderlyingSwapFeePerc = feePerc;
    }

    //-----------------------------------------------------------------------------
    // Public methods

    /// @inheritdoc IFeePolicy
    function perpMintFeePerc(uint256 sr) external view override returns (uint256) {
        // When the vault is under-subscribed there exists an active mint fee
        return (sr <= ONE) ? _perpMintFeePerc : 0;
    }

    /// @inheritdoc IFeePolicy
    function perpBurnFeePerc(uint256 sr) external view override returns (uint256) {
        // When the system is over-subscribed there exists an active redemption fee
        return (sr > ONE) ? _perpBurnFeePerc : 0;
    }

    /// @inheritdoc IFeePolicy
    function perpRolloverFeePerc(uint256 sr) external view override returns (int256) {
        return
            Sigmoid.compute(
                sr.toInt256(),
                _perpRolloverFee.lower,
                _perpRolloverFee.upper,
                _perpRolloverFee.growth,
                ONE.toInt256()
            );
    }

    /// @inheritdoc IFeePolicy
    function vaultMintFeePerc() external view override returns (uint256) {
        return _vaultMintFeePerc;
    }

    /// @inheritdoc IFeePolicy
    function vaultBurnFeePerc() external view override returns (uint256) {
        return _vaultBurnFeePerc;
    }

    /// @inheritdoc IFeePolicy
    function vaultDeploymentFee() external view override returns (uint256) {
        return _vaultDeploymentFee;
    }

    /// @inheritdoc IFeePolicy
    function underlyingToPerpSwapFeePercs(uint256 sr) external view override returns (uint256, uint256) {
        // If the system is under-subscribed, swapping is NOT allowed.
        if (sr <= ONE) {
            return (0, ONE);
        }

        // When the system is over-subscribed, perp share of fees is zero.
        return (0, _vaultUnderlyingToPerpSwapFeePerc);
    }

    /// @inheritdoc IFeePolicy
    function perpToUnderlyingSwapFeePercs(uint256 sr) external view override returns (uint256, uint256) {
        // When the system is under-subscribed, perp share of fees is zero.
        if (sr <= ONE) {
            return (0, _vaultPerpToUnderlyingSwapFeePerc);
        }

        return (_perpBurnFeePerc, _vaultPerpToUnderlyingSwapFeePerc);
    }

    /// @inheritdoc IFeePolicy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    /// @inheritdoc IFeePolicy
    function computeSubscriptionRatio(IFeePolicy.SubscriptionParams memory s) public view returns (uint256) {
        // NOTE: We assume that perp's TVL and vault's TVL values have the same base denomination.
        return
            s.vaultTVL.mulDiv(ONE, targetSubscriptionRatio).mulDiv(
                ONE,
                s.perpTVL.mulDiv(s.vaultTR, s.perpTR, MathUpgradeable.Rounding.Up)
            );
    }
}
