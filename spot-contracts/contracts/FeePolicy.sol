// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IFeePolicy, IERC20Upgradeable } from "./_interfaces/IFeePolicy.sol";
import { IPerpetualTranche, IBondIssuer } from "./_interfaces/IPerpetualTranche.sol";
import { IVault } from "./_interfaces/IVault.sol";

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Sigmoid } from "./_utils/Sigmoid.sol";

/**
 *  @title FeePolicy
 *
 *  @notice This contract determines fees for interacting with the perp and vault systems.
 *
 *          The fee policy attempts to balance the demand for holding perp tokens with
 *          the demand for holding vault tokens; such that the total collateral in the vault
 *          supports rolling over all mature collateral backing perps.
 *
 *          Fees are computed based on the following variables.
 *              - `currentVaultTVL`     : Total value of collateral in the rollover vault at a given time.
 *              - `equilibriumVaultTVL` : The minimum value of collateral that needs to be in the vault
 *                                        to sustain rolling over the entire perp supply.
 *                                        It is the current tvl of perp divided by the tranche ratio of seniors used to mint perp.
 *              - `currentSubscriptionRatio`    : The ratio between the `currentVaultTVL` and the `equilibriumVaultTVL`.
 *              - `targetSubscriptionRatio`     : The subscription ratio above which the system is considered "over-subscribed".
 *                                                Adds a safety buffer to ensure that rollovers are better sustained.
 *              - `normalizedSubscriptionRatio` : The ratio between `currentSubscriptionRatio` and the `targetSubscriptionRatio`.
 *
 *          When the system is "under-subscribed":
 *              - Rollover fees flow from perp holders to vault note holders.
 *              - Fees are charged for minting new perps.
 *              - No fees are charged for redeeming perps.
 *
 *          When the system is "over-subscribed":
 *              - Rollover fees flow from vault note holders to perp holders.
 *              - No fees are charged for minting new perps.
 *              - Fees are charged for redeeming perps.
 *
 *          Regardless of the subscription ratio, the system charges a fixed percentage fee
 *          for minting and redeeming vault notes.
 *
 *          The rollover fees are signed and can flow in either direction based on the subscription ratio.
 *          The fee is a percentage is computed through a sigmoid function.
 *          The slope and asymptotes are set by the owner.
 *
 *              rotationsPerYear = 1_year / mintingBondDuration
 *              rolloverFeePerc = sigmoid(normalizedSubscriptionRatio) / rotationsPerYear
 *
 */
