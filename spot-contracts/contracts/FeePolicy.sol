// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { IFeePolicy } from "./_interfaces/IFeePolicy.sol";
import { SubscriptionParams, Range, Line } from "./_interfaces/CommonTypes.sol";
import { InvalidPerc, InvalidFees } from "./_interfaces/ProtocolErrors.sol";

import { LineHelpers } from "./_utils/LineHelpers.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { MathHelpers } from "./_utils/MathHelpers.sol";

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
 *          - The system charges a greater fee for operations that move it away from the balance point.
 *          - If an operation moves the system back to the balance point, it charges a lower fee (or no fee).
 *
 *          Incentives:
 *          - When the system is "under-subscribed", value is transferred from perp to the vault at a predefined rate.
 *            This debases perp tokens gradually and enriches the rollover vault.
 *          - When the system is "over-subscribed", value is transferred from the vault to perp at a predefined rate.
 *            This enriches perp tokens gradually and debases the rollover vault.
 *          - This transfer is implemented through a periodic "rebalance" operation, executed by the vault, and
 *            gradually nudges the system back into balance. On rebalance, the vault queries this policy
 *            to compute the magnitude and direction of value transfer.
 *
 *          NOTE: All parameters are stored as fixed point numbers with {DECIMALS} decimal places.
 *
 *
 */
