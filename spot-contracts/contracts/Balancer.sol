// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ITranche } from "./_interfaces/buttonwood/ITranche.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";
import { IPerpetualTranche } from "./_interfaces/IPerpetualTranche.sol";
import { IRolloverVault } from "./_interfaces/IRolloverVault.sol";
import { IBalancer } from "./_interfaces/IBalancer.sol";
import { IERC20Burnable } from "./_interfaces/IERC20Burnable.sol";
import { IOwnable } from "./_interfaces/IOwnable.sol";
import { TokenAmount, SubscriptionParams, Range, SystemFees, PairAmounts, SigmoidParams } from "./_interfaces/CommonTypes.sol";
import { DROutsideBound, InsufficientLiquidity, InvalidTargetSRBounds, InvalidPerc, InvalidSigmoidAsymptotes } from "./_interfaces/ProtocolErrors.sol";

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";
import { BondTranches, BondTranchesHelpers } from "./_utils/BondTranchesHelpers.sol";
import { BondHelpers } from "./_utils/BondHelpers.sol";
import { Sigmoid } from "./_utils/Sigmoid.sol";

/**
 *  @title Balancer
 *
 *  @notice This contract orchestrates all external interactions and fees with the perp and vault systems.
 *
 *          Through a system of fees, the Balancer attempts to balance the demand for holding perps with
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
 *          Fee breakdown:
 *          - The system charges users "entry" and "exit fees", i.e) fees when users mint/redeem perps and vault notes.
 *          - Rollover fees (or rewards) can flow in either direction between the perp and the vault,
 *            in an attempt incentivize user to push the system closer to dr = 1.
 *          - Users can also "rebalance" between perp and vault notes, and insofar as it moves the dr toward 1,
 *            no fees are charged.
 *
 */
