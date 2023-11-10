// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IFeeStrategy, IERC20Upgradeable } from "../_interfaces/IFeeStrategy.sol";
import { IPerpetualTranche, IBondController } from "../_interfaces/IPerpetualTranche.sol";
import { IVault } from "../_interfaces/IVault.sol";

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Sigmoid } from "../_utils/Sigmoid.sol";
import { BondHelpers } from "../_utils/BondHelpers.sol";
import { PerpHelpers } from "../_utils/PerpHelpers.sol";

/**
 *  @title FeeStrategy
 *
 *  @notice This contract determines perp's mint, burn and rollover fees.
 *
 *          Fees are computed based on the deviationRatio, ie the ratio between
 *          the current TVL to the expcted TVL in the vault system.
 *
 *          A `deviationRatio` of 1.0, means that the system is in balance.
 *
 *              expectedTVL = perpTVL / trancheRatio
 *              deviationRatio = currentTVL/expectedTVL
 *
 *          1) Perp mint fees are turned on when deviationRatio < 1,
 *             and is a fixed percentage fee set by the owner.
 *
 *          2) Perp burn fees are turned on when deviationRatio > 1,
 *             and is a fixed percentage fee set by the owner.
 *
 *          3) The rollover fees are signed and can flow in either direction.
 *             The fee is a percentage of the tranches rolled over and is computed
 *             through a sigmoid function. The slope and asymptotes are set by the owner.
 *
 *              rotationsPerYear = 1_year / mintingBondDuration
 *              rolloverFeePerc = sigmoid(deviationRatio) / rotationsPerYear
 *
 */