contract FeePolicy is IFeePolicy, OwnableUpgradeable {
    // Libraries
    using MathUpgradeable for uint256;
    using SafeCastUpgradeable for uint256;

    /// @dev The returned fee percentages are fixed point numbers with {DECIMALS} places.
    ///      The decimals should line up with value expected by consumer (perp).
    ///      NOTE: 10**DECIMALS => 100% or 1.0
    uint8 public constant DECIMALS = 8;
    uint256 public constant ONE = (1 * 10**DECIMALS); // 1.0 or 100%
    uint256 public constant SIGMOID_BOUND = ONE / 10; // 0.10 or 10%

    /// @dev Number of seconds in one year. (365.25 * 24 * 3600)
    int256 public constant ONE_YEAR_SEC = 31557600;

    /// @notice Reference to the perpetual token.
    IPerpetualTranche public perp;

    /// @notice Reference to the rollover vault.
    IVault public vault;

    /// @notice The target subscription ratio i.e) the normalization factor.
    uint256 public targetSubscriptionRatio;

    /// @notice The percentage fee charged on minting perp tokens.
    uint256 public perpMintFeePerc;

    /// @notice The percentage fee charged on burning perp tokens.
    uint256 public perpBurnFeePerc;

    /// @notice The percentage fee charged on minting vault notes.
    uint256 public vaultMintFeePerc;

    /// @notice The percentage fee charged on burning vault notes.
    uint256 public vaultBurnFeePerc;

    /// @notice The fixed amount vault fee charged during each deployment.
    /// @dev Denominated in the underlying collateral asset and
    ///      Paid by the vault note holders to the system owner.
    uint256 public vaultDeploymentFee;

    struct RolloverFeeSigmoidParams {
        /// @notice Lower asymptote
        int256 lower;
        /// @notice Upper asymptote
        int256 upper;
        /// @notice sigmoid slope
        int256 growth;
    }

    /// @notice Parameters which control the asymptotes and the slope of the yearly perp token's rollover fee.
    RolloverFeeSigmoidParams public perpRolloverFee;

    /// @dev The current subscription state the vault system relative to the perp supply.
    struct SubscriptionState {
        /// @notice The current tvl of perp.
        uint256 currentPerpTVL;
        /// @notice The current tvl of the rollover vault.
        uint256 currentVaultTVL;
        /// @notice The equilibrium tvl of the rollover vault.
        uint256 equilibriumVaultTVL;
        /// @notice Computed normalized subscription ratio.
        uint256 normalizedSubscriptionRatio;
    }

    /// @notice Contract initializer.
    /// @param perp_ Reference to perp.
    /// @param vault_ Reference to the rollover vault.
    function init(IPerpetualTranche perp_, IVault vault_) public initializer {
        __Ownable_init();

        perp = perp_;
        vault = vault_;

        perpMintFeePerc = 0;
        perpBurnFeePerc = 0;

        vaultMintFeePerc = 0;
        vaultBurnFeePerc = 0;

        perpRolloverFee.lower = -int256(ONE) / 30; // -0.033
        perpRolloverFee.upper = int256(ONE) / 10; // 0.1
        perpRolloverFee.growth = 5 * int256(ONE); // 5.0

        targetSubscriptionRatio = (ONE * 133) / 100; // 1.33
    }

    /// @notice Updates the target subscription ratio.
    /// @param targetSubscriptionRatio_ The new target subscription ratio as a fixed point number with {DECIMALS} places.
    function updateTargetSubscriptionRatio(uint256 targetSubscriptionRatio_) external onlyOwner {
        require(targetSubscriptionRatio_ > 0, "FeeStrategy: invalid subscription");
        targetSubscriptionRatio = targetSubscriptionRatio_;
    }

    /// @notice Updates the perp mint fee parameters.
    /// @param perpMintFeePerc_ The new perp mint fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updatePerpMintFees(uint256 perpMintFeePerc_) external onlyOwner {
        require(perpMintFeePerc_ <= ONE, "FeeStrategy: perc too high");
        perpMintFeePerc = perpMintFeePerc_;
    }

    /// @notice Updates the perp burn fee parameters.
    /// @param perpBurnFeePerc_ The new perp burn fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updatePerpBurnFees(uint256 perpBurnFeePerc_) external onlyOwner {
        require(perpBurnFeePerc_ <= ONE, "FeeStrategy: perc too high");
        perpBurnFeePerc = perpBurnFeePerc_;
    }

    /// @notice Updates the vault mint fee parameters.
    /// @param vaultMintFeePerc_ The new vault mint fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updateVaultMintFees(uint256 vaultMintFeePerc_) external onlyOwner {
        require(vaultMintFeePerc_ <= ONE, "FeeStrategy: perc too high");
        vaultMintFeePerc = vaultMintFeePerc_;
    }

    /// @notice Updates the vault burn fee parameters.
    /// @param vaultBurnFeePerc_ The new vault burn fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updateVaultBurnFees(uint256 vaultBurnFeePerc_) external onlyOwner {
        require(vaultBurnFeePerc_ <= ONE, "FeeStrategy: perc too high");
        vaultBurnFeePerc = vaultBurnFeePerc_;
    }

    /// @notice Update the parameters determining the slope and asymptotes of the sigmoid fee curve.
    /// @param p Lower, Upper and Growth sigmoid paramters are fixed point numbers with {DECIMALS} places.
    function updateRolloverFees(RolloverFeeSigmoidParams calldata p) external onlyOwner {
        require(p.lower >= -int256(SIGMOID_BOUND), "FeeStrategy: sigmoid lower bound too low");
        require(p.upper <= int256(SIGMOID_BOUND), "FeeStrategy: sigmoid upper bound too high");
        require(p.lower <= p.upper, "FeeStrategy: sigmoid asymptotes invalid");
        perpRolloverFee.lower = p.lower;
        perpRolloverFee.upper = p.upper;
        perpRolloverFee.growth = p.growth;
    }

    /// @inheritdoc IFeePolicy
    function computePerpMintFeePerc() external override returns (uint256) {
        return isOverSubscribed() ? 0 : perpMintFeePerc;
    }

    /// @inheritdoc IFeePolicy
    function computePerpBurnFeePerc() external override returns (uint256) {
        return isOverSubscribed() ? perpBurnFeePerc : 0;
    }

    /// @inheritdoc IFeePolicy
    function computePerpRolloverFeePerc() external override returns (int256) {
        IBondIssuer bondIssuer = perp.bondIssuer();
        SubscriptionState memory s = computeSubscriptionState(bondIssuer);

        int256 rolloverFee = Sigmoid.compute(
            s.normalizedSubscriptionRatio.toInt256(),
            perpRolloverFee.lower,
            perpRolloverFee.upper,
            perpRolloverFee.growth,
            ONE.toInt256()
        );

        // We calculate the rollover fee for the given cycle by dividing the annualized rate
        // by the number of cycles in any given year.
        return (rolloverFee * bondIssuer.maxMaturityDuration().toInt256()) / ONE_YEAR_SEC;
    }

    /// @inheritdoc IFeePolicy
    function computeVaultMintFeePerc() external view override returns (uint256) {
        return vaultMintFeePerc;
    }

    /// @inheritdoc IFeePolicy
    function computeVaultBurnFeePerc() external view override returns (uint256) {
        return vaultBurnFeePerc;
    }

    /// @inheritdoc IFeePolicy
    function computeVaultDeploymentFee() external view override returns (uint256) {
        return vaultDeploymentFee;
    }

    /// @inheritdoc IFeePolicy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    /// @return If the rollover vault is over-subscribed based on the current tvls.
    function isOverSubscribed() public returns (bool) {
        SubscriptionState memory s = computeSubscriptionState(perp.bondIssuer());
        return s.normalizedSubscriptionRatio > ONE;
    }

    /// @notice Computes the detailed subscription state based on the current `currentVaultTVL` and `equilibriumVaultTVL`.
    /// @return The subscription state.
    function computeSubscriptionState(IBondIssuer bondIssuer) public returns (SubscriptionState memory) {
        SubscriptionState memory s;
        s.currentPerpTVL = perp.getTVL();
        s.currentVaultTVL = vault.getTVL();
        // NOTE: We assume that perp minting bonds have only 2 tranches and perp assumes the senior one.
        //       We assume that perp's TVL and vault's TVL values have the same base denomination.
        s.equilibriumVaultTVL = s.currentPerpTVL.mulDiv(
            bondIssuer.trancheRatios(1),
            bondIssuer.trancheRatios(0),
            MathUpgradeable.Rounding.Up
        );
        s.normalizedSubscriptionRatio = s.currentVaultTVL.mulDiv(ONE, s.equilibriumVaultTVL).mulDiv(
            ONE,
            targetSubscriptionRatio
        );
        return s;
    }
}