contract Balancer is IBalancer, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    // Math
    using MathUpgradeable for uint256;
    using SafeCastUpgradeable for uint256;
    using SafeCastUpgradeable for int256;
    using SignedMathUpgradeable for int256;

    // data handling
    using BondHelpers for IBondController;
    using BondTranchesHelpers for BondTranches;

    // ERC20 operations
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using SafeERC20Upgradeable for ITranche;
    using SafeERC20Upgradeable for IPerpetualTranche;
    using SafeERC20Upgradeable for IRolloverVault;

    //-------------------------------------------------------------------------
    // Constants & Immutables

    // Replicating value used here:
    // https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 private constant TRANCHE_RATIO_GRANULARITY = 1000;

    /// @dev The returned fee percentages are fixed point numbers with {DECIMALS} places.
    ///      The decimals should line up with value expected by consumer (perp, vault).
    ///      NOTE: 10**DECIMALS => 100% or 1.0
    uint8 public constant DECIMALS = 8;
    uint256 public constant ONE = (1 * 10 ** DECIMALS); // 1.0 or 100%

    /// @dev SIGMOID_BOUND is set to 5%, i.e) the rollover fee can be at most 5% on either direction.
    uint256 public constant SIGMOID_BOUND = ONE / 20; // 0.05 or 5%

    uint256 public constant TARGET_SR_LOWER_BOUND = (ONE * 75) / 100; // 0.75 or 75%
    uint256 public constant TARGET_SR_UPPER_BOUND = 2 * ONE; // 2.0 or 200%

    //-----------------------------------------------------------------------------
    // Storage

    /// @notice The perpetual senior tranche token.
    IPerpetualTranche public perp;

    /// @notice The authorized rollover vault.
    IRolloverVault public vault;

    /// @notice The ERC20 token of the underlying token backing perp and the vault.
    IERC20Upgradeable public underlying;

    /// @notice The target subscription ratio i.e) the normalization factor.
    /// @dev The ratio under which the system is considered "under-subscribed".
    ///      Adds a safety buffer to ensure that rollovers are better sustained.
    uint256 public targetSubscriptionRatio;

    /// @notice The enforced minimum percentage of the vault's value to be held as underlying tokens.
    /// @dev The percentage minimum is enforced after swaps which might reduce the vault's underlying token liquidity.
    ///      This ensures that the vault has sufficient liquid underlying tokens for upcoming rollovers.
    uint256 public vaultMinUnderlyingPerc;

    /// @notice All of the system fees.
    SystemFees public fees;

    /// @notice The enforced DR bounds after swapping operations.
    /// @dev Swapping from perps to underlying is disabled when DR grows above `swapDRBound.upper`.
    ///      Swapping from underlying to perps is disabled when DR shrinks below `swapDRBound.lower`.
    Range public swapDRBound;

    /// @notice The enforced DR bounds after rebalancing operations.
    /// @dev Rebalancing extra perps into vault notes is disabled when DR grows above `rebalanceDRBound.upper`.
    ///      Rebalancing extra vault notes into perps is disabled when DR shrinks below `rebalanceDRBound.lower`.
    Range public rebalanceDRBound;

    //-----------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Contract initializer.
    function init(IPerpetualTranche perp_) public initializer {
        __Ownable_init();

        perp = perp_;
        vault = perp.vault();
        underlying = perp_.underlying();

        updateVaultMinUnderlyingPerc(0);

        uint256 seniorTR = perp_.depositTrancheRatio();
        updateTargetSubscriptionRatio(ONE.mulDiv(TRANCHE_RATIO_GRANULARITY, (TRANCHE_RATIO_GRANULARITY - seniorTR)));
        updateSwapDRLimits(
            Range({
                lower: (ONE * 3) / 4, // 0.75
                upper: (ONE * 3) / 2 // 1.5
            })
        );
        // NOTE: Rebalancing does not charge any fees, we thus choose to be conservative with the limits.
        updateRebalanceDRLimits(
            Range({
                lower: (ONE * 15) / 10, // 1.5
                upper: ONE // 1.0
            })
        );
        updateFees(
            SystemFees({
                perpMintFeePerc: 0,
                perpBurnFeePerc: 0,
                vaultMintFeePerc: 0,
                vaultBurnFeePerc: 0,
                rolloverFee: SigmoidParams({
                    lower: -int256(ONE) / 100, // -0.01 (~12% annualized)
                    upper: int256(ONE) / 50, // 0.02 (~26% annualized)
                    growth: 3 * int256(ONE) // 3.0
                }),
                underlyingToPerpSwapFeePerc: ONE,
                perpToUnderlyingSwapFeePerc: ONE,
                protocolSwapSharePerc: 0
            })
        );
    }

    //-----------------------------------------------------------------------------
    // Owner only

    /// @notice Transfers out any ERC-20 tokens, which may have been added accidentally.
    /// @param token The token address.
    /// @param to The destination address.
    /// @param amount The amount of tokens to be transferred.
    function transferERC20(IERC20Upgradeable token, address to, uint256 amount) external onlyOwner nonReentrant {
        token.safeTransfer(to, amount);
    }

    /// @notice Updates the target subscription ratio.
    /// @param targetSubscriptionRatio_ The new target subscription ratio as a fixed point number with {DECIMALS} places.
    function updateTargetSubscriptionRatio(uint256 targetSubscriptionRatio_) public onlyOwner {
        if (targetSubscriptionRatio_ < TARGET_SR_LOWER_BOUND || targetSubscriptionRatio_ > TARGET_SR_UPPER_BOUND) {
            revert InvalidTargetSRBounds();
        }
        targetSubscriptionRatio = targetSubscriptionRatio_;
    }

    /// @notice Updates the minimum underlying percentage liquidity requirement for the vault (Expressed as a percentage).
    /// @param vaultMinUnderlyingPerc_ The new minimum underlying percentage.
    function updateVaultMinUnderlyingPerc(uint256 vaultMinUnderlyingPerc_) public onlyOwner {
        if (vaultMinUnderlyingPerc_ > ONE) {
            revert InvalidPerc();
        }
        vaultMinUnderlyingPerc = vaultMinUnderlyingPerc_;
    }

    /// @notice Updates the deviation ratio bounds enforced after swaps.
    /// @param swapDRBound_ The new lower and upper deviation ratio bounds as fixed point numbers with {DECIMALS} places.
    function updateSwapDRLimits(Range memory swapDRBound_) public onlyOwner {
        swapDRBound = swapDRBound_;
    }

    /// @notice Updates the deviation ratio bounds enforced after rebalancing.
    /// @param rebalanceDRBound_ The new lower and upper deviation ratio bounds as fixed point numbers with {DECIMALS} places.
    function updateRebalanceDRLimits(Range memory rebalanceDRBound_) public onlyOwner {
        rebalanceDRBound = rebalanceDRBound_;
    }

    /// @notice Updates the system fees.
    /// @param fees_ The new system fees.
    function updateFees(SystemFees memory fees_) public onlyOwner {
        if (
            fees_.perpMintFeePerc > ONE ||
            fees_.perpBurnFeePerc > ONE ||
            fees_.vaultMintFeePerc > ONE ||
            fees_.vaultBurnFeePerc > ONE ||
            fees_.underlyingToPerpSwapFeePerc > ONE ||
            fees_.perpToUnderlyingSwapFeePerc > ONE ||
            fees_.protocolSwapSharePerc > ONE
        ) {
            revert InvalidPerc();
        }

        if (
            fees_.rolloverFee.lower < -int256(SIGMOID_BOUND) ||
            fees_.rolloverFee.upper > int256(SIGMOID_BOUND) ||
            fees_.rolloverFee.lower > fees_.rolloverFee.upper
        ) {
            revert InvalidSigmoidAsymptotes();
        }

        fees = fees_;
    }

    //-------------------------------------------------------------------------
    // External methods

    /// @inheritdoc IBalancer
    function mint2(uint256 underlyingAmtIn) external override nonReentrant returns (PairAmounts memory) {
        // Transfer underlying tokens from user
        underlying.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // Compute perp vault split
        (uint256 underlyingAmtIntoPerp, uint256 underlyingAmtIntoVault) = _computeNeutralPerpVaultSplit(
            underlyingAmtIn
        );

        // Deposit vault share into the vault, and swap remainder for perps
        PairAmounts memory mintAmts;
        _checkAndApproveMax(underlying, address(vault), underlyingAmtIn);
        mintAmts.noteAmt = vault.deposit(underlyingAmtIntoVault);
        mintAmts.perpAmt = vault.swapUnderlyingForPerps(underlyingAmtIntoPerp);

        // Compute and settle fees by burning perps and vault notes
        {
            uint256 perpFeeAmt = mintAmts.perpAmt.mulDiv(computePerpMintFeePerc(), ONE, MathUpgradeable.Rounding.Up);
            mintAmts.perpAmt -= perpFeeAmt;
            IERC20Burnable(address(perp)).burn(perpFeeAmt);
            emit FeePerps(perpFeeAmt);

            uint256 vaultFeeAmt = mintAmts.noteAmt.mulDiv(computeVaultMintFeePerc(), ONE, MathUpgradeable.Rounding.Up);
            mintAmts.noteAmt -= vaultFeeAmt;
            IERC20Burnable(address(vault)).burn(vaultFeeAmt);
            emit FeeVault(vaultFeeAmt);
        }

        // Transfer out perps and notes back to user
        perp.safeTransfer(msg.sender, mintAmts.perpAmt);
        vault.safeTransfer(msg.sender, mintAmts.noteAmt);
        return mintAmts;
    }

    /// @inheritdoc IBalancer
    function mint2WithPerps(uint256 perpAmt) external override nonReentrant returns (PairAmounts memory) {
        // Transfer perps from the user
        perp.safeTransferFrom(msg.sender, address(this), perpAmt);

        // Redeem perps for underlying
        _checkAndApproveMax(perp, address(vault), perpAmt);
        uint256 underlyingAmt = vault.swapPerpsForUnderlying(perpAmt);

        // Compute perp vault split for perps redeemed
        (uint256 underlyingAmtIntoPerp, uint256 underlyingAmtIntoVault) = _computeNeutralPerpVaultSplit(underlyingAmt);

        // Deposit vault share into the vault, and swap remainder for perps
        PairAmounts memory mintAmts;
        _checkAndApproveMax(underlying, address(vault), underlyingAmt);
        mintAmts.noteAmt = vault.deposit(underlyingAmtIntoVault);
        mintAmts.perpAmt = vault.swapUnderlyingForPerps(underlyingAmtIntoPerp);

        // Revert if dr too high
        SubscriptionParams memory s = subscriptionState();
        if (computeDeviationRatio(s) > rebalanceDRBound.upper) {
            revert DROutsideBound();
        }

        // Enforce vault liquidity
        _enforceVaultLiquidity(s.vaultTVL);

        // Transfer vault perps and vault notes back to the user
        perp.safeTransfer(msg.sender, mintAmts.perpAmt);
        vault.safeTransfer(msg.sender, mintAmts.noteAmt);
        return mintAmts;
    }

    /// @inheritdoc IBalancer
    function mint2WithVaultNotes(uint256 noteAmt) external override nonReentrant returns (PairAmounts memory) {
        // Transfer vault notes from the user
        vault.safeTransferFrom(msg.sender, address(this), noteAmt);

        // Redeem vault notes
        uint256 valueRedeemed = noteAmt.mulDiv(vault.getTVL(), vault.totalSupply());
        TokenAmount[] memory vaultTokens = vault.redeem(noteAmt);

        // Compute perp vault split for the underlying value of vault notes redeemed
        (uint256 underlyingAmtIntoPerp, ) = _computeNeutralPerpVaultSplit(valueRedeemed);

        // Vault does not have sufficient underlying token liquidity to execute the rebalance
        if (underlyingAmtIntoPerp > vaultTokens[0].amount) {
            revert InsufficientLiquidity();
        }

        // Mint perps and vault notes
        PairAmounts memory mintAmts;
        _checkAndApproveMax(underlying, address(vault), vaultTokens[0].amount);
        mintAmts.noteAmt = vault.deposit(vaultTokens[0].amount - underlyingAmtIntoPerp);
        uint8 vaultTokensCount = uint8(vaultTokens.length);
        for (uint8 i = 1; i < vaultTokensCount; ++i) {
            _checkAndApproveMax(vaultTokens[i].token, address(vault), vaultTokens[i].amount);
            mintAmts.noteAmt += vault.deposit(ITranche(address(vaultTokens[i].token)), vaultTokens[i].amount);
        }
        mintAmts.perpAmt = vault.swapUnderlyingForPerps(underlyingAmtIntoPerp);

        // Revert if dr too low
        SubscriptionParams memory s = subscriptionState();
        if (computeDeviationRatio(s) < rebalanceDRBound.lower) {
            revert DROutsideBound();
        }

        // Enforce vault liquidity
        _enforceVaultLiquidity(s.vaultTVL);

        // Transfer out perps and notes back to user
        perp.safeTransfer(msg.sender, mintAmts.perpAmt);
        vault.safeTransfer(msg.sender, mintAmts.noteAmt);
        return mintAmts;
    }

    /// @inheritdoc IBalancer
    function mintPerps(ITranche trancheIn, uint256 trancheInAmt) external override nonReentrant returns (uint256) {
        // Transfer tranche tokens to the Balancer
        trancheIn.safeTransferFrom(msg.sender, address(this), trancheInAmt);

        // Use tranche tokens perps
        _checkAndApproveMax(trancheIn, address(perp), trancheInAmt);
        uint256 perpAmtMint = perp.deposit(trancheIn, trancheInAmt);

        // Compute and settle fees by burning perps
        {
            uint256 perpFeeAmt = perpAmtMint.mulDiv(computePerpMintFeePerc(), ONE);
            perpAmtMint -= perpFeeAmt;
            IERC20Burnable(address(perp)).burn(perpFeeAmt);
            emit FeePerps(perpFeeAmt);
        }

        // Transfer out minted perps
        perp.safeTransfer(msg.sender, perpAmtMint);
        return perpAmtMint;
    }

    /// @inheritdoc IBalancer
    function redeemPerps(uint256 perpAmtBurnt) external override nonReentrant returns (TokenAmount[] memory) {
        // Transfer perps to the Balancer
        perp.safeTransferFrom(msg.sender, address(this), perpAmtBurnt);

        // Compute fees
        uint256 perpFeeAmt = perpAmtBurnt.mulDiv(computePerpBurnFeePerc(), ONE, MathUpgradeable.Rounding.Up);
        perpAmtBurnt -= perpFeeAmt;

        // Redeem perps for senior tranches and underlying
        TokenAmount[] memory perpTokens = perp.redeem(perpAmtBurnt);

        // Settle fees by burning perps
        IERC20Burnable(address(perp)).burn(perpFeeAmt);
        emit FeePerps(perpFeeAmt);

        // Transfer out senior tranches and underlying
        uint8 perpTokensCount = uint8(perpTokens.length);
        for (uint8 i = 0; i < perpTokensCount; ++i) {
            perpTokens[i].token.safeTransfer(msg.sender, perpTokens[i].amount);
        }
        return perpTokens;
    }

    /// @inheritdoc IBalancer
    function mintVaultNotes(uint256 underlyingAmtIn) external override nonReentrant returns (uint256) {
        // Transfer underlying tokens from user
        underlying.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // Mint vault notes
        _checkAndApproveMax(underlying, address(vault), underlyingAmtIn);
        uint256 noteAmtMint = vault.deposit(underlyingAmtIn);

        // Compute and settle fees by burning vault notes
        {
            uint256 vaultFeeAmt = noteAmtMint.mulDiv(computeVaultMintFeePerc(), ONE, MathUpgradeable.Rounding.Up);
            noteAmtMint -= vaultFeeAmt;
            IERC20Burnable(address(vault)).burn(vaultFeeAmt);
            emit FeeVault(vaultFeeAmt);
        }

        // Transfer out vault notes
        vault.safeTransfer(msg.sender, noteAmtMint);
        return noteAmtMint;
    }

    /// @inheritdoc IBalancer
    function redeemVaultNotes(uint256 noteAmtBurnt) external override nonReentrant returns (TokenAmount[] memory) {
        // Transfer perps to the Balancer
        vault.safeTransferFrom(msg.sender, address(this), noteAmtBurnt);

        // Compute fees
        uint256 vaultFeeAmt = noteAmtBurnt.mulDiv(computeVaultBurnFeePerc(), ONE, MathUpgradeable.Rounding.Up);
        noteAmtBurnt -= vaultFeeAmt;

        // Redeem vault notes for junior tranches and underlying
        TokenAmount[] memory vaultTokens = vault.redeem(noteAmtBurnt);

        // Settle fees by burning vault notes
        IERC20Burnable(address(vault)).burn(vaultFeeAmt);
        emit FeeVault(vaultFeeAmt);

        // Transfer out junior tranches and underlying
        uint8 vaultTokensCount = uint8(vaultTokens.length);
        for (uint8 i = 0; i < vaultTokensCount; ++i) {
            vaultTokens[i].token.safeTransfer(msg.sender, vaultTokens[i].amount);
        }
        return vaultTokens;
    }

    /// @inheritdoc IBalancer
    /// @dev This operation is disabled if the system's dr increases above the upper drBound.
    function swapUnderlyingForPerps(uint256 underlyingAmtIn) external override nonReentrant returns (uint256) {
        // Get the current system state
        SubscriptionParams memory s = subscriptionState();
        uint256 drPost = computeDeviationRatio(s.perpTVL + underlyingAmtIn, s.vaultTVL, s.seniorTR);

        // Revert if dr too low
        if (drPost < swapDRBound.lower) {
            revert DROutsideBound();
        }

        // Transfer underlying tokens from user
        underlying.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // Compute perp amount out
        uint256 perpAmtOut = underlyingAmtIn.mulDiv(s.perpTVL, perp.totalSupply());

        // Compute fees
        uint256 perpFeeAmtToBurn = perpAmtOut.mulDiv(computePerpMintFeePerc(), ONE, MathUpgradeable.Rounding.Up);
        (uint256 vaultFeePerc, uint256 protocolFeePerc) = computeUnderlyingToPerpSwapFeePerc();
        uint256 vaultFeeUnderlyingAmt = underlyingAmtIn.mulDiv(vaultFeePerc, ONE, MathUpgradeable.Rounding.Up);
        uint256 protocolFeeUnderlyingAmt = underlyingAmtIn.mulDiv(protocolFeePerc, ONE, MathUpgradeable.Rounding.Up);

        // Deduct fees from underlying in
        underlyingAmtIn -= (vaultFeeUnderlyingAmt + protocolFeeUnderlyingAmt);

        // Swap perps for underlying
        _checkAndApproveMax(underlying, address(vault), underlyingAmtIn);
        perpAmtOut = vault.swapUnderlyingForPerps(underlyingAmtIn);

        // Deduct fees from perp out
        perpAmtOut -= perpFeeAmtToBurn;

        // Settle fees
        {
            // We settle perp mint fees by burning perps
            IERC20Burnable(address(perp)).burn(perpFeeAmtToBurn);
            emit FeePerps(perpFeeAmtToBurn);

            // We settle vault swap fees by transferring underlying tokens to the vault
            underlying.safeTransfer(address(vault), vaultFeeUnderlyingAmt);
            emit FeeVault(vault.totalSupply().mulDiv(vaultFeeUnderlyingAmt, s.vaultTVL));

            // We settle protocol swap fees transferring underlying tokens to the vault owner
            underlying.safeTransfer(IOwnable(address(vault)).owner(), protocolFeeUnderlyingAmt);
            emit FeeProtocol(protocolFeeUnderlyingAmt);
        }

        // Enforce vault liquidity
        _enforceVaultLiquidity(s.vaultTVL);

        // Transfer out minted perps
        perp.safeTransfer(msg.sender, perpAmtOut);
        return perpAmtOut;
    }

    /// @inheritdoc IBalancer
    /// @dev This operation is disabled if the system's dr increases above the upper drBound.
    function swapPerpsForUnderlying(uint256 perpAmtIn) external override nonReentrant returns (uint256) {
        // Get the current system state
        SubscriptionParams memory s = subscriptionState();
        uint256 perpSupply = perp.totalSupply();
        uint256 drPost = computeDeviationRatio(
            s.perpTVL.mulDiv(perpSupply - perpAmtIn, perpSupply),
            s.vaultTVL,
            s.seniorTR
        );

        // Revert if dr too high
        if (drPost > swapDRBound.upper) {
            revert DROutsideBound();
        }

        // Transfer perps from user
        perp.safeTransferFrom(msg.sender, address(this), perpAmtIn);

        // Compute underlying amount out
        uint256 underlyingAmtOut = perpAmtIn.mulDiv(s.perpTVL, perp.totalSupply());

        // Compute fees
        uint256 perpFeeAmtToBurn = perpAmtIn.mulDiv(computePerpBurnFeePerc(), ONE, MathUpgradeable.Rounding.Up);
        (uint256 vaultFeePerc, uint256 protocolFeePerc) = computePerpToUnderlyingSwapFeePerc();
        uint256 vaultFeeUnderlyingAmt = underlyingAmtOut.mulDiv(vaultFeePerc, ONE, MathUpgradeable.Rounding.Up);
        uint256 protocolFeeUnderlyingAmt = underlyingAmtOut.mulDiv(protocolFeePerc, ONE, MathUpgradeable.Rounding.Up);

        // Deduct fees from perp in
        perpAmtIn -= perpFeeAmtToBurn;

        // Swap perps for underlying
        _checkAndApproveMax(perp, address(vault), perpAmtIn);
        underlyingAmtOut = vault.swapPerpsForUnderlying(perpAmtIn);

        // Deduce fees from underlying out
        underlyingAmtOut -= (vaultFeeUnderlyingAmt + protocolFeeUnderlyingAmt);

        // Settle fees
        {
            // We settle perp mint fees by burning perps
            IERC20Burnable(address(perp)).burn(perpFeeAmtToBurn);
            emit FeePerps(perpFeeAmtToBurn);

            // We settle vault swap fees by transferring underlying tokens to the vault
            underlying.safeTransfer(address(vault), vaultFeeUnderlyingAmt);
            emit FeeVault(vault.totalSupply().mulDiv(vaultFeeUnderlyingAmt, s.vaultTVL));

            // We settle protocol swap fees transferring underlying tokens to the vault owner
            underlying.safeTransfer(IOwnable(address(vault)).owner(), protocolFeeUnderlyingAmt);
            emit FeeProtocol(protocolFeeUnderlyingAmt);
        }

        // Enforce swap liquidity
        _enforceVaultLiquidity(s.vaultTVL);

        // Transfer out redeemed underlying tokens
        underlying.safeTransfer(msg.sender, underlyingAmtOut);
        return underlyingAmtOut;
    }

    //-----------------------------------------------------------------------------
    // Public view methods

    /// @inheritdoc IBalancer
    function computePerpMintFeePerc() public view override returns (uint256) {
        return fees.perpMintFeePerc;
    }

    /// @inheritdoc IBalancer
    function computePerpBurnFeePerc() public view override returns (uint256) {
        return fees.perpBurnFeePerc;
    }

    /// @inheritdoc IBalancer
    function computePerpRolloverFeePerc(uint256 dr) public view override returns (int256) {
        return
            Sigmoid.compute(
                dr.toInt256(),
                fees.rolloverFee.lower,
                fees.rolloverFee.upper,
                fees.rolloverFee.growth,
                ONE.toInt256()
            );
    }

    /// @inheritdoc IBalancer
    function computeVaultMintFeePerc() public view override returns (uint256) {
        return fees.vaultMintFeePerc;
    }

    /// @inheritdoc IBalancer
    function computeVaultBurnFeePerc() public view override returns (uint256) {
        return fees.vaultBurnFeePerc;
    }

    /// @inheritdoc IBalancer
    function computeUnderlyingToPerpSwapFeePerc() public view returns (uint256, uint256) {
        uint256 totalSwapFeePerc = fees.underlyingToPerpSwapFeePerc;
        uint256 protocolSwapFeePerc = totalSwapFeePerc.mulDiv(fees.protocolSwapSharePerc, ONE);
        return (totalSwapFeePerc - protocolSwapFeePerc, protocolSwapFeePerc);
    }

    /// @inheritdoc IBalancer
    function computePerpToUnderlyingSwapFeePerc() public view override returns (uint256, uint256) {
        uint256 totalSwapFeePerc = fees.perpToUnderlyingSwapFeePerc;
        uint256 protocolSwapFeePerc = totalSwapFeePerc.mulDiv(fees.protocolSwapSharePerc, ONE);
        return (totalSwapFeePerc - protocolSwapFeePerc, protocolSwapFeePerc);
    }

    /// @inheritdoc IBalancer
    function deviationRatio() public view override returns (uint256) {
        return computeDeviationRatio(perp.getTVL(), vault.getTVL(), perp.depositTrancheRatio());
    }

    /// @inheritdoc IBalancer
    function computeDeviationRatio(SubscriptionParams memory s) public view override returns (uint256) {
        return computeDeviationRatio(s.perpTVL, s.vaultTVL, s.seniorTR);
    }

    /// @inheritdoc IBalancer
    function computeDeviationRatio(
        uint256 perpTVL,
        uint256 vaultTVL,
        uint256 seniorTR
    ) public view override returns (uint256) {
        // NOTE: We assume that perp's TVL and vault's TVL values have the same base denomination.
        uint256 juniorTR = TRANCHE_RATIO_GRANULARITY - seniorTR;
        return (vaultTVL * seniorTR).mulDiv(ONE, (perpTVL * juniorTR)).mulDiv(ONE, targetSubscriptionRatio);
    }

    /// @inheritdoc IBalancer
    function subscriptionState() public view override returns (SubscriptionParams memory) {
        return
            SubscriptionParams({
                perpTVL: perp.getTVL(),
                vaultTVL: vault.getTVL(),
                seniorTR: perp.depositTrancheRatio()
            });
    }

    /// @inheritdoc IBalancer
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    //-------------------------------------------------------------------------
    // Private methods

    /// @dev Checks if the spender has sufficient allowance. If not, approves the maximum possible amount.
    function _checkAndApproveMax(IERC20Upgradeable token, address spender, uint256 amount) private {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance < amount) {
            token.safeApprove(spender, type(uint256).max);
        }
    }

    //-------------------------------------------------------------------------
    // Private view methods

    /// @dev Computes the amount to underlying tokens to be deposited into the perp and vault systems to maintain dr = 1.
    function _computeNeutralPerpVaultSplit(uint256 underlyingAmt) private view returns (uint256, uint256) {
        uint256 seniorTR = perp.depositTrancheRatio();
        uint256 adjustedJuniorTR = (TRANCHE_RATIO_GRANULARITY - seniorTR).mulDiv(
            targetSubscriptionRatio,
            ONE,
            MathUpgradeable.Rounding.Up
        );
        uint256 underlyingAmtIntoPerp = underlyingAmt.mulDiv(seniorTR, seniorTR + adjustedJuniorTR);
        return (underlyingAmtIntoPerp, underlyingAmt - underlyingAmtIntoPerp);
    }

    /// @dev Enforces that the vault has sufficient liquid underlying tokens.
    function _enforceVaultLiquidity(uint256 vaultTVL) private view {
        if (underlying.balanceOf(address(vault)) < vaultTVL.mulDiv(vaultMinUnderlyingPerc, ONE)) {
            revert InsufficientLiquidity();
        }
    }
}
