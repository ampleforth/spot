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
import { TokenAmount, SubscriptionParams, SystemFees, PairAmounts, SigmoidParams } from "./_interfaces/CommonTypes.sol";
import { InvalidTargetSRBounds, InvalidPerc, InvalidSigmoidAsymptotes, UnauthorizedCall, UnacceptableParams } from "./_interfaces/ProtocolErrors.sol";

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";
import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
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
 *          - Whitelisted rebalancers can also "rebalance" between perp tokens and vault notes without any fees.
 *            The owner controls the whitelist and can provide the privilege to
 *            vaults with custom logic, provided they charge an entry and exit fees which is
 *            diverted back into this system.
 *
 */
contract Balancer is IBalancer, OwnableUpgradeable, ReentrancyGuardUpgradeable {
    // Math
    using MathUpgradeable for uint256;
    using SafeCastUpgradeable for uint256;
    using SafeCastUpgradeable for int256;
    using SignedMathUpgradeable for int256;

    // data handling
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.AddressSet;
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

    /// @dev Immature redemption may result in some dust tranches when balances are not perfectly divisible by the tranche ratio.
    ///      Based on current the implementation of `computeRedeemableTrancheAmounts`,
    ///      the dust balances which remain after immature redemption will be *at most* {TRANCHE_RATIO_GRANULARITY} or 1000.
    ///      We exclude the vault's dust tranche balances from TVL computation, note redemption and
    ///      during recovery (through recurrent immature redemption).
    uint256 public constant TRANCHE_DUST_AMT = 100000000;

    /// @dev The returned fee percentages are fixed point numbers with {PERC_DECIMALS} places.
    ///      The decimals should line up with value expected by consumer (perp, vault).
    ///      NOTE: 10**PERC_DECIMALS => 100% or 1.0
    uint8 public constant PERC_DECIMALS = 8;
    uint256 public constant ONE = (1 * 10 ** PERC_DECIMALS); // 1.0 or 100%

    /// @dev SIGMOID_BOUND is set to 5%, i.e) the rollover fee can be at most 5% on either direction.
    uint256 public constant SIGMOID_BOUND = ONE / 20; // 0.05 or 5%

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

    /// @notice All of the system fees.
    SystemFees public fees;

    /// @notice Whitelisted rebalancers.
    EnumerableSetUpgradeable.AddressSet private _rebalancers;

    //--------------------------------------------------------------------------
    // Modifiers

    /// @dev Throws if called by any account other than a whitelisted rebalancer.
    modifier onlyRebalancer() {
        if (!_rebalancers.contains(msg.sender)) {
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
    function init(IPerpetualTranche perp_) public initializer {
        __Ownable_init();

        perp = perp_;
        vault = perp.vault();
        underlying = perp_.underlying();

        uint256 seniorTR = perp_.depositTrancheRatio();
        updateTargetSubscriptionRatio(ONE.mulDiv(TRANCHE_RATIO_GRANULARITY, (TRANCHE_RATIO_GRANULARITY - seniorTR)));
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
    /// @param targetSubscriptionRatio_ The new target subscription ratio as a fixed point number with {PERC_DECIMALS} places.
    function updateTargetSubscriptionRatio(uint256 targetSubscriptionRatio_) public onlyOwner {
        if (targetSubscriptionRatio_ < ONE) {
            revert InvalidTargetSRBounds();
        }
        targetSubscriptionRatio = targetSubscriptionRatio_;
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

    /// @notice Adds address to rebalancer whitelist.
    /// @param rebalancer The rebalancer address to add to the whitelist.
    function addRebalancer(address rebalancer) external onlyOwner {
        if (!_rebalancers.contains(rebalancer)) {
            _rebalancers.add(rebalancer);
        } else {
            revert UnacceptableParams();
        }
    }

    /// @notice Removes address from rebalancer whitelist.
    /// @param rebalancer The rebalancer address to remove from the whitelist.
    function removeRebalancer(address rebalancer) external onlyOwner {
        if (_rebalancers.contains(rebalancer)) {
            _rebalancers.remove(rebalancer);
        } else {
            revert UnacceptableParams();
        }
    }

    //-------------------------------------------------------------------------
    // External methods

    /// @inheritdoc IBalancer
    function mint2(uint256 underlyingAmtIn) external override nonReentrant returns (PairAmounts memory) {
        // Transfer underlying tokens from user
        underlying.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // Mint perps and vault notes
        PairAmounts memory mintAmts = _execMint2(underlyingAmtIn, fees.perpMintFeePerc, fees.vaultMintFeePerc);

        // Transfer out perps and vault notes back to user
        perp.safeTransfer(msg.sender, mintAmts.perpAmt);
        vault.safeTransfer(msg.sender, mintAmts.noteAmt);
        return mintAmts;
    }

    /// @inheritdoc IBalancer
    function redeem2(
        PairAmounts memory burnAmts
    ) external returns (uint256, TokenAmount[] memory, TokenAmount[] memory) {
        // Transfer perps and vault notes from the user to the router
        perp.safeTransferFrom(msg.sender, address(this), burnAmts.perpAmt);
        vault.safeTransferFrom(msg.sender, address(this), burnAmts.noteAmt);

        // Redeem perps and vault notes
        (uint256 underlyingAmt, TokenAmount[] memory perpTranches, TokenAmount[] memory vaultTranches) = _execRedeem2(
            burnAmts,
            fees.perpBurnFeePerc,
            fees.vaultBurnFeePerc
        );

        // Transfer underlying and tranches back to user
        underlying.safeTransfer(msg.sender, underlyingAmt);
        for (uint8 i = 0; i < perpTranches.length; i++) {
            perpTranches[i].token.safeTransfer(msg.sender, perpTranches[i].amount);
        }
        for (uint8 i = 0; i < vaultTranches.length; i++) {
            vaultTranches[i].token.safeTransfer(msg.sender, vaultTranches[i].amount);
        }

        return (underlyingAmt, perpTranches, vaultTranches);
    }

    /// @inheritdoc IBalancer
    function rebalance(
        PairAmounts memory burnAmts
    ) external onlyRebalancer returns (PairAmounts memory, TokenAmount[] memory, TokenAmount[] memory) {
        // Transfer perps and vault notes from the user to the router
        perp.safeTransferFrom(msg.sender, address(this), burnAmts.perpAmt);
        vault.safeTransferFrom(msg.sender, address(this), burnAmts.noteAmt);

        // Redeem perps and vault notes
        (uint256 underlyingAmt, TokenAmount[] memory perpTokens, TokenAmount[] memory vaultTokens) = _execRedeem2(
            burnAmts,
            0,
            0
        );

        // Re-mint perp and vault notes using underlying
        PairAmounts memory mintAmts = _execMint2(underlyingAmt, 0, 0);

        // Transfer out minted perps and vault notes back to the user
        perp.safeTransfer(msg.sender, mintAmts.perpAmt);
        vault.safeTransfer(msg.sender, mintAmts.noteAmt);

        // Transfer out residue tranches back to the user
        for (uint8 i = 0; i < perpTokens.length; i++) {
            perpTokens[i].token.safeTransfer(msg.sender, perpTokens[i].amount);
        }
        for (uint8 i = 0; i < vaultTokens.length; i++) {
            vaultTokens[i].token.safeTransfer(msg.sender, vaultTokens[i].amount);
        }

        return (mintAmts, perpTokens, vaultTokens);
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
            uint256 perpFeeAmt = perpAmtMint.mulDiv(fees.perpMintFeePerc, ONE);
            perpAmtMint -= perpFeeAmt;
            IERC20Burnable(address(perp)).burn(perpFeeAmt);
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
        uint256 perpFeeAmt = perpAmtBurnt.mulDiv(fees.perpBurnFeePerc, ONE, MathUpgradeable.Rounding.Up);
        perpAmtBurnt -= perpFeeAmt;

        // Redeem perps for senior tranches and underlying
        TokenAmount[] memory perpTokens = perp.redeem(perpAmtBurnt);

        // Settle fees by burning perps
        IERC20Burnable(address(perp)).burn(perpFeeAmt);

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
            uint256 vaultFeeAmt = noteAmtMint.mulDiv(fees.vaultMintFeePerc, ONE, MathUpgradeable.Rounding.Up);
            noteAmtMint -= vaultFeeAmt;
            IERC20Burnable(address(vault)).burn(vaultFeeAmt);
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
        uint256 vaultFeeAmt = noteAmtBurnt.mulDiv(fees.vaultBurnFeePerc, ONE, MathUpgradeable.Rounding.Up);
        noteAmtBurnt -= vaultFeeAmt;

        // Redeem vault notes for junior tranches and underlying
        TokenAmount[] memory vaultTokens = vault.redeem(noteAmtBurnt);

        // Settle fees by burning vault notes
        IERC20Burnable(address(vault)).burn(vaultFeeAmt);

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
        // Transfer underlying tokens from user
        underlying.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // Compute swap amounts and fees
        (
            uint256 perpAmtOut,
            uint256 underlyingAmtSwapped,
            uint256 perpFeeAmtToBurn,
            uint256 vaultFeeUnderlyingAmt,
            uint256 protocolFeeUnderlyingAmt
        ) = computeUnderlyingToPerpSwapAmt(underlyingAmtIn);

        // Swap perps for underlying
        _checkAndApproveMax(underlying, address(vault), underlyingAmtSwapped);
        vault.swapUnderlyingForPerps(underlyingAmtSwapped);

        // Settle fees
        {
            // Settle perp mint fees by burning perps
            IERC20Burnable(address(perp)).burn(perpFeeAmtToBurn);

            // Settle vault swap fees by transferring underlying tokens to the vault
            underlying.safeTransfer(address(vault), vaultFeeUnderlyingAmt);

            // Settle protocol swap fees transferring underlying tokens to the vault owner
            underlying.safeTransfer(IOwnable(address(vault)).owner(), protocolFeeUnderlyingAmt);
        }

        // Transfer out minted perps
        perp.safeTransfer(msg.sender, perpAmtOut);
        return perpAmtOut;
    }

    /// @inheritdoc IBalancer
    /// @dev This operation is disabled if the system's dr increases above the upper drBound.
    function swapPerpsForUnderlying(uint256 perpAmtIn) external override nonReentrant returns (uint256) {
        // Transfer perps from user
        perp.safeTransferFrom(msg.sender, address(this), perpAmtIn);

        // Compute swap amounts and fees
        (
            uint256 underlyingAmtOut,
            uint256 perpAmtSwapped,
            uint256 perpFeeAmtToBurn,
            uint256 vaultFeeUnderlyingAmt,
            uint256 protocolFeeUnderlyingAmt
        ) = computePerpToUnderlyingSwapAmt(perpAmtIn);

        // Swap perps for underlying
        _checkAndApproveMax(perp, address(vault), perpAmtSwapped);
        vault.swapPerpsForUnderlying(perpAmtSwapped);

        // Settle fees
        {
            // Settle perp mint fees by burning perps
            IERC20Burnable(address(perp)).burn(perpFeeAmtToBurn);

            // Settle vault swap fees by transferring underlying tokens to the vault
            underlying.safeTransfer(address(vault), vaultFeeUnderlyingAmt);

            // Settle protocol swap fees transferring underlying tokens to the vault owner
            underlying.safeTransfer(IOwnable(address(vault)).owner(), protocolFeeUnderlyingAmt);
        }

        // Transfer out redeemed underlying tokens
        underlying.safeTransfer(msg.sender, underlyingAmtOut);
        return underlyingAmtOut;
    }

    //-----------------------------------------------------------------------------
    // Public view methods

    /// @inheritdoc IBalancer
    function computeUnderlyingToPerpSwapAmt(
        uint256 underlyingAmtIn
    )
        public
        view
        override
        returns (
            uint256 perpAmtOut,
            uint256 underlyingAmtSwapped,
            uint256 perpFeeAmtToBurn,
            uint256 vaultFeeUnderlyingAmt,
            uint256 protocolFeeUnderlyingAmt
        )
    {
        // Compute swap amounts
        uint256 perpTVL = perp.getTVL();
        uint256 perpSupply = perp.totalSupply();
        perpAmtOut = underlyingAmtIn.mulDiv(perpSupply, perpTVL);

        // Compute fee amounts
        (uint256 perpSwapFeePerc, uint256 vaultSwapFeePerc, uint256 protocolFeePerc) = _computeSwapFeeSplit(
            fees.underlyingToPerpSwapFeePerc
        );
        perpFeeAmtToBurn = perpAmtOut.mulDiv(perpSwapFeePerc, ONE, MathUpgradeable.Rounding.Up);
        vaultFeeUnderlyingAmt = underlyingAmtIn.mulDiv(vaultSwapFeePerc, ONE, MathUpgradeable.Rounding.Up);
        protocolFeeUnderlyingAmt = underlyingAmtIn.mulDiv(protocolFeePerc, ONE, MathUpgradeable.Rounding.Up);

        // We deduct the vault and protocol share by holding on to a part of the `underlyingAmtIn`
        underlyingAmtSwapped = underlyingAmtIn - (vaultFeeUnderlyingAmt + protocolFeeUnderlyingAmt);

        // We deduct the perp fee share, by holding on to part of the `perpAmtOut`
        perpAmtOut = underlyingAmtSwapped.mulDiv(perpSupply, perpTVL);
        perpAmtOut -= perpFeeAmtToBurn;
    }

    /// @inheritdoc IBalancer
    function computePerpToUnderlyingSwapAmt(
        uint256 perpAmtIn
    )
        public
        view
        override
        returns (
            uint256 underlyingAmtOut,
            uint256 perpAmtSwapped,
            uint256 perpFeeAmtToBurn,
            uint256 vaultFeeUnderlyingAmt,
            uint256 protocolFeeUnderlyingAmt
        )
    {
        // Compute swap amounts
        uint256 perpTVL = perp.getTVL();
        uint256 perpSupply = perp.totalSupply();
        underlyingAmtOut = perpAmtIn.mulDiv(perpTVL, perpSupply);

        // Compute fee amounts
        (uint256 perpSwapFeePerc, uint256 vaultSwapFeePerc, uint256 protocolFeePerc) = _computeSwapFeeSplit(
            fees.perpToUnderlyingSwapFeePerc
        );
        perpFeeAmtToBurn = perpAmtIn.mulDiv(perpSwapFeePerc, ONE, MathUpgradeable.Rounding.Up);
        vaultFeeUnderlyingAmt = underlyingAmtOut.mulDiv(vaultSwapFeePerc, ONE, MathUpgradeable.Rounding.Up);
        protocolFeeUnderlyingAmt = underlyingAmtOut.mulDiv(protocolFeePerc, ONE, MathUpgradeable.Rounding.Up);

        // We deduct the perp fee share by holding on to a part of the `perpAmtIn`
        perpAmtSwapped = perpAmtIn - perpFeeAmtToBurn;

        // We deduct the vault and protocol share, by holding on to part of the `underlyingAmtOut`
        underlyingAmtOut = perpAmtSwapped.mulDiv(perpTVL, perpSupply);
        underlyingAmtOut -= (vaultFeeUnderlyingAmt + protocolFeeUnderlyingAmt);
    }

    /// @inheritdoc IBalancer
    function computeRolloverFeePerc(uint256 dr) public view override returns (int256) {
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
    function deviationRatio() public view override returns (uint256) {
        return computeDeviationRatio(subscriptionState());
    }

    /// @inheritdoc IBalancer
    function computeDeviationRatio(SubscriptionParams memory s) public view override returns (uint256) {
        // NOTE: We assume that perp's TVL and vault's TVL values have the same base denomination.
        uint256 juniorTR = TRANCHE_RATIO_GRANULARITY - s.seniorTR;
        return (s.vaultTVL * s.seniorTR).mulDiv(ONE, (s.perpTVL * juniorTR)).mulDiv(ONE, targetSubscriptionRatio);
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
    function rebalancerCount() external view override returns (uint256) {
        return _rebalancers.length();
    }

    /// @inheritdoc IBalancer
    function rebalancerAt(uint256 index) external view override returns (address) {
        return _rebalancers.at(index);
    }

    /// @inheritdoc IBalancer
    function decimals() external pure override returns (uint8) {
        return PERC_DECIMALS;
    }

    //-------------------------------------------------------------------------
    // Private methods

    /// @dev Tranches underlying token to mint seniors and juniors, which are used to mint
    ///      into perps and vault notes such that the system's expected balance is preserved.
    function _execMint2(
        uint256 underlyingAmtIn,
        uint256 perpFeePerc,
        uint256 vaultFeePerc
    ) private returns (PairAmounts memory) {
        // Compute perp vault split
        (
            uint256 underlyingAmtIntoPerp,
            uint256 underlyingAmtIntoVault,
            uint256 underlyingAmtBufferIntoVault
        ) = _computeNeutralSplit(underlyingAmtIn);

        // Issues and fetches the latest deposit bond.
        IBondController bond = perp.updateDepositBond();

        // Tranche underlying
        {
            uint256 underlyingAmtToTranche = (underlyingAmtIntoPerp + underlyingAmtIntoVault);
            _checkAndApproveMax(underlying, address(bond), underlyingAmtToTranche);
            bond.deposit(underlyingAmtToTranche);
        }

        BondTranches memory bt = bond.getTranches();
        PairAmounts memory mintAmts;

        // uses senior tranches to mint perps
        uint256 seniorAmt = bt.tranches[0].balanceOf(address(this));
        _checkAndApproveMax(bt.tranches[0], address(perp), seniorAmt);
        mintAmts.perpAmt = perp.deposit(bt.tranches[0], seniorAmt);

        // deposit underlying into vault
        _checkAndApproveMax(underlying, address(vault), underlyingAmtBufferIntoVault);
        mintAmts.noteAmt = vault.deposit(underlyingAmtBufferIntoVault);

        // deposit juniors into vault
        uint256 juniorAmt = bt.tranches[1].balanceOf(address(this));
        _checkAndApproveMax(bt.tranches[1], address(vault), juniorAmt);
        mintAmts.noteAmt += vault.deposit(bt.tranches[1], juniorAmt);

        // Compute and settle fees by burning perps and vault notes
        if (perpFeePerc > 0) {
            uint256 perpFeeAmt = mintAmts.perpAmt.mulDiv(perpFeePerc, ONE, MathUpgradeable.Rounding.Up);
            IERC20Burnable(address(perp)).burn(perpFeeAmt);
            mintAmts.perpAmt -= perpFeeAmt;
        }

        if (vaultFeePerc > 0) {
            uint256 vaultFeeAmt = mintAmts.noteAmt.mulDiv(vaultFeePerc, ONE, MathUpgradeable.Rounding.Up);
            IERC20Burnable(address(vault)).burn(vaultFeeAmt);
            mintAmts.noteAmt -= vaultFeeAmt;
        }

        return mintAmts;
    }

    /// @dev Redeems perp tokens and vault notes for underlying and tranches. It then melds senior and junior
    ///      tranches to redeem more underlying tokens.
    function _execRedeem2(
        PairAmounts memory burnAmts,
        uint256 perpFeePerc,
        uint256 vaultFeePerc
    ) private returns (uint256, TokenAmount[] memory, TokenAmount[] memory) {
        // Compute fees
        PairAmounts memory feeAmts;
        if (perpFeePerc > 0) {
            feeAmts.perpAmt = burnAmts.perpAmt.mulDiv(perpFeePerc, ONE, MathUpgradeable.Rounding.Up);
            burnAmts.perpAmt -= feeAmts.perpAmt;
        }

        if (vaultFeePerc > 0) {
            feeAmts.noteAmt = burnAmts.noteAmt.mulDiv(vaultFeePerc, ONE, MathUpgradeable.Rounding.Up);
            burnAmts.noteAmt -= feeAmts.noteAmt;
        }

        // Recover and Redeem perps for tranches and underlying
        _checkAndApproveMax(perp, address(perp), burnAmts.perpAmt);
        // NOTE: perp.redeem() internally calls perp.recover() which ensures that the tranches are fresh.
        // perp.recover();
        TokenAmount[] memory perpTokens = perp.redeem(burnAmts.perpAmt);

        // Recover and redeem vault notes for tranches and underlying
        vault.recover();
        _checkAndApproveMax(vault, address(vault), burnAmts.noteAmt);
        TokenAmount[] memory vaultTokens = vault.redeem(burnAmts.noteAmt);

        // Settle fees by burning perps and vault notes
        if (feeAmts.perpAmt > 0) {
            IERC20Burnable(address(perp)).burn(feeAmts.perpAmt);
        }
        if (feeAmts.noteAmt > 0) {
            IERC20Burnable(address(vault)).burn(feeAmts.noteAmt);
        }

        // Meld perp tranches with vault tranches if possible,
        // otherwise return the tranches back to the user.
        {
            // NOTE: we recalculate the underlying amount at the end after melding
            // perpTokens[0].token == vaultTokens[0].token == underlying
            perpTokens[0].amount = 0;
            vaultTokens[0].amount = 0;

            for (uint8 i = 1; i < perpTokens.length; i++) {
                IERC20Upgradeable token = perpTokens[i].token;

                // NOTE: As perp.recover() has been invoked,
                // we know for certain that all the tranches in perp are fresh (and have not mature)
                _redeemImmatureTranche(ITranche(address(token)));
                perpTokens[i].amount = token.balanceOf(address(this));

                // If there are any dust tranches from perp, we just send them it back into perp.
                if (perpTokens[i].amount < TRANCHE_DUST_AMT) {
                    token.safeTransfer(address(perp), perpTokens[i].amount);
                    perpTokens[i].amount = 0;
                }
            }
            for (uint8 i = 1; i < vaultTokens.length; i++) {
                IERC20Upgradeable token = vaultTokens[i].token;
                vaultTokens[i].amount = token.balanceOf(address(this));

                // If there are any dust tranches from the vault, we just send them it back into the vault.
                if (vaultTokens[i].amount < TRANCHE_DUST_AMT) {
                    token.safeTransfer(address(vault), vaultTokens[i].amount);
                    vaultTokens[i].amount = 0;
                }
            }
        }

        return (underlying.balanceOf(address(this)), _removeEmptyTokens(perpTokens), _removeEmptyTokens(vaultTokens));
    }

    /// @dev Checks if the spender has sufficient allowance. If not, approves the maximum possible amount.
    function _checkAndApproveMax(IERC20Upgradeable token, address spender, uint256 amount) private {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance < amount) {
            token.safeApprove(spender, type(uint256).max);
        }
    }

    /// @dev Redeems tranche tokens held by this contract, for underlying.
    function _redeemImmatureTranche(ITranche tranche) private {
        IBondController bond = IBondController(tranche.bond());
        uint256[] memory trancheAmts = (bond.getTranches()).computeRedeemableTrancheAmounts(address(this));
        if (trancheAmts[0] > 0) {
            bond.redeem(trancheAmts);
        }
    }

    //-------------------------------------------------------------------------
    // Private view methods

    /// @dev Computes the swap fee split to perp, the vault and the protocol.
    function _computeSwapFeeSplit(uint256 totalSwapFeePerc) private view returns (uint256, uint256, uint256) {
        uint256 protocolSwapFeePerc = totalSwapFeePerc.mulDiv(fees.protocolSwapSharePerc, ONE);
        totalSwapFeePerc -= protocolSwapFeePerc;
        (uint256 perpSwapFeePerc, uint256 vaultSwapFeePerc) = _computePerpVaultSplit(totalSwapFeePerc);
        return (perpSwapFeePerc, vaultSwapFeePerc, protocolSwapFeePerc);
    }

    /// @dev Computes the split for the given amount such that, when deposited into the perp and vault systems maintains a dr = 1.
    function _computePerpVaultSplit(uint256 splitAmt) private view returns (uint256, uint256) {
        (uint256 splitAmtIntoPerp, uint256 splitAmtIntoVault, uint256 splitAmtBufferIntoVault) = _computeNeutralSplit(
            splitAmt
        );
        return (splitAmtIntoPerp, splitAmtIntoVault + splitAmtBufferIntoVault);
    }

    /// @dev Computes the split for the given amount such that, when deposited into the perp and vault systems maintains a dr = 1.
    function _computeNeutralSplit(uint256 splitAmt) private view returns (uint256, uint256, uint256) {
        uint256 seniorShare = perp.depositTrancheRatio();
        uint256 juniorShare = TRANCHE_RATIO_GRANULARITY - seniorShare;
        uint256 bufferShare = juniorShare.mulDiv(targetSubscriptionRatio - ONE, ONE, MathUpgradeable.Rounding.Up);
        uint256 totalShare = seniorShare + juniorShare + bufferShare;
        uint256 splitAmtIntoPerp = splitAmt.mulDiv(seniorShare, totalShare);
        uint256 splitAmtIntoVault = splitAmt.mulDiv(juniorShare, totalShare);
        uint256 splitAmtBufferIntoVault = splitAmt - (splitAmtIntoPerp + splitAmtIntoVault);
        return (splitAmtIntoPerp, splitAmtIntoVault, splitAmtBufferIntoVault);
    }

    /// @dev Filters out tokens with zero amounts.
    function _removeEmptyTokens(TokenAmount[] memory tokensOut) private pure returns (TokenAmount[] memory) {
        uint8 k = 0;
        for (uint8 i = 0; i < tokensOut.length; i++) {
            if (tokensOut[i].amount > 0) {
                k++;
            }
        }
        TokenAmount[] memory filteredTokensOut = new TokenAmount[](k);
        k = 0;
        for (uint8 i = 0; i < tokensOut.length; i++) {
            if (tokensOut[i].amount > 0) {
                filteredTokensOut[k++] = tokensOut[i];
            }
        }
        return filteredTokensOut;
    }
}
