// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { IERC20Upgradeable, IPerpetualTranche, IBondController, ITranche, IFeePolicy } from "./_interfaces/IPerpetualTranche.sol";
import { IVault } from "./_interfaces/IVault.sol";
import { IRolloverVault } from "./_interfaces/IRolloverVault.sol";
import { IERC20Burnable } from "./_interfaces/IERC20Burnable.sol";
import { TokenAmount, RolloverData, SystemTVL } from "./_interfaces/CommonTypes.sol";
import { UnauthorizedCall, UnauthorizedTransferOut, UnexpectedDecimals, UnexpectedAsset, OutOfBounds, UnacceptableSwap, InsufficientDeployment, DeployedCountOverLimit, InsufficientLiquidity, LastRebalanceTooRecent } from "./_interfaces/ProtocolErrors.sol";

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";
import { ERC20BurnableUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { BondTranches, BondTranchesHelpers } from "./_utils/BondTranchesHelpers.sol";
import { TrancheHelpers } from "./_utils/TrancheHelpers.sol";
import { BondHelpers } from "./_utils/BondHelpers.sol";
import { PerpHelpers } from "./_utils/PerpHelpers.sol";
import { ERC20Helpers } from "./_utils/ERC20Helpers.sol";
import { TrancheManager } from "./_utils/TrancheManager.sol";

/*
 *  @title RolloverVault
 *
 *  @notice A vault which performs rollovers on PerpetualTranche (or perp). After rolling over,
 *          it holds the junior tranches to maturity, effectively becoming a perpetual junior tranche.
 *
 *          The vault takes in AMPL or any other rebasing collateral as the "underlying" asset.
 *          It also generates a yield (from entry/exit fees, flash swap liquidity, and rebalancing incentives).
 *
 *          Vault strategy:
 *              1) deploy: The vault deposits the underlying asset into perp's current deposit bond
 *                 to get tranche tokens in return, it then swaps these fresh tranche tokens for
 *                 older tranche tokens (ones mature or approaching maturity) from perp.
 *              2) recover: The vault redeems the tranches it holds for the underlying asset.
 *                 NOTE: It performs both mature and immature redemption. Read more: https://bit.ly/3tuN6OC
 *
 *          The vault provides perp<>underlying swap liquidity and charges a fee.
 *          The swap fees are an additional source of yield for vault note holders.
 *
 *          The vault has a "rebalance" operation (which can be executed at most once a day).
 *          This is intended to balance demand for holding perp tokens with
 *          the demand for holding vault notes, such that the vault is always sufficiently capitalized.
 *
 *
 * @dev When new tranches are added into the system, always double check if they are not malicious
 *      by only accepting one whitelisted by perp (ones part of perp's deposit bond or ones part of the perp reserve).
 *
 *      We use `_syncAsset` and `_syncDeployedAsset` to keep track of tokens entering and leaving the system.
 *      When ever a tranche token enters or leaves the system, we immediately invoke `_syncDeployedAsset` to update book-keeping.
 *      We call `_syncAsset` at the very end of every external function which changes the vault's underlying or perp balance.
 *
 */
contract RolloverVault is
    ERC20BurnableUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    IRolloverVault
{
    // data handling
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.AddressSet;
    using BondHelpers for IBondController;
    using TrancheHelpers for ITranche;
    using BondTranchesHelpers for BondTranches;

    // ERC20 operations
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using SafeERC20Upgradeable for ITranche;
    using ERC20Helpers for IERC20Upgradeable;

    // math
    using MathUpgradeable for uint256;
    using SignedMathUpgradeable for int256;
    using SafeCastUpgradeable for int256;

    /// Allow linking TrancheManager
    /// @custom:oz-upgrades-unsafe-allow external-library-linking

    //-------------------------------------------------------------------------
    // Events

    /// @notice Emits the vault asset's token balance that's recorded after a change.
    /// @param token Address of token.
    /// @param balance The recorded ERC-20 balance of the token.
    event AssetSynced(IERC20Upgradeable token, uint256 balance);

    //-------------------------------------------------------------------------
    // Constants

    /// @dev Internal percentages are fixed point numbers with {PERC_DECIMALS} places.
    uint8 public constant PERC_DECIMALS = 8;
    uint256 public constant ONE = (10 ** PERC_DECIMALS); // 1.0 or 100%

    /// @dev Initial exchange rate between the underlying asset and notes.
    uint256 private constant INITIAL_RATE = 10 ** 6;

    /// @dev The maximum number of deployed assets that can be held in this vault at any given time.
    uint8 public constant MAX_DEPLOYED_COUNT = 47;

    /// @dev Immature redemption may result in some dust tranches when balances are not perfectly divisible by the tranche ratio.
    ///      Based on current the implementation of `computeRedeemableTrancheAmounts`,
    ///      the dust balances which remain after immature redemption will be *at most* {TRANCHE_RATIO_GRANULARITY} or 1000.
    ///      We exclude the vault's dust tranche balances from TVL computation, note redemption and
    ///      during recovery (through recurrent immature redemption).
    ///      https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 public constant TRANCHE_DUST_AMT = 10000000;

    //--------------------------------------------------------------------------
    // ASSETS
    //
    // The vault's assets are represented by a master list of ERC-20 tokens
    //      => { [underlying] U _deployed }
    //
    //
    /// @notice The ERC20 token that can be deposited into this vault.
    IERC20Upgradeable public underlying;

    /// @dev The set of the intermediate ERC-20 tokens when the underlying asset has been put to use.
    ///      In the case of this vault, they represent the tranche tokens held before maturity.
    EnumerableSetUpgradeable.AddressSet private _deployed;

    //-------------------------------------------------------------------------
    // Parameters

    /// @notice Minimum amount of underlying assets that must be deployed, for a deploy operation to succeed.
    /// @dev The deployment transaction reverts, if the vaults does not have sufficient underlying tokens
    ///      to cover the minimum deployment amount.
    uint256 public minDeploymentAmt;

    /// @notice The perpetual token on which rollovers are performed.
    IPerpetualTranche public perp;

    //--------------------------------------------------------------------------
    // v2.0.0 STORAGE ADDITION

    /// @notice External contract that orchestrates fees across the spot protocol.
    IFeePolicy public feePolicy;

    /// @notice Reference to the address that has the ability to pause/unpause operations.
    /// @dev The keeper is meant for time-sensitive operations, and may be different from the owner address.
    /// @return The address of the keeper.
    address public keeper;

    //--------------------------------------------------------------------------
    // The reserved liquidity is the subset of the vault's underlying tokens that it
    // does not deploy for rolling over (or used for swaps) and simply holds.
    // The existence of sufficient reserved liquidity ensures that
    // a) The vault's TVL never goes too low and guards against the "share" manipulation attack.
    // b) Not all of the vault's liquidity is locked up in tranches.

    /// @notice The absolute amount of underlying tokens, reserved.
    /// @custom:oz-upgrades-renamed-from minUnderlyingBal
    uint256 public reservedUnderlyingBal;

    /// @notice The amount of underlying tokens as percentage of the vault's TVL, reserved.
    /// @custom:oz-upgrades-renamed-from reservedSubscriptionPerc
    uint256 public reservedUnderlyingPerc;

    //--------------------------------------------------------------------------
    // v3.0.0 STORAGE ADDITION

    /// @notice Recorded timestamp of the last successful rebalance.
    uint256 public lastRebalanceTimestampSec;

    //--------------------------------------------------------------------------
    // Modifiers

    /// @dev Throws if called by any account other than the keeper.
    modifier onlyKeeper() {
        if (msg.sender != keeper) {
            revert UnauthorizedCall();
        }
        _;
    }

    //--------------------------------------------------------------------------
    // Construction & Initialization

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Contract state initialization.
    /// @param name ERC-20 Name of the vault token.
    /// @param symbol ERC-20 Symbol of the vault token.
    /// @param perp_ ERC-20 address of the perpetual tranche rolled over.
    /// @param feePolicy_ Address of the fee policy contract.
    function init(
        string memory name,
        string memory symbol,
        IPerpetualTranche perp_,
        IFeePolicy feePolicy_
    ) external initializer {
        // initialize dependencies
        __ERC20_init(name, symbol);
        __ERC20Burnable_init();
        __Ownable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        // setup underlying collateral
        underlying = perp_.underlying();

        // set reference to perp
        perp = perp_;

        // set the reference to the fee policy
        updateFeePolicy(feePolicy_);

        // set keeper reference
        updateKeeper(owner());

        // setting initial parameter values
        minDeploymentAmt = 0;
        reservedUnderlyingBal = 0;
        reservedUnderlyingPerc = 0;
        lastRebalanceTimestampSec = block.timestamp;

        // sync underlying
        _syncAsset(underlying);
    }

    //--------------------------------------------------------------------------
    // Owner only methods

    /// @notice Update the reference to the fee policy contract.
    /// @param feePolicy_ New strategy address.
    function updateFeePolicy(IFeePolicy feePolicy_) public onlyOwner {
        if (feePolicy_.decimals() != PERC_DECIMALS) {
            revert UnexpectedDecimals();
        }
        feePolicy = feePolicy_;
    }

    /// @notice Transfers a non-vault token out of the contract, which may have been added accidentally.
    /// @param token The token address.
    /// @param to The destination address.
    /// @param amount The amount of tokens to be transferred.
    function transferERC20(IERC20Upgradeable token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (isVaultAsset(token)) {
            revert UnauthorizedTransferOut();
        }
        token.safeTransfer(to, amount);
    }

    /// @notice Updates the reference to the keeper.
    /// @param keeper_ The address of the new keeper.
    function updateKeeper(address keeper_) public onlyOwner {
        keeper = keeper_;
    }

    //--------------------------------------------------------------------------
    // Keeper only methods

    /// @notice Pauses deposits, withdrawals and vault operations.
    /// @dev NOTE: ERC-20 functions, like transfers will always remain operational.
    function pause() external onlyKeeper {
        _pause();
    }

    /// @notice Unpauses deposits, withdrawals and vault operations.
    /// @dev NOTE: ERC-20 functions, like transfers will always remain operational.
    function unpause() external onlyKeeper {
        _unpause();
    }

    /// @notice Pauses the rebalance operation.
    function pauseRebalance() external onlyKeeper {
        lastRebalanceTimestampSec = type(uint64).max;
    }

    /// @notice Unpauses the rebalance operation.
    function unpauseRebalance() external onlyKeeper {
        lastRebalanceTimestampSec = block.timestamp;
    }

    /// @notice Updates the vault's minimum liquidity requirements.
    /// @param minDeploymentAmt_ The new minimum deployment amount, denominated in underlying tokens.
    /// @param reservedUnderlyingBal_ The new reserved underlying balance.
    /// @param reservedUnderlyingPerc_ The new reserved subscription percentage.
    function updateLiquidityLimits(
        uint256 minDeploymentAmt_,
        uint256 reservedUnderlyingBal_,
        uint256 reservedUnderlyingPerc_
    ) external onlyKeeper {
        minDeploymentAmt = minDeploymentAmt_;
        reservedUnderlyingBal = reservedUnderlyingBal_;
        reservedUnderlyingPerc = reservedUnderlyingPerc_;
    }

    //--------------------------------------------------------------------------
    // External & Public write methods

    /// @inheritdoc IRolloverVault
    function rebalance() external override nonReentrant whenNotPaused {
        if (block.timestamp <= lastRebalanceTimestampSec + feePolicy.rebalanceFreqSec()) {
            revert LastRebalanceTooRecent();
        }
        _rebalance(perp, underlying);
        lastRebalanceTimestampSec = block.timestamp;
    }

    /// @inheritdoc IVault
    /// @dev Simply batches the `recover` and `deploy` functions. Reverts if there are no funds to deploy.
    function recoverAndRedeploy() external override {
        recover();
        deploy();
    }

    /// @inheritdoc IVault
    /// @dev Its safer to call `recover` before `deploy` so the full available balance can be deployed.
    ///      The vault holds the reserved balance of underlying tokens and deploys the rest.
    ///      Reverts if no funds are rolled over or enforced deployment threshold is not reached.
    function deploy() public override nonReentrant whenNotPaused {
        IERC20Upgradeable underlying_ = underlying;
        IPerpetualTranche perp_ = perp;

        // We calculate the usable underlying balance.
        uint256 underlyingBal = underlying_.balanceOf(address(this));
        uint256 reservedBal = _totalReservedBalance(getTVL());
        uint256 usableBal = (underlyingBal > reservedBal) ? underlyingBal - reservedBal : 0;

        // We ensure that at-least `minDeploymentAmt` amount of underlying tokens are deployed
        // (i.e used productively for rollovers).
        if (usableBal <= minDeploymentAmt) {
            revert InsufficientDeployment();
        }

        // We tranche all the underlying held by the vault to create seniors and juniors
        _tranche(perp_.getDepositBond(), underlying_, usableBal);

        // Newly minted seniors are rolled into perp
        if (!_rollover(perp_, underlying_)) {
            revert InsufficientDeployment();
        }

        // sync underlying
        _syncAsset(underlying);
    }

    /// @inheritdoc IVault
    function recover() public override nonReentrant whenNotPaused {
        // Redeem deployed tranches
        uint8 deployedCount_ = uint8(_deployed.length());
        for (uint8 i = 0; i < deployedCount_; ++i) {
            ITranche tranche = ITranche(_deployed.at(i));
            uint256 trancheBalance = tranche.balanceOf(address(this));

            // if the vault has no tranche balance,
            // we continue to the next one.
            if (trancheBalance <= 0) {
                continue;
            }

            // get the parent bond
            IBondController bond = IBondController(tranche.bond());
            BondTranches memory bt = bond.getTranches();

            // if bond has matured, redeem the tranche token
            if (bond.secondsToMaturity() <= 0) {
                // execute redemption
                TrancheManager.execMatureTrancheRedemption(bond, tranche, trancheBalance);
            }
            // if not redeem using proportional balances
            // redeems this tranche and it's siblings if the vault holds balances.
            // NOTE: For gas optimization, we perform this operation only once
            // i.e) when we encounter the most-senior tranche.
            // We also skip if the tranche balance is too low as immature redemption will be a no-op.
            else if (tranche == bt.tranches[0] && trancheBalance > TRANCHE_DUST_AMT) {
                // execute redemption
                TrancheManager.execImmatureTrancheRedemption(bond, bt);
            }
        }

        // sync deployed tranches
        // NOTE: We traverse the deployed set in the reverse order
        //       as deletions involve swapping the deleted element to the
        //       end of the set and removing the last element.
        for (uint8 i = deployedCount_; i > 0; i--) {
            _syncDeployedAsset(IERC20Upgradeable(_deployed.at(i - 1)));
        }

        // sync underlying
        _syncAsset(underlying);
    }

    /// @inheritdoc IVault
    function recover(IERC20Upgradeable token) public override nonReentrant whenNotPaused {
        if (_deployed.contains(address(token))) {
            _redeemTranche(ITranche(address(token)));
            _syncAsset(underlying);
            return;
        }

        IPerpetualTranche perp_ = perp;
        if (address(token) == address(perp_)) {
            _meldPerps(perp_);
            _syncAsset(perp_);
            _syncAsset(underlying);
            return;
        }

        revert UnexpectedAsset();
    }

    /// @inheritdoc IRolloverVault
    /// @dev This operation pushes the system back into balance, we thus charge no fees.
    function mint2(
        uint256 underlyingAmtIn
    ) external override nonReentrant whenNotPaused returns (uint256 perpAmt, uint256 vaultNoteAmt) {
        IPerpetualTranche perp_ = perp;
        IERC20Upgradeable underlying_ = underlying;

        // Compute perp vault asset split.
        SystemTVL memory s = _querySystemTVL(perp_);
        uint256 underlyingAmtIntoPerp = underlyingAmtIn.mulDiv(ONE, ONE + feePolicy.targetSystemRatio());
        uint256 underlyingAmtIntoVault = underlyingAmtIn - underlyingAmtIntoPerp;

        // Compute perp amount and vault note amount to mint
        perpAmt = underlyingAmtIntoPerp.mulDiv(perp_.totalSupply(), s.perpTVL);
        vaultNoteAmt = computeMintAmt(underlyingAmtIntoVault, 0);

        // Transfer underlying tokens from user
        underlying_.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // Mint perps to user
        _trancheAndMintPerps(perp_, underlying_, s.perpTVL, perp_.getDepositTrancheRatio(), perpAmt);
        IERC20Upgradeable(address(perp_)).safeTransfer(msg.sender, perpAmt);

        // Mint vault notes to user
        _mint(msg.sender, vaultNoteAmt);

        // Sync underlying
        _syncAsset(underlying_);
    }

    /// @inheritdoc IRolloverVault
    /// @dev This operation maintains the system's balance, we thus charge no fees.
    function redeem2(
        uint256 perpAmtAvailable,
        uint256 vaultNoteAmtAvailable
    )
        external
        override
        nonReentrant
        whenNotPaused
        returns (uint256 perpAmt, uint256 vaultNoteAmt, TokenAmount[] memory returnedTokens)
    {
        IPerpetualTranche perp_ = perp;

        // Compute perp vault split
        {
            uint256 perpSupply = perp_.totalSupply();
            uint256 vaultNoteSupply = totalSupply();
            perpAmt = perpAmtAvailable;
            vaultNoteAmt = vaultNoteSupply.mulDiv(perpAmtAvailable, perpSupply);
            if (vaultNoteAmt > vaultNoteAmtAvailable) {
                vaultNoteAmt = vaultNoteAmtAvailable;
                perpAmt = perpSupply.mulDiv(vaultNoteAmtAvailable, vaultNoteSupply);
            }
        }

        // Redeem vault notes
        TokenAmount[] memory vaultTokens = computeRedemptionAmts(vaultNoteAmt, 0);
        _burn(msg.sender, vaultNoteAmt);

        // Transfer perps from user and redeem
        IERC20Upgradeable(address(perp_)).safeTransferFrom(msg.sender, address(this), perpAmt);
        TokenAmount[] memory perpTokens = perp.redeem(perpAmt);

        // Compute final list of tokens to return to the user
        // assert(underlying == perpTokens[0].token && underlying == vaultTokens[0].token);
        returnedTokens = new TokenAmount[](perpTokens.length + vaultTokens.length - 1);
        returnedTokens[0] = TokenAmount({
            token: perpTokens[0].token,
            amount: (perpTokens[0].amount + vaultTokens[0].amount)
        });
        returnedTokens[0].token.safeTransfer(msg.sender, returnedTokens[0].amount);

        // perp tokens
        for (uint8 i = 1; i < uint8(perpTokens.length); i++) {
            returnedTokens[i] = perpTokens[i];
            perpTokens[i].token.safeTransfer(msg.sender, returnedTokens[i].amount);
        }

        // vault tokens
        for (uint8 i = 1; i < uint8(vaultTokens.length); i++) {
            returnedTokens[i - 1 + perpTokens.length] = vaultTokens[i];
            vaultTokens[i].token.safeTransfer(msg.sender, vaultTokens[i].amount);

            // sync balances
            _syncDeployedAsset(vaultTokens[i].token);
        }

        // sync underlying
        _syncAsset(returnedTokens[0].token);
    }

    /// @inheritdoc IVault
    function deposit(uint256 underlyingAmtIn) external override nonReentrant whenNotPaused returns (uint256) {
        // Compute the mint fees
        SystemTVL memory s = _querySystemTVL(perp);
        uint256 feePerc = feePolicy.computeFeePerc(
            feePolicy.computeDeviationRatio(s),
            feePolicy.computeDeviationRatio(SystemTVL({ perpTVL: s.perpTVL, vaultTVL: s.vaultTVL + underlyingAmtIn }))
        );

        // Calculates the fee adjusted amount of vault notes minted when depositing `underlyingAmtIn` of underlying tokens.
        // NOTE: This operation should precede any token transfers.
        uint256 vaultNoteAmt = computeMintAmt(underlyingAmtIn, feePerc);
        if (underlyingAmtIn <= 0 || vaultNoteAmt <= 0) {
            return 0;
        }

        // transfer user assets in
        underlying.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // mint vault notes
        _mint(msg.sender, vaultNoteAmt);

        // sync underlying
        _syncAsset(underlying);
        return vaultNoteAmt;
    }

    /// @inheritdoc IVault
    function redeem(uint256 vaultNoteAmt) public override nonReentrant whenNotPaused returns (TokenAmount[] memory) {
        if (vaultNoteAmt <= 0) {
            return new TokenAmount[](0);
        }

        // Compute the redemption fees
        SystemTVL memory s = _querySystemTVL(perp);
        uint256 vaultNoteSupply = totalSupply();
        uint256 feePerc = feePolicy.computeFeePerc(
            feePolicy.computeDeviationRatio(s),
            feePolicy.computeDeviationRatio(
                SystemTVL({
                    perpTVL: s.perpTVL,
                    vaultTVL: s.vaultTVL.mulDiv(vaultNoteSupply - vaultNoteAmt, vaultNoteSupply)
                })
            )
        );

        // Calculates the fee adjusted share of vault tokens to be redeemed
        // NOTE: This operation should precede any token transfers.
        TokenAmount[] memory redemptions = computeRedemptionAmts(vaultNoteAmt, feePerc);

        // burn vault notes
        _burn(msg.sender, vaultNoteAmt);

        // transfer assets out
        uint8 redemptionsCount = uint8(redemptions.length);
        for (uint8 i = 0; i < redemptionsCount; ++i) {
            if (redemptions[i].amount == 0) {
                continue;
            }

            // Transfer token share out
            redemptions[i].token.safeTransfer(msg.sender, redemptions[i].amount);

            // sync balances, wkt i=0 is the underlying and remaining are tranches
            if (i == 0) {
                _syncAsset(redemptions[i].token);
            } else {
                _syncDeployedAsset(redemptions[i].token);
            }
        }
        return redemptions;
    }

    /// @inheritdoc IRolloverVault
    /// @dev Callers should call `recover` before executing `swapUnderlyingForPerps` to maximize vault liquidity.
    function swapUnderlyingForPerps(uint256 underlyingAmtIn) external nonReentrant whenNotPaused returns (uint256) {
        // Calculates the fee adjusted perp amount to transfer to the user.
        // NOTE: This operation should precede any token transfers.
        IPerpetualTranche perp_ = perp;
        IERC20Upgradeable underlying_ = underlying;
        uint256 underlyingBalPre = underlying_.balanceOf(address(this));
        (uint256 perpAmtOut, , SystemTVL memory s) = computeUnderlyingToPerpSwapAmt(underlyingAmtIn);

        // Revert if insufficient tokens are swapped in or out
        if (perpAmtOut <= 0 || underlyingAmtIn <= 0) {
            revert UnacceptableSwap();
        }

        // transfer underlying in
        underlying_.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // tranche and mint perps as needed
        _trancheAndMintPerps(perp_, underlying_, s.perpTVL, perp_.getDepositTrancheRatio(), perpAmtOut);

        // transfer remaining perps out to the user
        IERC20Upgradeable(address(perp_)).safeTransfer(msg.sender, perpAmtOut);

        // NOTE: In case this operation mints slightly more perps than that are required for the swap,
        // The vault continues to hold the perp dust until the subsequent `swapPerpsForUnderlying` or manual `recover(perp)`.

        // We ensure that the vault's underlying token liquidity
        // remains above the reserved level after swap.
        uint256 underlyingBalPost = underlying_.balanceOf(address(this));
        if ((underlyingBalPost < underlyingBalPre) && (underlyingBalPost <= _totalReservedBalance(s.vaultTVL))) {
            revert InsufficientLiquidity();
        }

        // sync underlying
        _syncAsset(underlying_);

        return perpAmtOut;
    }

    /// @inheritdoc IRolloverVault
    function swapPerpsForUnderlying(uint256 perpAmtIn) external nonReentrant whenNotPaused returns (uint256) {
        // Calculates the fee adjusted underlying amount to transfer to the user.
        IPerpetualTranche perp_ = perp;
        IERC20Upgradeable underlying_ = underlying;
        uint256 underlyingBalPre = underlying_.balanceOf(address(this));
        (uint256 underlyingAmtOut, , ) = computePerpToUnderlyingSwapAmt(perpAmtIn);

        // Revert if insufficient tokens are swapped in or out
        if (underlyingAmtOut <= 0 || perpAmtIn <= 0) {
            revert UnacceptableSwap();
        }

        // transfer perps in
        IERC20Upgradeable(perp_).safeTransferFrom(msg.sender, address(this), perpAmtIn);

        // Meld incoming perps
        _meldPerps(perp_);

        // transfer underlying out
        underlying_.safeTransfer(msg.sender, underlyingAmtOut);

        // Revert if swap reduces vault's available liquidity.
        uint256 underlyingBalPost = underlying_.balanceOf(address(this));
        if (underlyingBalPost < underlyingBalPre) {
            revert InsufficientLiquidity();
        }

        // sync underlying
        _syncAsset(underlying_);

        return underlyingAmtOut;
    }

    //--------------------------------------------------------------------------
    // External & Public compute methods

    /// @inheritdoc IRolloverVault
    function deviationRatio() external override nonReentrant returns (uint256) {
        return feePolicy.computeDeviationRatio(_querySystemTVL(perp));
    }

    /// @inheritdoc IRolloverVault
    function computeUnderlyingToPerpSwapAmt(
        uint256 underlyingAmtIn
    ) public returns (uint256, uint256, SystemTVL memory) {
        IPerpetualTranche perp_ = perp;
        // Compute equal value perps to swap out to the user
        SystemTVL memory s = _querySystemTVL(perp_);
        uint256 perpAmtOut = underlyingAmtIn.mulDiv(perp_.totalSupply(), s.perpTVL);

        //-----------------------------------------------------------------------------
        // When user swaps underlying for vault's perps -> perps are minted by the vault
        // We thus compute fees based on the post-mint system tvl.
        uint256 feePerc = feePolicy.computeFeePerc(
            feePolicy.computeDeviationRatio(s),
            feePolicy.computeDeviationRatio(SystemTVL({ perpTVL: s.perpTVL + underlyingAmtIn, vaultTVL: s.vaultTVL }))
        );
        //-----------------------------------------------------------------------------

        // We deduct fees by transferring out fewer perp tokens
        perpAmtOut = perpAmtOut.mulDiv(ONE - feePerc, ONE);

        return (perpAmtOut, 0, s);
    }

    /// @inheritdoc IRolloverVault
    function computePerpToUnderlyingSwapAmt(uint256 perpAmtIn) public returns (uint256, uint256, SystemTVL memory) {
        IPerpetualTranche perp_ = perp;
        // Compute equal value underlying tokens to swap out
        SystemTVL memory s = _querySystemTVL(perp_);
        uint256 underlyingAmtOut = perpAmtIn.mulDiv(s.perpTVL, perp_.totalSupply());

        //-----------------------------------------------------------------------------
        // When user swaps perps for vault's underlying -> perps are redeemed by the vault
        // We thus compute fees based on the post-burn system tvl.
        uint256 feePerc = feePolicy.computeFeePerc(
            feePolicy.computeDeviationRatio(s),
            feePolicy.computeDeviationRatio(SystemTVL({ perpTVL: s.perpTVL - underlyingAmtOut, vaultTVL: s.vaultTVL }))
        );
        //-----------------------------------------------------------------------------

        // We deduct fees by transferring out fewer underlying tokens
        underlyingAmtOut = underlyingAmtOut.mulDiv(ONE - feePerc, ONE);

        return (underlyingAmtOut, 0, s);
    }

    //--------------------------------------------------------------------------
    // External & Public read methods

    /// @notice Computes the amount of vault notes minted when given amount of underlying asset tokens
    ///         are deposited into the system.
    /// @param underlyingAmtIn The amount underlying tokens to be deposited into the vault.
    /// @param feePerc The percentage of minted vault notes paid as fees.
    /// @return vaultNoteAmtMint The amount of vault notes to be minted.
    function computeMintAmt(uint256 underlyingAmtIn, uint256 feePerc) public view returns (uint256 vaultNoteAmtMint) {
        uint256 vaultNoteSupply = totalSupply();

        //-----------------------------------------------------------------------------
        // Compute mint amt
        vaultNoteAmtMint = (vaultNoteSupply > 0)
            ? vaultNoteSupply.mulDiv(underlyingAmtIn, getTVL())
            : (underlyingAmtIn * INITIAL_RATE);

        // The mint fees are settled by simply minting fewer vault notes.
        vaultNoteAmtMint = vaultNoteAmtMint.mulDiv(ONE - feePerc, ONE);
    }

    /// @notice Computes the amount of asset tokens returned for redeeming vault notes.
    /// @param vaultNoteAmtRedeemed The amount of vault notes to be redeemed.
    /// @param feePerc The percentage of redeemed vault notes paid as fees.
    /// @return returnedTokens The list of asset tokens and amounts returned.
    function computeRedemptionAmts(
        uint256 vaultNoteAmtRedeemed,
        uint256 feePerc
    ) public view returns (TokenAmount[] memory returnedTokens) {
        uint256 vaultNoteSupply = totalSupply();

        //-----------------------------------------------------------------------------
        uint8 assetCount_ = 1 + uint8(_deployed.length());

        // aggregating vault assets to be redeemed
        returnedTokens = new TokenAmount[](assetCount_);

        // underlying share to be redeemed
        IERC20Upgradeable underlying_ = underlying;
        returnedTokens[0] = TokenAmount({
            token: underlying_,
            amount: underlying_.balanceOf(address(this)).mulDiv(vaultNoteAmtRedeemed, vaultNoteSupply)
        });
        returnedTokens[0].amount = returnedTokens[0].amount.mulDiv(ONE - feePerc, ONE);

        for (uint8 i = 1; i < assetCount_; ++i) {
            // tranche token share to be redeemed
            IERC20Upgradeable token = IERC20Upgradeable(_deployed.at(i - 1));
            returnedTokens[i] = TokenAmount({
                token: token,
                amount: token.balanceOf(address(this)).mulDiv(vaultNoteAmtRedeemed, vaultNoteSupply)
            });

            // deduct redemption fee
            returnedTokens[i].amount = returnedTokens[i].amount.mulDiv(ONE - feePerc, ONE);

            // in case the redemption amount is just dust, we skip
            if (returnedTokens[i].amount < TRANCHE_DUST_AMT) {
                returnedTokens[i].amount = 0;
            }
        }
    }

    /// @inheritdoc IVault
    /// @dev The total value is denominated in the underlying asset.
    function getTVL() public view override returns (uint256) {
        // The underlying balance
        uint256 totalValue = underlying.balanceOf(address(this));

        // The deployed asset value denominated in the underlying
        uint8 deployedCount_ = uint8(_deployed.length());
        for (uint8 i = 0; i < deployedCount_; ++i) {
            ITranche tranche = ITranche(_deployed.at(i));
            uint256 balance = tranche.balanceOf(address(this));
            if (balance > TRANCHE_DUST_AMT) {
                totalValue += TrancheManager.computeTrancheValue(address(tranche), address(underlying), balance);
            }
        }

        return totalValue;
    }

    /// @inheritdoc IVault
    /// @dev The asset value is denominated in the underlying asset.
    function getVaultAssetValue(IERC20Upgradeable token) external view override returns (uint256) {
        uint256 balance = token.balanceOf(address(this));

        // Underlying asset
        if (token == underlying) {
            return balance;
        }
        // Deployed asset
        else if (_deployed.contains(address(token))) {
            ITranche tranche = ITranche(address(token));
            return
                (balance > TRANCHE_DUST_AMT)
                    ? TrancheManager.computeTrancheValue(address(tranche), address(underlying), balance)
                    : 0;
        }

        // Not a vault asset, so returning zero
        return 0;
    }

    /// @inheritdoc IVault
    function assetCount() external view override returns (uint256) {
        return _deployed.length() + 1;
    }

    /// @inheritdoc IVault
    function assetAt(uint256 i) external view override returns (IERC20Upgradeable) {
        if (i == 0) {
            return underlying;
        } else if (i <= _deployed.length()) {
            return IERC20Upgradeable(_deployed.at(i - 1));
        }
        revert OutOfBounds();
    }

    /// @inheritdoc IVault
    function vaultAssetBalance(IERC20Upgradeable token) external view override returns (uint256) {
        return isVaultAsset(token) ? token.balanceOf(address(this)) : 0;
    }

    /// @inheritdoc IVault
    function isVaultAsset(IERC20Upgradeable token) public view override returns (bool) {
        return token == underlying || _deployed.contains(address(token));
    }

    //--------------------------------------------------------------------------
    // Private write methods

    /// @dev Executes a system-level rebalance. This operation transfers value between
    ///      the perp reserve and the vault such that the system moves toward balance.
    ///      Performs some book-keeping to keep track of the vault and perp's assets.
    function _rebalance(IPerpetualTranche perp_, IERC20Upgradeable underlying_) private {
        // Claim mint/burn fees collected by perp.
        perp_.claimFees(address(this));
        _meldPerps(perp_);

        SystemTVL memory s = _querySystemTVL(perp_);
        int256 underlyingAmtIntoPerp = feePolicy.computeRebalanceAmount(s);

        // When value is flowing into perp from the vault.
        // We rebalance from perp to the vault.
        if (underlyingAmtIntoPerp < 0) {
            perp_.rebalanceToVault(underlyingAmtIntoPerp.abs());
            _meldPerps(perp_); // Meld residual perps, if any.
        }
        // When value is flowing from the vault to perp.
        // We rebalance from the vault to perp.
        else if (underlyingAmtIntoPerp > 0) {
            // We transfer value by minting the perp tokens (after making required deposit)
            // and then simply burning the newly minted perp tokens.
            uint256 perpAmtToTransfer = (underlyingAmtIntoPerp.toUint256()).mulDiv(perp_.totalSupply(), s.perpTVL);
            _trancheAndMintPerps(perp_, underlying_, s.perpTVL, perp_.getDepositTrancheRatio(), perpAmtToTransfer);
            IERC20Burnable(address(perp_)).burn(perpAmtToTransfer);
        }

        // We pay the protocol fee on every rebalance.
        {
            uint256 protocolSharePerc = feePolicy.protocolSharePerc();
            if (protocolSharePerc > 0) {
                address collector = feePolicy.protocolFeeCollector();
                perp.payProtocolFee(collector, protocolSharePerc);
                _mint(collector, protocolSharePerc.mulDiv(totalSupply(), ONE - protocolSharePerc));
            }
        }

        // Sync token balances.
        _syncAsset(perp_);
        _syncAsset(underlying_);
    }

    /// @dev Redeems tranche tokens held by the vault, for underlying.
    ///      In the case of immature redemption, this method will recover other sibling tranches as well.
    ///      Performs some book-keeping to keep track of the vault's assets.
    function _redeemTranche(ITranche tranche) private {
        uint256 trancheBalance = tranche.balanceOf(address(this));

        // if the vault has no tranche balance,
        // we update our internal book-keeping and return.
        if (trancheBalance <= 0) {
            _syncDeployedAsset(tranche);
            return;
        }

        // get the parent bond
        IBondController bond = IBondController(tranche.bond());

        // if bond has matured, redeem the tranche token
        if (bond.secondsToMaturity() <= 0) {
            // execute redemption
            TrancheManager.execMatureTrancheRedemption(bond, tranche, trancheBalance);

            // sync deployed asset
            _syncDeployedAsset(tranche);
        }
        // if not redeem using proportional balances
        // redeems this tranche and it's siblings if the vault holds balances.
        // We skip if the tranche balance is too low as immature redemption will be a no-op.
        else if (trancheBalance > TRANCHE_DUST_AMT) {
            // execute redemption
            BondTranches memory bt = bond.getTranches();
            TrancheManager.execImmatureTrancheRedemption(bond, bt);

            // sync deployed asset, i.e) current tranche and its sibling.
            _syncDeployedAsset(bt.tranches[0]);
            _syncDeployedAsset(bt.tranches[1]);
        } else {
            _syncDeployedAsset(tranche);
        }
    }

    /// @dev Redeems perp tokens held by the vault for tranches and
    ///      melds them with existing tranches to redeem more underlying tokens.
    ///      Performs some book-keeping to keep track of the vault's assets.
    function _meldPerps(IPerpetualTranche perp_) private {
        uint256 perpBalance = perp_.balanceOf(address(this));
        if (perpBalance <= 0) {
            return;
        }

        TokenAmount[] memory tranchesRedeemed = perp_.redeem(perpBalance);

        // sync and meld perp's tranches
        uint8 tranchesRedeemedCount = uint8(tranchesRedeemed.length);
        for (uint8 i = 1; i < tranchesRedeemedCount; ++i) {
            ITranche tranche = ITranche(address(tranchesRedeemed[i].token));

            // if possible, meld redeemed tranche with
            // existing tranches to redeem underlying.
            _redeemTranche(tranche);
        }
    }

    /// @dev Tranches the vault's underlying to mint perps.
    ///      Performs some book-keeping to keep track of the vault's assets.
    function _trancheAndMintPerps(
        IPerpetualTranche perp_,
        IERC20Upgradeable underlying_,
        uint256 perpTVL,
        uint256 depositTrancheTR,
        uint256 perpAmtToMint
    ) private {
        // Tranche as needed
        IBondController depositBond = perp_.getDepositBond();
        ITranche trancheIntoPerp = perp_.getDepositTranche();
        (uint256 underylingAmtToTranche, uint256 seniorAmtToDeposit) = PerpHelpers.estimateUnderlyingAmtToTranche(
            PerpHelpers.MintEstimationParams({
                perpTVL: perpTVL,
                perpSupply: perp_.totalSupply(),
                depositBondCollateralBalance: underlying_.balanceOf(address(depositBond)),
                depositBondTotalDebt: depositBond.totalDebt(),
                depositTrancheSupply: trancheIntoPerp.totalSupply(),
                depositTrancheTR: depositTrancheTR
            }),
            perpAmtToMint
        );
        _tranche(depositBond, underlying_, underylingAmtToTranche);

        // Mint perps
        IERC20Upgradeable(trancheIntoPerp).checkAndApproveMax(address(perp_), seniorAmtToDeposit);
        perp_.deposit(trancheIntoPerp, seniorAmtToDeposit);

        // sync holdings
        _syncDeployedAsset(trancheIntoPerp);
    }

    /// @dev Rolls over freshly tranched tokens from the given bond for older tranches (close to maturity) from perp.
    ///      Redeems intermediate tranches for underlying if possible.
    ///      Performs some book-keeping to keep track of the vault's assets.
    /// @return Flag indicating if any tokens were rolled over.
    function _rollover(IPerpetualTranche perp_, IERC20Upgradeable underlying_) private returns (bool) {
        // NOTE: The first element of the list is the mature tranche,
        //       there after the list is NOT ordered by maturity.
        IERC20Upgradeable[] memory rolloverTokens = perp_.getReserveTokensUpForRollover();

        // Batch rollover
        bool rollover = false;

        // We query perp's current deposit tranche
        ITranche trancheIntoPerp = perp_.getDepositTranche();

        // Compute available tranche in to rollover
        uint256 trancheInAmtAvailable = trancheIntoPerp.balanceOf(address(this));

        // Approve once for all rollovers
        IERC20Upgradeable(trancheIntoPerp).checkAndApproveMax(address(perp_), trancheInAmtAvailable);

        // We pair the senior tranche token held by the vault (from the deposit bond)
        // with each of the perp's tokens available for rollovers and execute a rollover.
        // We continue to rollover till either the vault's senior tranche balance is exhausted or
        // there are no more tokens in perp available to be rolled-over.
        uint8 rolloverTokensCount = uint8(rolloverTokens.length);
        for (uint8 i = 0; (i < rolloverTokensCount && trancheInAmtAvailable > 0); ++i) {
            // tokenOutOfPerp is the reserve token coming out of perp into the vault
            IERC20Upgradeable tokenOutOfPerp = rolloverTokens[i];

            // Perform rollover
            RolloverData memory r = perp_.rollover(trancheIntoPerp, tokenOutOfPerp, trancheInAmtAvailable);

            // no rollover occurred, skip updating balances
            if (r.tokenOutAmt <= 0) {
                continue;
            }

            // skip insertion into the deployed list the case of the mature tranche, ie underlying
            if (rolloverTokens[i] != underlying_) {
                // Clean up after rollover, merge seniors from perp
                // with vault held juniors to recover more underlying.
                _redeemTranche(ITranche(address(tokenOutOfPerp)));
            }

            // Calculate trancheIn available amount
            trancheInAmtAvailable -= r.trancheInAmt;

            // keep track if "at least" one rolled over operation occurred
            rollover = true;
        }

        // Final cleanup, if there remain excess seniors we recover back to underlying.
        _redeemTranche(trancheIntoPerp);

        return (rollover);
    }

    /// @dev Given a bond, deposits the provided amount into the bond
    ///      and receives tranche tokens in return.
    ///      Performs some book-keeping to keep track of the vault's assets.
    function _tranche(IBondController bond, IERC20Upgradeable underlying_, uint256 underlyingAmt) private {
        // Tranche
        ITranche[2] memory t = bond.approveAndDeposit(underlying_, underlyingAmt);

        // sync holdings
        _syncDeployedAsset(t[0]);
        _syncDeployedAsset(t[1]);
    }

    /// @dev Syncs balance and updates the deployed list based on the vault's token balance.
    function _syncDeployedAsset(IERC20Upgradeable token) private {
        uint256 balance = _syncAsset(token);

        bool inVault = _deployed.contains(address(token));
        if (balance > 0 && !inVault) {
            // Inserts new token into the deployed assets list.
            _deployed.add(address(token));
            if (_deployed.length() > MAX_DEPLOYED_COUNT) {
                revert DeployedCountOverLimit();
            }
        } else if (balance <= 0 && inVault) {
            // Removes token into the deployed assets list.
            _deployed.remove(address(token));
        }
    }

    /// @dev Logs the token balance held by the vault.
    function _syncAsset(IERC20Upgradeable token) private returns (uint256 balance) {
        balance = token.balanceOf(address(this));
        emit AssetSynced(token, balance);
    }

    /// @dev Queries the current TVL of the perp and vault systems.
    function _querySystemTVL(IPerpetualTranche perp_) private returns (SystemTVL memory) {
        return SystemTVL({ perpTVL: perp_.getTVL(), vaultTVL: getTVL() });
    }

    //--------------------------------------------------------------------------
    // Private view methods

    /// @dev Computes the balance of underlying tokens to NOT be used for any operation.
    function _totalReservedBalance(uint256 vaultTVL) private view returns (uint256) {
        return MathUpgradeable.max(reservedUnderlyingBal, vaultTVL.mulDiv(reservedUnderlyingPerc, ONE));
    }
}
