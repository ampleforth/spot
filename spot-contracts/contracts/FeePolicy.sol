// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IFeePolicy, IERC20Upgradeable } from "./_interfaces/IFeePolicy.sol";
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
 *          Fees are computed based on the following variables.
 *              - `vaultTVL`                    : Total value of collateral in the rollover vault at a given time.
 *              - `equilibriumVaultTVL`         : The minimum value of collateral that needs to be in the vault
 *                                                to sustain rolling over the entire perp supply.
 *              - `subscriptionRatio`           : The ratio between the `vaultTVL` and the `equilibriumVaultTVL`.
 *              - `targetSubscriptionRatio`     : The ratio above which the system is considered "over-subscribed".
 *                                                Adds a safety buffer to ensure that rollovers are better sustained.
 *              - `normalizedSubscriptionRatio` : The ratio between `subscriptionRatio` and the `targetSubscriptionRatio`.
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

    /// @dev Using the same granularity as the underlying buttonwood tranche contracts.
    ///      https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 private constant TRANCHE_RATIO_GRANULARITY = 1000;

    uint256 public constant SIGMOID_BOUND = ONE / 100; // 0.01 or 1%
    uint256 public constant SR_LOWER_BOUND = (ONE * 75) / 100; // 0.75 or 75%
    uint256 public constant SR_UPPER_BOUND = 2 * ONE; // 2.0 or 200%

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

    /// @notice Mapping between `hash({assetIn,assetOut})` and the fee percentage.
    mapping(bytes32 => uint256) public vaultSwapFeePerc;

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

        // NOTE: With the current bond length of 28 days, rollover rate is annualized by dividing by: 365/28 ~= 13
        perpRolloverFee.lower = -int256(ONE) / (30 * 13); // -0.033/13 = -0.00253 (3.3% annualized)
        perpRolloverFee.upper = int256(ONE) / (10 * 13); // 0.1/13 = 0.00769 (10% annualized)
        perpRolloverFee.growth = 5 * int256(ONE); // 5.0

        targetSubscriptionRatio = (ONE * 133) / 100; // 1.33
    }

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
        perpMintFeePerc = perpMintFeePerc_;
    }

    /// @notice Updates the perp burn fee parameters.
    /// @param perpBurnFeePerc_ The new perp burn fee ceiling percentage
    ///        as a fixed point number with {DECIMALS} places.
    function updatePerpBurnFees(uint256 perpBurnFeePerc_) external onlyOwner {
        require(perpBurnFeePerc_ <= ONE, "FeeStrategy: perc too high");
        perpBurnFeePerc = perpBurnFeePerc_;
    }

    /// @notice Update the parameters determining the slope and asymptotes of the sigmoid fee curve.
    /// @param p Lower, Upper and Growth sigmoid paramters are fixed point numbers with {DECIMALS} places.
    function updatePerpRolloverFees(RolloverFeeSigmoidParams calldata p) external onlyOwner {
        require(p.lower >= -int256(SIGMOID_BOUND), "FeeStrategy: sigmoid lower bound too low");
        require(p.upper <= int256(SIGMOID_BOUND), "FeeStrategy: sigmoid upper bound too high");
        require(p.lower <= p.upper, "FeeStrategy: sigmoid asymptotes invalid");
        perpRolloverFee.lower = p.lower;
        perpRolloverFee.upper = p.upper;
        perpRolloverFee.growth = p.growth;
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

    /// @notice Updates the vault's deployment fee parameters.
    /// @param vaultDeploymentFee_ The new deployment fee denominated in the underlying tokens.
    function updateVaultDeploymentFees(uint256 vaultDeploymentFee_) external onlyOwner {
        vaultDeploymentFee = vaultDeploymentFee_;
    }

    /// @notice Updates the swap fee percentage for a given pair of assets.
    /// @dev Setting fees to 100% or 1.0 will effectively pause swapping.
    /// @param assetIn The asset swapped in.
    /// @param assetOut The vault asset swapped out.
    /// @param feePerc The swap fee percentage.
    function updateVaultSwapFees(
        address assetIn,
        address assetOut,
        uint256 feePerc
    ) external onlyOwner {
        require(feePerc <= ONE, "FeeStrategy: perc too high");
        bytes32 pairHash = keccak256(abi.encodePacked(assetIn, assetOut));
        if (feePerc > 0) {
            vaultSwapFeePerc[pairHash] = feePerc;
        } else {
            delete vaultSwapFeePerc[pairHash];
        }
    }

    /// @inheritdoc IFeePolicy
    function computePerpMintFeePerc(uint256 perpValueIn) external override returns (uint256) {
        // The act of minting more perps reduces the subscription ratio,
        // We thus have to check if the "post"-minting subscription state is healthy and
        // account for fees accordingly.
        IFeePolicy.SubscriptionState memory postMintState = computeSubscriptionState(
            perp.getDepositBond(),
            perp.getTVL() + perpValueIn,
            vault.getTVL()
        );

        // When the system is under-subscribed there exists an active mint fee
        return (postMintState.normalizedSubscriptionRatio <= 1) ? perpMintFeePerc : 0;
    }

    /// @inheritdoc IFeePolicy
    function computePerpBurnFeePerc(uint256 perpAmtBurnt, uint256 perpTotalSupply) external override returns (uint256) {
        // The act of burning perps increases the subscription ratio,
        // We thus have to check if the "post"-burning subscription state to account for fees.

        // NOTE: The perp and vault TVLs are denominated in the underlying asset.
        // We calulate the perp post-burn TVL, by multiplying the current tvl by
        // the fraction of supply remaning.
        IFeePolicy.SubscriptionState memory postBurnState = computeSubscriptionState(
            perp.getDepositBond(),
            perp.getTVL().mulDiv(perpTotalSupply - perpAmtBurnt, perpTotalSupply),
            vault.getTVL()
        );
        // When the system is over-subscribed there exists an active redemption fee
        return (postBurnState.normalizedSubscriptionRatio > 1) ? perpBurnFeePerc : 0;
    }

    /// @inheritdoc IFeePolicy
    function computePerpRolloverFeePerc() external override returns (int256) {
        IFeePolicy.SubscriptionState memory s = computeSubscriptionState();
        return
            Sigmoid.compute(
                s.normalizedSubscriptionRatio.toInt256(),
                perpRolloverFee.lower,
                perpRolloverFee.upper,
                perpRolloverFee.growth,
                ONE.toInt256()
            );
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
    function computeUnderlyingToPerpSwapFeePercs(uint256 valueIn) external override returns (uint256, uint256) {
        // When user swaps underlying for vault's perps -> perps are minted by the vault
        // Similar to perp mint fees, here too check the "post"-minting subscription state.
        uint256 currentPerpTVL = perp.getTVL();
        uint256 currentVaultTVL = vault.getTVL();
        IFeePolicy.SubscriptionState memory postMintState = computeSubscriptionState(
            perp.getDepositBond(),
            currentPerpTVL + valueIn,
            currentVaultTVL
        );

        // If minting leaves the vault under-subscribed, swapping by minting perps is NOT allowed.
        if (postMintState.normalizedSubscriptionRatio <= 1) {
            return (0, ONE);
        }

        // When the system is over-subscribed, we charge no perp mint fee.
        uint256 vaultFeePerc = vaultSwapFeePerc[
            keccak256(abi.encodePacked(address(vault.underlying()), address(perp)))
        ];
        return (0, vaultFeePerc);
    }

    /// @inheritdoc IFeePolicy
    function computePerpToUnderlyingSwapFeePercs(uint256 valueIn) external override returns (uint256, uint256) {
        // When user swaps perps for vault's underlying -> perps are redeemed by the vault
        // Similar to perp burn fees, here too check the "post"-burn subscription state.
        uint256 currentPerpTVL = perp.getTVL();
        uint256 currentVaultTVL = vault.getTVL();
        IFeePolicy.SubscriptionState memory postBurnState = computeSubscriptionState(
            perp.getDepositBond(),
            currentPerpTVL - valueIn,
            currentVaultTVL
        );

        // Split the fees between the perp and vault systems
        uint256 vaultFeePerc = vaultSwapFeePerc[
            keccak256(abi.encodePacked(address(perp), address(vault.underlying())))
        ];
        // When the system is under-subscribed, we charge no perp burn fee.
        if (postBurnState.normalizedSubscriptionRatio <= 1) {
            return (0, vaultFeePerc);
        }

        // When the system is over-subscribed, we charge a perp burn fee on top of the vault's swap fee.
        return (perpBurnFeePerc, vaultFeePerc);
    }

    /// @inheritdoc IFeePolicy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    /// @notice Computes the detailed subscription state.
    /// @return The subscription state.
    function computeSubscriptionState() public override returns (IFeePolicy.SubscriptionState memory) {
        return computeSubscriptionState(perp.getDepositBond(), perp.getTVL(), vault.getTVL());
    }

    /// @notice Computes the detailed subscription state based on the given `perpTVL` and `vaultTVL`.
    /// @return The subscription state.
    function computeSubscriptionState(
        IBondController depositBond,
        uint256 perpTVL,
        uint256 vaultTVL
    ) public view returns (IFeePolicy.SubscriptionState memory) {
        IFeePolicy.SubscriptionState memory s;
        s.perpTVL = perpTVL;
        s.vaultTVL = vaultTVL;
        // NOTE: We assume that perp only accepts the senior one.
        //       We assume that perp's TVL and vault's TVL values have the same base denomination.
        (, uint256 perpTR) = depositBond.tranches(0);
        uint256 equilibriumVaultTVL = s.perpTVL.mulDiv(
            TRANCHE_RATIO_GRANULARITY - perpTR,
            perpTR,
            MathUpgradeable.Rounding.Up
        );
        s.normalizedSubscriptionRatio = s.vaultTVL.mulDiv(ONE, equilibriumVaultTVL).mulDiv(
            ONE,
            targetSubscriptionRatio
        );
        return s;
    }
}