contract FeePolicy is IFeePolicy, OwnableUpgradeable {
    // Libraries
    using MathUpgradeable for uint256;
    using MathHelpers for uint256;
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
    uint256 public constant ONE = (10 ** DECIMALS);

    //-----------------------------------------------------------------------------
    /// @notice The target subscription ratio i.e) the normalization factor.
    /// @dev The ratio under which the system is considered "under-subscribed".
    ///      Adds a safety buffer to ensure that rollovers are better sustained.
    uint256 public targetSubscriptionRatio;

    //-----------------------------------------------------------------------------
    // Fee parameters

    /// @notice Linear fee function used for operations that decrease DR (x-axis dr, y-axis fees).
    Line public feeFnDRDown;

    /// @notice Linear fee function used for operations that increase DR (x-axis dr, y-axis fees).
    Line public feeFnDRUp;

    //-----------------------------------------------------------------------------
    // Rebalance parameters

    /// @notice Reaction lag factor applied to rebalancing on perp debasement.
    uint256 public perpDebasementLag;

    /// @notice Reaction lag factor applied to rebalancing on perp enrichment.
    uint256 public perpEnrichmentLag;

    /// @notice Lower and upper percentage limits on perp debasement.
    Range public perpDebasementPercLimits;

    /// @notice Lower and upper percentage limits on perp enrichment.
    Range public perpEnrichmentPercLimits;

    /// @notice Minimum number of seconds between subsequent rebalances.
    uint256 public override rebalanceFreqSec;

    /// @notice The percentage of system tvl charged as protocol fees on every rebalance.
    uint256 public override protocolSharePerc;

    /// @notice The address to which the protocol fees are streamed to.
    address public override protocolFeeCollector;

    //-----------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Contract initializer.
    function init() external initializer {
        __Ownable_init();

        targetSubscriptionRatio = (ONE * 150) / 100; // 1.5

        // initializing fees
        feeFnDRDown = Line({
            x1: (ONE * 66) / 100, // 0.66
            y1: ONE / 4, // 25%
            x2: (ONE * 95) / 100, // 0.95
            y2: 0 // 0%
        });
        feeFnDRUp = Line({
            x1: (ONE * 105) / 100, // 1.05
            y1: 0, // 0%
            x2: (ONE * 150) / 100, // 1.5
            y2: ONE / 4 // 25%
        });

        // initializing rebalancing parameters
        perpDebasementLag = 30;
        perpEnrichmentLag = 30;
        perpDebasementPercLimits = Range({
            lower: (ONE) / 200, // 0.5% or 50 bps
            upper: ONE / 40 // 2.5% or 250 bps
        });
        perpEnrichmentPercLimits = Range({
            lower: (ONE) / 200, // 0.5% or 50 bps
            upper: ONE / 40 // 2.5% or 250 bps
        });
        rebalanceFreqSec = 86400; // 1 day
        protocolSharePerc = ONE / 100; // or 1%
        protocolFeeCollector = owner();
    }

    //-----------------------------------------------------------------------------
    // Owner only

    /// @notice Updates the target subscription ratio.
    /// @param targetSubscriptionRatio_ The new target subscription ratio as a fixed point number with {DECIMALS} places.
    function updateTargetSubscriptionRatio(uint256 targetSubscriptionRatio_) external onlyOwner {
        targetSubscriptionRatio = targetSubscriptionRatio_;
    }

    /// @notice Updates the system fee functions.
    /// @param feeFnDRDown_ The new fee function for operations that decrease DR.
    /// @param feeFnDRUp_ The new fee function for operations that increase DR.
    function updateFees(Line memory feeFnDRDown_, Line memory feeFnDRUp_) external onlyOwner {
        // Expect DR to be non-decreasing, x1 <= x2
        bool validFees = ((feeFnDRDown_.x1 <= feeFnDRDown_.x2) && (feeFnDRUp_.x1 <= feeFnDRUp_.x2));

        // Expect equilibrium zone to be valid
        validFees = ((feeFnDRDown_.x2 <= ONE) && (feeFnDRUp_.x1 >= ONE)) && validFees;

        // Expect fees to be non-decreasing when dr moves away from 1.0
        validFees = ((feeFnDRDown_.y1 >= feeFnDRDown_.y2) && (feeFnDRUp_.y1 <= feeFnDRUp_.y2)) && validFees;

        if (!validFees) {
            revert InvalidFees();
        }

        // Expect fee percentages to be valid
        if ((feeFnDRDown_.y1 > ONE) || (feeFnDRDown_.y2 > ONE) || (feeFnDRUp_.y1 > ONE) || (feeFnDRUp_.y2 > ONE)) {
            revert InvalidPerc();
        }

        feeFnDRDown = feeFnDRDown_;
        feeFnDRUp = feeFnDRUp_;
    }

    /// @notice Updates the all the parameters which control magnitude and frequency of the rebalance.
    /// @param perpDebasementLag_ The new perp debasement lag factor.
    /// @param perpEnrichmentLag_ The new perp enrichment lag factor.
    /// @param perpDebasementPercLimits_ The new lower and upper percentage limits on perp debasement.
    /// @param perpEnrichmentPercLimits_ The new lower and upper percentage limits on perp enrichment.
    /// @param rebalanceFreqSec_ The new rebalance frequency in seconds.
    function updateRebalanceConfig(
        uint256 perpDebasementLag_,
        uint256 perpEnrichmentLag_,
        Range memory perpDebasementPercLimits_,
        Range memory perpEnrichmentPercLimits_,
        uint256 rebalanceFreqSec_
    ) external onlyOwner {
        perpDebasementLag = perpDebasementLag_;
        perpEnrichmentLag = perpEnrichmentLag_;
        perpDebasementPercLimits = perpDebasementPercLimits_;
        perpEnrichmentPercLimits = perpEnrichmentPercLimits_;
        rebalanceFreqSec = rebalanceFreqSec_;
    }

    /// @notice Updates the protocol share of tvl extracted on every rebalance.
    /// @param protocolSharePerc_ The share of the tvl which goes to the protocol as a percentage.
    /// @param protocolFeeCollector_ The new fee collector address.
    function updateProtocolFeeConfig(uint256 protocolSharePerc_, address protocolFeeCollector_) external onlyOwner {
        if (protocolSharePerc_ > ONE) {
            revert InvalidPerc();
        }
        protocolSharePerc = protocolSharePerc_;
        protocolFeeCollector = protocolFeeCollector_;
    }

    //-----------------------------------------------------------------------------
    // Public methods

    /// @inheritdoc IFeePolicy
    function computeFeePerc(uint256 drPre, uint256 drPost) public view override returns (uint256) {
        // DR is decreasing, we use feeFnDRDown
        if (drPre > drPost) {
            Line memory fee = feeFnDRDown;
            return
                LineHelpers
                    .computePiecewiseAvgY(
                        fee,
                        Line({ x1: ONE, y1: fee.y2, x2: fee.x2, y2: fee.y2 }),
                        Range({ lower: drPost, upper: drPre }),
                        fee.x2
                    )
                    .toUint256();
        }
        // DR is increasing, we use feeFnDRUp
        else {
            Line memory fee = feeFnDRUp;
            return
                LineHelpers
                    .computePiecewiseAvgY(
                        Line({ x1: ONE, y1: fee.y1, x2: fee.x1, y2: fee.y1 }),
                        fee,
                        Range({ lower: drPre, upper: drPost }),
                        fee.x1
                    )
                    .toUint256();
        }
    }

    /// @inheritdoc IFeePolicy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    /// @inheritdoc IFeePolicy
    function computeRebalanceAmount(
        SubscriptionParams memory s
    ) external view override returns (int256 underlyingAmtIntoPerp) {
        // We skip rebalancing if dr is close to 1.0
        uint256 dr = computeDeviationRatio(s);
        Range memory drEq = drEqZone();
        if (dr >= drEq.lower && dr <= drEq.upper) {
            return 0;
        }

        // We compute the total value that should flow into perp to push the system into equilibrium.
        uint256 totalTVL = s.perpTVL + s.vaultTVL;
        uint256 reqPerpTVL = totalTVL.mulDiv(computeDRNormSeniorTR(s.seniorTR), ONE);
        int256 reqUnderlyingAmtIntoPerp = reqPerpTVL.toInt256() - s.perpTVL.toInt256();

        // Perp debasement, value needs to flow from perp into the vault
        if (reqUnderlyingAmtIntoPerp < 0) {
            // We calculate the 'clipped' lag adjusted rebalance amount
            uint256 underlyingAmtTransferred = (reqUnderlyingAmtIntoPerp.abs() / perpDebasementLag).clip(
                s.perpTVL.mulDiv(perpDebasementPercLimits.lower, ONE),
                s.perpTVL.mulDiv(perpDebasementPercLimits.upper, ONE)
            );

            // We ensure that the rebalance doesn't overshoot equilibrium
            underlyingAmtIntoPerp = SignedMathUpgradeable.max(
                -underlyingAmtTransferred.toInt256(),
                reqUnderlyingAmtIntoPerp
            );
        }
        // Perp enrichment, from the vault into perp
        else if (reqUnderlyingAmtIntoPerp > 0) {
            // We calculate the 'clipped' lag adjusted rebalance amount
            uint256 underlyingAmtTransferred = (reqUnderlyingAmtIntoPerp.toUint256() / perpEnrichmentLag).clip(
                s.perpTVL.mulDiv(perpEnrichmentPercLimits.lower, ONE),
                s.perpTVL.mulDiv(perpEnrichmentPercLimits.upper, ONE)
            );

            // We ensure that the rebalance doesn't overshoot equilibrium
            underlyingAmtIntoPerp = SignedMathUpgradeable.min(
                underlyingAmtTransferred.toInt256(),
                reqUnderlyingAmtIntoPerp
            );
        }
    }

    /// @inheritdoc IFeePolicy
    function computeDeviationRatio(SubscriptionParams memory s) public view override returns (uint256) {
        // NOTE: We assume that perp's TVL and vault's TVL values have the same base denomination.
        uint256 juniorTR = TRANCHE_RATIO_GRANULARITY - s.seniorTR;
        return (s.vaultTVL * s.seniorTR).mulDiv(ONE, (s.perpTVL * juniorTR)).mulDiv(ONE, targetSubscriptionRatio);
    }

    /// @inheritdoc IFeePolicy
    function computeDRNormSeniorTR(uint256 seniorTR) public view override returns (uint256) {
        uint256 juniorTR = (TRANCHE_RATIO_GRANULARITY - seniorTR);
        return ONE.mulDiv((seniorTR * ONE), (seniorTR * ONE) + (juniorTR * targetSubscriptionRatio));
    }

    /// @return The range of deviation ratios which define the equilibrium zone.
    /// @dev We infer the equilibrium from the fee function definitions, i.e) the upperDR in `feeFnDRDown`
    ///      and lowerDR in `feeFnDRUp`.
    function drEqZone() public view returns (Range memory) {
        return Range({ lower: feeFnDRDown.x2, upper: feeFnDRUp.x1 });
    }
}