contract FeeStrategy is IFeeStrategy, OwnableUpgradeable {
    // Libraries
    using MathUpgradeable for uint256;
    using SafeCastUpgradeable for uint256;
    using BondHelpers for IBondController;
    using PerpHelpers for IPerpetualTranche;

    /// @dev The returned fee percentages are fixed point numbers with {DECIMALS} places.
    ///      The decimals should line up with value expected by consumer (perp).
    ///      NOTE: 10**DECIMALS => 100% or 1.0
    uint8 public constant DECIMALS = 8;
    uint256 public constant ONE = (1 * 10**DECIMALS); // 1.0 or 100%
    uint256 public constant SIGMOID_BOUND = ONE / 10; // 0.10 or 10%

    /// @dev Number of seconds in one year. (365.25 * 24 * 3600)
    int256 public constant ONE_YEAR_SEC = 31557600;

    // Replicating value used here:
    // https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 private constant TRANCHE_RATIO_GRANULARITY = 1000;

    /// @notice Reference to the perpetual token.
    IPerpetualTranche public immutable perp;

    /// @notice Reference to the rollover vault.
    IVault public immutable vault;

    /// @notice Defines the target deviation ratio between the expected and current TVLs,
    ///         at which the system is considered to be in balance.
    uint256 public targetDeviationRatio;

    /// @notice The perp token's mint fee percentage celing.
    uint256 public maxMintFeePerc;

    /// @notice The perp token's burn fee percentage celing.
    uint256 public maxBurnFeePerc;

    struct SigmoidParams {
        /// @notice Lower asymptote
        int256 lower;
        /// @notice Upper asymptote
        int256 upper;
        /// @notice Sigmoid slope
        int256 growth;
    }

    /// @notice Parameters which control the asymptotes and the slope of the yearly perp token's rollover fee.
    SigmoidParams public rolloverFeeAPR;

    /// @notice Contract constructor.
    /// @param perp_ Reference to perp.
    /// @param vault_ Reference to the vault.
    constructor(IPerpetualTranche perp_, IVault vault_) {
        perp = perp_;
        vault = vault_;
    }

    /// @notice Contract initializer.
    function init() public initializer {
        __Ownable_init();
        maxMintFeePerc = ONE / 40; // 0.025
        maxBurnFeePerc = ONE / 40; // 0.025
        rolloverFeeAPR.lower = -int256(ONE) / 50; // -0.02
        rolloverFeeAPR.upper = int256(ONE) / 20; // 0.05
        rolloverFeeAPR.growth = 5 * int256(ONE); // 5.0
        targetDeviationRatio = ONE; // 1.0
    }

    /// @notice Updates the target deviation ratio.
    /// @param targetDeviationRatio_ The new target deviation ratio
    ///        as a fixed point number with {DECIMALS} places.
    function updateDeviationTarget(uint256 targetDeviationRatio_) external onlyOwner {
        require(targetDeviationRatio_ > 0, "FeeStrategy: target deviation ratio too low");
        targetDeviationRatio = targetDeviationRatio_;
    }

    /// @notice Updates the mint fee parameters.
    /// @param maxMintFeePerc_ The new mint fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updateMintFees(uint256 maxMintFeePerc_) external onlyOwner {
        require(maxMintFeePerc_ <= ONE, "FeeStrategy: mint fee too high");
        maxMintFeePerc = maxMintFeePerc_;
    }

    /// @notice Updates the burn fee parameters.
    /// @param maxBurnFeePerc_ The new burn fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updateBurnFees(uint256 maxBurnFeePerc_) external onlyOwner {
        require(maxBurnFeePerc_ <= ONE, "FeeStrategy: burn fee too high");
        maxBurnFeePerc = maxBurnFeePerc_;
    }

    /// @notice Update the parameters determining the slope and asymptotes of the sigmoid fee curve.
    /// @param p Lower, Upper and Growth sigmoid paramters are fixed point numbers with {DECIMALS} places.
    function updateRolloverFees(SigmoidParams calldata p) external onlyOwner {
        require(p.lower >= -int256(SIGMOID_BOUND), "FeeStrategy: fee lower bound too low");
        require(p.upper <= int256(SIGMOID_BOUND), "FeeStrategy: fee upper bound too high");
        require(p.lower <= p.upper, "FeeStrategy: paramters invalid");
        rolloverFeeAPR.lower = p.lower;
        rolloverFeeAPR.upper = p.upper;
        rolloverFeeAPR.growth = p.growth;
    }

    /// @inheritdoc IFeeStrategy
    function computeMintFeePerc() external override returns (uint256) {
        // when vault tvl > target, we encourage supply growth by dropping mint fees to 0
        return (computeDeviationRatio(perp.getDepositBond()) > ONE) ? 0 : maxMintFeePerc;
    }

    /// @inheritdoc IFeeStrategy
    function computeBurnFeePerc() external override returns (uint256) {
        // when vault tvl < target, we encorage supply reduction by dropping burn fees to 0
        return (computeDeviationRatio(perp.getDepositBond()) < ONE) ? 0 : maxBurnFeePerc;
    }

    /// @inheritdoc IFeeStrategy
    function computeRolloverFeePerc() external override returns (int256) {
        IBondController referenceBond = perp.getDepositBond();
        int256 rolloverAPR = Sigmoid.compute(
            computeDeviationRatio(referenceBond).toInt256(),
            rolloverFeeAPR.lower,
            rolloverFeeAPR.upper,
            rolloverFeeAPR.growth,
            int256(targetDeviationRatio)
        );

        // We calculate the rollover fee for the given cycle by dividing the annualized rate
        // by the number of cycles in any given year.
        return (rolloverAPR * referenceBond.duration().toInt256()) / ONE_YEAR_SEC;
    }

    /// @inheritdoc IFeeStrategy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Computes the deviation ratio, ie) the ratio between the vault's TVL and the target TVL.
    /// @return The deviation ratio as a fixed point number with {DECIMALS} places.
    function computeDeviationRatio(IBondController referenceBond) public returns (uint256) {
        // NOTE: Ensure that the perp's TVL and vault's TVL have the same base denomination.
        (uint256 perpRatio, ) = perp.computeEffectiveTrancheRatio(referenceBond);
        uint256 targetTVL = perp.getTVL().mulDiv(TRANCHE_RATIO_GRANULARITY, perpRatio);
        uint256 currentDeviationRatio = vault.getTVL().mulDiv(ONE, targetTVL);
        return currentDeviationRatio;
    }

    //-------------------------------------------------------------------------
    // Deprecated section, keeping for backward comparability with RouterV1.

    // @notice Deprecated.
    function feeToken() external view override returns (IERC20Upgradeable) {
        return perp;
    }

    // @notice Deprecated.
    function computeMintFees(
        uint256 /*mintAmt*/
    ) external pure override returns (int256, uint256) {
        return (0, 0);
    }

    // @notice Deprecated.
    function computeBurnFees(
        uint256 /*burnAmt*/
    ) external pure override returns (int256, uint256) {
        return (0, 0);
    }

    // @notice Deprecated.
    function computeRolloverFees(
        uint256 /*rolloverAmt*/
    ) external pure override returns (int256, uint256) {
        return (0, 0);
    }
}
