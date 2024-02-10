// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { IERC20MetadataUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";
import { IERC20Upgradeable, IPerpetualTranche, IBondController, ITranche, IFeePolicy } from "./_interfaces/IPerpetualTranche.sol";
import { IVault } from "./_interfaces/IVault.sol";
import { IRolloverVault } from "./_interfaces/IRolloverVault.sol";
import { IERC20Burnable } from "./_interfaces/IERC20Burnable.sol";
import { TokenAmount, RolloverData, SubscriptionParams } from "./_interfaces/CommonTypes.sol";
import { UnauthorizedCall, UnauthorizedTransferOut, UnacceptableReference, UnexpectedDecimals, UnexpectedAsset, UnacceptableDeposit, UnacceptableRedemption, OutOfBounds, TVLDecreased, UnacceptableSwap, InsufficientDeployment, DeployedCountOverLimit } from "./_interfaces/ProtocolErrors.sol";

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { ERC20BurnableUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { BondTranches, BondTranchesHelpers } from "./_utils/BondTranchesHelpers.sol";
import { TrancheHelpers } from "./_utils/TrancheHelpers.sol";
import { BondHelpers } from "./_utils/BondHelpers.sol";
import { PerpHelpers } from "./_utils/PerpHelpers.sol";

/*
 *  @title RolloverVault
 *
 *  @notice A vault which generates yield (from fees) by performing rollovers on PerpetualTranche (or perp).
 *          The vault takes in AMPL or any other rebasing collateral as the "underlying" asset.
 *
 *          Vault strategy:
 *              1) deploy: The vault deposits the underlying asset into perp's current deposit bond
 *                 to get tranche tokens in return, it then swaps these fresh tranche tokens for
 *                 older tranche tokens (ones mature or approaching maturity) from perp.
 *              2) recover: The vault redeems the tranches it holds for the underlying asset.
 *                 NOTE: It performs both mature and immature redemption. Read more: https://bit.ly/3tuN6OC
 *
 *          With v2.0, vault provides perp<>underlying swap liquidity and charges a fee.
 *          The swap fees are an additional source of yield for vault note holders.
 *
 * @dev When new tranches are added into the system, always double check if they are not malicious
 *      by only accepting one whitelisted by perp (ones part of perp's deposit bond or ones part of the perp reserve).
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

    // math
    using MathUpgradeable for uint256;

    //-------------------------------------------------------------------------
    // Events

    /// @notice Emits the vault asset's token balance that's recorded after a change.
    /// @param token Address of token.
    /// @param balance The recorded ERC-20 balance of the token.
    event AssetSynced(IERC20Upgradeable token, uint256 balance);

    //-------------------------------------------------------------------------
    // Constants
    // Number of decimals for a multiplier of 1.0x (i.e. 100%)
    uint8 public constant FEE_POLICY_DECIMALS = 8;
    uint256 public constant FEE_ONE = (10 ** FEE_POLICY_DECIMALS);

    /// @dev Initial exchange rate between the underlying asset and notes.
    uint256 private constant INITIAL_RATE = 10 ** 6;

    /// @dev The maximum number of deployed assets that can be held in this vault at any given time.
    uint256 public constant MAX_DEPLOYED_COUNT = 47;

    /// @dev The enforced minimum number of perp or underlying tokens (in floating point units)
    ///      that are required to be sent in during a swap.
    ///      MIN_SWAP_UNITS = 100, means at least 100.0 perp or underlying tokens need to be swapped in.
    uint256 public constant MIN_SWAP_UNITS = 100;

    /// @dev Immature redemption may result in some dust tranches when balances are not perfectly divisible by the tranche ratio.
    ///      Based on current the implementation of `computeRedeemableTrancheAmounts`,
    ///      the dust balances which remain after immature redemption will be at most {TRANCHE_RATIO_GRANULARITY} or 1000.
    ///      We exclude the vault's dust tranche balances from TVL computation, note redemption and
    ///      during recovery (through recurrent immature redemption).
    uint256 public constant TRANCHE_DUST_AMT = 1000;

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
    // Storage

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

    /// @notice The enforced minimum balance of underlying tokens to be held by the vault at all times.
    /// @dev On deployment only the delta greater than this balance is deployed.
    uint256 public minUnderlyingBal;

    //--------------------------------------------------------------------------
    // Modifiers

    /// @dev Throws if called by any account other than the keeper.
    modifier onlyKeeper() {
        if (_msgSender() != keeper) {
            revert UnauthorizedCall();
        }
        _;
    }

    //--------------------------------------------------------------------------
    // Construction & Initialization

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
    ) public initializer {
        // initialize dependencies
        __ERC20_init(name, symbol);
        __ERC20Burnable_init();
        __Ownable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        // set keeper reference
        keeper = owner();

        // setup underlying collateral
        underlying = perp_.underlying();
        _syncAsset(underlying);

        // set reference to perp
        perp = perp_;

        // set the reference to the fee policy
        updateFeePolicy(feePolicy_);

        // setting initial parameter values
        minDeploymentAmt = 0;
        minUnderlyingBal = 0;
    }

    //--------------------------------------------------------------------------
    // Owner only methods

    /// @notice Update the reference to the fee policy contract.
    /// @param feePolicy_ New strategy address.
    function updateFeePolicy(IFeePolicy feePolicy_) public onlyOwner {
        if (address(feePolicy_) == address(0)) {
            revert UnacceptableReference();
        }
        if (feePolicy_.decimals() != FEE_POLICY_DECIMALS) {
            revert UnexpectedDecimals();
        }
        feePolicy = feePolicy_;
    }

    /// @notice Updates the minimum deployment amount requirement.
    /// @param minDeploymentAmt_ The new minimum deployment amount, denominated in underlying tokens.
    function updateMinDeploymentAmt(uint256 minDeploymentAmt_) external onlyOwner {
        minDeploymentAmt = minDeploymentAmt_;
    }

    /// @notice Updates the minimum underlying balance requirement.
    /// @param minUnderlyingBal_ The new minimum underlying balance.
    function updateMinUnderlyingBal(uint256 minUnderlyingBal_) external onlyOwner {
        minUnderlyingBal = minUnderlyingBal_;
    }

    /// @notice Transfers a non-vault token out of the contract, which may have been added accidentally.
    /// @param token The token address.
    /// @param to The destination address.
    /// @param amount The amount of tokens to be transferred.
    function transferERC20(IERC20Upgradeable token, address to, uint256 amount) external onlyOwner {
        if (isVaultAsset(token)) {
            revert UnauthorizedTransferOut();
        }
        token.safeTransfer(to, amount);
    }

    /// @notice Updates the reference to the keeper.
    /// @param keeper_ The address of the new keeper.
    function updateKeeper(address keeper_) public virtual onlyOwner {
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

    //--------------------------------------------------------------------------
    // External & Public write methods

    /// @inheritdoc IVault
    /// @dev Simply batches the `recover` and `deploy` functions. Reverts if there are no funds to deploy.
    function recoverAndRedeploy() external override {
        recover();
        deploy();
    }

    /// @inheritdoc IVault
    /// @dev Its safer to call `recover` before `deploy` so the full available balance can be deployed.
    ///      The vault holds `minUnderlyingBal` as underlying tokens and deploys the rest.
    ///      Reverts if no funds are rolled over or enforced deployment threshold is not reached.
    function deploy() public override nonReentrant whenNotPaused {
        IERC20Upgradeable underlying_ = underlying;
        IPerpetualTranche perp_ = perp;

        // We first pay the protocol
        _deductProtocolFee(underlying_);

        // `minUnderlyingBal` worth of underlying liquidity is excluded from the usable balance
        uint256 usableBal = underlying_.balanceOf(address(this));
        if (usableBal <= minUnderlyingBal) {
            revert InsufficientDeployment();
        }

        // We ensure that at-least `minDeploymentAmt` amount of underlying tokens are deployed
        uint256 deployedAmt = usableBal - minUnderlyingBal;
        if (deployedAmt <= minDeploymentAmt) {
            revert InsufficientDeployment();
        }

        // We all the underlying held by the vault to create seniors and juniors
        _tranche(perp_.getDepositBond(), underlying_, deployedAmt);

        // Newly minted seniors are rolled into perp
        (bool rollover, ITranche trancheIntoPerp) = _rollover(perp_, underlying_);
        if (!rollover) {
            revert InsufficientDeployment();
        }

        // Cleanup rollover; In case that there remain excess seniors and juniors after a successful rollover,
        // we recover back to underlying.
        _redeemTranche(trancheIntoPerp);
    }

    /// @inheritdoc IVault
    function recover() public override nonReentrant whenNotPaused {
        // Redeem deployed tranches
        uint8 deployedCount_ = uint8(_deployed.length());
        if (deployedCount_ <= 0) {
            return;
        }

        // execute redemption on each deployed asset
        for (uint8 i = 0; i < deployedCount_; i++) {
            ITranche tranche = ITranche(_deployed.at(i));
            uint256 trancheBalance = tranche.balanceOf(address(this));

            // if the vault has no tranche balance,
            // we update our internal book-keeping and continue to the next one.
            if (trancheBalance <= 0) {
                continue;
            }

            // get the parent bond
            IBondController bond = IBondController(tranche.bond());
            BondTranches memory bt = bond.getTranches();

            // if bond has matured, redeem the tranche token
            if (bond.secondsToMaturity() <= 0) {
                // execute redemption
                _execMatureTrancheRedemption(bond, tranche, trancheBalance);
            }
            // if not redeem using proportional balances
            // redeems this tranche and it's siblings if the vault holds balances.
            // NOTE: For gas optimization, we perform this operation only once
            // i.e) when we encounter the most-senior tranche.
            // We also skip if the tranche balance is too low as immature redemption will be a no-op.
            else if (tranche == bt.tranches[0] && trancheBalance > TRANCHE_DUST_AMT) {
                // execute redemption
                _execImmatureTrancheRedemption(bond, bt);
            }
        }

        // sync deployed tranches
        // NOTE: We traverse the deployed set in the reverse order
        //       as deletions involve swapping the deleted element to the
        //       end of the set and removing the last element.
        for (uint8 i = deployedCount_; i > 0; i--) {
            _syncAndRemoveDeployedAsset(IERC20Upgradeable(_deployed.at(i - 1)));
        }

        // sync underlying
        _syncAsset(underlying);
    }

    /// @inheritdoc IVault
    function recover(IERC20Upgradeable token) public override nonReentrant whenNotPaused {
        if (_deployed.contains(address(token))) {
            _redeemTranche(ITranche(address(token)));
            return;
        }

        IPerpetualTranche perp_ = perp;
        if (address(token) == address(perp_)) {
            // In case the vault holds perp tokens after swaps or if transferred in erroneously,
            // anyone can execute this function to recover perps into tranches.
            // This is not part of the regular recovery flow.
            _meldPerps(perp_);
            return;
        }
        revert UnexpectedAsset();
    }

    /// @inheritdoc IVault
    function deposit(uint256 underlyingAmtIn) external override nonReentrant whenNotPaused returns (uint256) {
        // Calculates the fee adjusted amount of notes minted when depositing `underlyingAmtIn` of underlying tokens.
        // NOTE: This operation should precede any token transfers.
        uint256 notes = computeMintAmt(underlyingAmtIn);
        if (underlyingAmtIn <= 0 || notes <= 0) {
            revert UnacceptableDeposit();
        }

        // transfer user assets in
        underlying.safeTransferFrom(_msgSender(), address(this), underlyingAmtIn);
        _syncAsset(underlying);

        // mint notes
        _mint(_msgSender(), notes);
        return notes;
    }

    /// @inheritdoc IVault
    function redeem(uint256 notes) public override nonReentrant whenNotPaused returns (TokenAmount[] memory) {
        if (notes <= 0) {
            revert UnacceptableRedemption();
        }

        // Calculates the fee adjusted share of vault tokens to be redeemed
        // NOTE: This operation should precede any token transfers.
        TokenAmount[] memory redemptions = computeRedemptionAmts(notes);

        // burn notes
        _burn(_msgSender(), notes);

        // transfer assets out
        for (uint8 i = 0; i < redemptions.length; i++) {
            if (redemptions[i].amount > 0) {
                redemptions[i].token.safeTransfer(_msgSender(), redemptions[i].amount);
                _syncAsset(redemptions[i].token);
            }
        }
        return redemptions;
    }

    /// @inheritdoc IVault
    function recoverAndRedeem(uint256 notes) external override whenNotPaused returns (TokenAmount[] memory) {
        recover();
        return redeem(notes);
    }

    /// @inheritdoc IRolloverVault
    /// @dev Callers should call `recover` before executing `swapUnderlyingForPerps` to maximize vault liquidity.
    function swapUnderlyingForPerps(uint256 underlyingAmtIn) external nonReentrant whenNotPaused returns (uint256) {
        // Calculates the fee adjusted perp amount to transfer to the user.
        // NOTE: This operation should precede any token transfers.
        IERC20Upgradeable underlying_ = underlying;
        IPerpetualTranche perp_ = perp;
        (uint256 perpAmtOut, uint256 perpFeeAmtToBurn, SubscriptionParams memory s) = computeUnderlyingToPerpSwapAmt(
            underlyingAmtIn
        );

        // Revert if insufficient tokens are swapped in or out
        uint256 minAmtIn = MIN_SWAP_UNITS * (10 ** IERC20MetadataUpgradeable(address(underlying_)).decimals());
        if (underlyingAmtIn < minAmtIn || perpAmtOut <= 0) {
            revert UnacceptableSwap();
        }

        // transfer underlying in
        underlying_.safeTransferFrom(_msgSender(), address(this), underlyingAmtIn);

        // sync underlying
        _syncAsset(underlying_);

        // tranche and mint perps as needed
        _trancheAndMintPerps(perp_, underlying_, s.perpTVL, s.seniorTR, perpAmtOut + perpFeeAmtToBurn);

        // Pay perp's fee share by burning some of the minted perps
        if (perpFeeAmtToBurn > 0) {
            IERC20Burnable(address(perp_)).burn(perpFeeAmtToBurn);
        }

        // transfer remaining perps out to the user
        perp_.transfer(_msgSender(), perpAmtOut);

        // NOTE: In case this operation mints slightly more perps than that are required for the swap,
        // The vault continues to hold the perp dust until the subsequent `swapPerpsForUnderlying` or manual `recover(perp)`.

        // enforce vault composition
        _enforceVaultComposition(s.vaultTVL);

        return perpAmtOut;
    }

    /// @inheritdoc IRolloverVault
    function swapPerpsForUnderlying(uint256 perpAmtIn) external nonReentrant whenNotPaused returns (uint256) {
        // Calculates the fee adjusted underlying amount to transfer to the user.
        IPerpetualTranche perp_ = perp;
        IERC20Upgradeable underlying_ = underlying;
        (
            uint256 underlyingAmtOut,
            uint256 perpFeeAmtToBurn,
            SubscriptionParams memory s
        ) = computePerpToUnderlyingSwapAmt(perpAmtIn);

        // Revert if insufficient tokens are swapped in or out
        uint256 minAmtIn = MIN_SWAP_UNITS * (10 ** IERC20MetadataUpgradeable(address(perp_)).decimals());
        if (perpAmtIn < minAmtIn || underlyingAmtOut <= 0) {
            revert UnacceptableSwap();
        }

        // transfer perps in
        IERC20Upgradeable(perp_).safeTransferFrom(_msgSender(), address(this), perpAmtIn);

        // Pay perp's fee share by burning some of the transferred perps
        if (perpFeeAmtToBurn > 0) {
            IERC20Burnable(address(perp_)).burn(perpFeeAmtToBurn);
        }

        // Meld incoming perps
        _meldPerps(perp_);

        // transfer underlying out
        underlying_.transfer(_msgSender(), underlyingAmtOut);

        // sync underlying
        _syncAsset(underlying_);

        // enforce vault composition
        _enforceVaultComposition(s.vaultTVL);

        return underlyingAmtOut;
    }

    //--------------------------------------------------------------------------
    // External & Public methods

    /// @inheritdoc IVault
    function computeMintAmt(uint256 underlyingAmtIn) public returns (uint256) {
        //-----------------------------------------------------------------------------
        uint256 feePerc = feePolicy.computeVaultMintFeePerc(
            feePolicy.computeDeviationRatio(_querySubscriptionState(perp))
        );
        //-----------------------------------------------------------------------------

        // Compute mint amt
        uint256 totalSupply_ = totalSupply();
        uint256 notes = (totalSupply_ > 0)
            ? totalSupply_.mulDiv(underlyingAmtIn, getTVL())
            : (underlyingAmtIn * INITIAL_RATE);

        // The mint fees are settled by simply minting fewer vault notes.
        notes = notes.mulDiv(FEE_ONE - feePerc, FEE_ONE);
        return notes;
    }

    /// @inheritdoc IVault
    function computeRedemptionAmts(uint256 notes) public returns (TokenAmount[] memory) {
        //-----------------------------------------------------------------------------
        uint256 feePerc = feePolicy.computeVaultBurnFeePerc(
            feePolicy.computeDeviationRatio(_querySubscriptionState(perp))
        );
        //-----------------------------------------------------------------------------

        uint256 totalSupply_ = totalSupply();
        uint8 assetCount_ = 1 + uint8(_deployed.length());

        // aggregating vault assets to be redeemed
        TokenAmount[] memory redemptions = new TokenAmount[](assetCount_);

        // underlying share to be redeemed
        IERC20Upgradeable underlying_ = underlying;
        redemptions[0] = TokenAmount({
            token: underlying_,
            amount: underlying_.balanceOf(address(this)).mulDiv(notes, totalSupply_)
        });
        redemptions[0].amount = redemptions[0].amount.mulDiv(FEE_ONE - feePerc, FEE_ONE);

        for (uint8 i = 1; i < assetCount_; i++) {
            // tranche token share to be redeemed
            IERC20Upgradeable token = IERC20Upgradeable(_deployed.at(i - 1));
            redemptions[i] = TokenAmount({
                token: token,
                amount: token.balanceOf(address(this)).mulDiv(notes, totalSupply_)
            });

            // deduct redemption fee
            redemptions[i].amount = redemptions[i].amount.mulDiv(FEE_ONE - feePerc, FEE_ONE);

            // in case the redemption amount is just dust, we skip
            if (redemptions[i].amount < TRANCHE_DUST_AMT) {
                redemptions[i].amount = 0;
            }
        }

        return redemptions;
    }

    /// @inheritdoc IRolloverVault
    function computeUnderlyingToPerpSwapAmt(
        uint256 underlyingAmtIn
    ) public returns (uint256, uint256, SubscriptionParams memory) {
        // Compute equal value perps to swap out to the user
        IPerpetualTranche perp_ = perp;
        SubscriptionParams memory s = _querySubscriptionState(perp_);
        uint256 perpAmtOut = underlyingAmtIn.mulDiv(perp_.totalSupply(), s.perpTVL);

        //-----------------------------------------------------------------------------
        // When user swaps underlying for vault's perps -> perps are minted by the vault
        // We thus compute fees based on the post-mint subscription state.
        (uint256 swapFeePerpSharePerc, uint256 swapFeeVaultSharePerc) = feePolicy.computeUnderlyingToPerpSwapFeePercs(
            feePolicy.computeDeviationRatio(s.perpTVL + underlyingAmtIn, s.vaultTVL, s.seniorTR)
        );
        //-----------------------------------------------------------------------------

        // Calculate perp fee share to be paid by the vault
        uint256 perpFeeAmtToBurn = perpAmtOut.mulDiv(swapFeePerpSharePerc, FEE_ONE, MathUpgradeable.Rounding.Up);

        // We deduct fees by transferring out fewer perp tokens
        perpAmtOut = perpAmtOut.mulDiv(FEE_ONE - (swapFeePerpSharePerc + swapFeeVaultSharePerc), FEE_ONE);

        return (perpAmtOut, perpFeeAmtToBurn, s);
    }

    /// @inheritdoc IRolloverVault
    function computePerpToUnderlyingSwapAmt(
        uint256 perpAmtIn
    ) public returns (uint256, uint256, SubscriptionParams memory) {
        // Compute equal value underlying tokens to swap out
        IPerpetualTranche perp_ = perp;
        SubscriptionParams memory s = _querySubscriptionState(perp_);
        uint256 underlyingAmtOut = perpAmtIn.mulDiv(s.perpTVL, perp_.totalSupply());

        //-----------------------------------------------------------------------------
        // When user swaps perps for vault's underlying -> perps are redeemed by the vault
        // We thus compute fees based on the post-burn subscription state.
        (uint256 swapFeePerpSharePerc, uint256 swapFeeVaultSharePerc) = feePolicy.computePerpToUnderlyingSwapFeePercs(
            feePolicy.computeDeviationRatio(s.perpTVL - underlyingAmtOut, s.vaultTVL, s.seniorTR)
        );
        //-----------------------------------------------------------------------------

        // Calculate perp fee share to be paid by the vault
        uint256 perpFeeAmtToBurn = perpAmtIn.mulDiv(swapFeePerpSharePerc, FEE_ONE, MathUpgradeable.Rounding.Up);

        // We deduct fees by transferring out fewer underlying tokens
        underlyingAmtOut = underlyingAmtOut.mulDiv(FEE_ONE - (swapFeePerpSharePerc + swapFeeVaultSharePerc), FEE_ONE);

        return (underlyingAmtOut, perpFeeAmtToBurn, s);
    }

    //--------------------------------------------------------------------------
    // External & Public read methods

    /// @inheritdoc IVault
    /// @dev The total value is denominated in the underlying asset.
    function getTVL() public view override returns (uint256) {
        uint256 totalValue = 0;

        // The underlying balance
        totalValue += underlying.balanceOf(address(this));

        // The deployed asset value denominated in the underlying
        for (uint8 i = 0; i < _deployed.length(); i++) {
            ITranche tranche = ITranche(_deployed.at(i));
            uint256 balance = tranche.balanceOf(address(this));
            if (balance > TRANCHE_DUST_AMT) {
                totalValue += _computeVaultTrancheValue(tranche, underlying, balance);
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
            return (balance > TRANCHE_DUST_AMT) ? _computeVaultTrancheValue(tranche, underlying, balance) : 0;
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
    function deployedCount() external view override returns (uint256) {
        return _deployed.length();
    }

    /// @inheritdoc IVault
    function deployedAt(uint256 i) external view override returns (IERC20Upgradeable) {
        return IERC20Upgradeable(_deployed.at(i));
    }

    /// @inheritdoc IVault
    function isVaultAsset(IERC20Upgradeable token) public view override returns (bool) {
        return token == underlying || _deployed.contains(address(token));
    }

    //--------------------------------------------------------------------------
    // Private write methods

    /// @dev Redeems tranche tokens held by the vault, for underlying.
    ///      NOTE: Reverts when attempting to recover a tranche which is not part of the deployed list.
    ///      In the case of immature redemption, this method will recover other sibling tranches as well.
    function _redeemTranche(ITranche tranche) private {
        uint256 trancheBalance = tranche.balanceOf(address(this));

        // if the vault has no tranche balance,
        // we update our internal book-keeping and return.
        if (trancheBalance <= 0) {
            _syncAndRemoveDeployedAsset(tranche);
            return;
        }

        // get the parent bond
        IBondController bond = IBondController(tranche.bond());

        // if bond has matured, redeem the tranche token
        if (bond.secondsToMaturity() <= 0) {
            // execute redemption
            _execMatureTrancheRedemption(bond, tranche, trancheBalance);

            // sync deployed asset
            _syncAndRemoveDeployedAsset(tranche);
        }
        // if not redeem using proportional balances
        // redeems this tranche and it's siblings if the vault holds balances.
        // We skip if the tranche balance is too low as immature redemption will be a no-op.
        else if (trancheBalance > TRANCHE_DUST_AMT) {
            // execute redemption
            BondTranches memory bt = bond.getTranches();
            _execImmatureTrancheRedemption(bond, bt);

            // sync deployed asset, ie current tranche and all its siblings.
            for (uint8 j = 0; j < bt.tranches.length; j++) {
                _syncAndRemoveDeployedAsset(bt.tranches[j]);
            }
        }

        // sync underlying
        _syncAsset(underlying);
    }

    /// @dev Redeems perp tokens held by the vault for tranches and them melds them with existing tranches to redeem more underlying tokens.
    function _meldPerps(IPerpetualTranche perp_) private {
        uint256 perpBalance = perp_.balanceOf(address(this));
        if (perpBalance > 0) {
            // NOTE: When the vault redeems its perps, it pays no fees.
            TokenAmount[] memory tranchesRedeemed = perp_.redeem(perpBalance);

            // sync underlying
            _syncAsset(tranchesRedeemed[0].token);

            // sync and meld perp's tranches
            for (uint8 i = 1; i < tranchesRedeemed.length; i++) {
                ITranche tranche = ITranche(address(tranchesRedeemed[i].token));
                _syncAndAddDeployedAsset(tranche);

                // if possible, meld redeemed tranche with existing tranches to redeem underlying.
                _redeemTranche(tranche);
            }

            // sync balances
            _syncAsset(perp_);
        }
    }

    /// @dev Tranches the vault's underlying to mint perps.
    ///      If the vault already holds required perps, it skips minting new ones.
    ///      Additionally, performs some book-keeping to keep track of the vault's assets.
    function _trancheAndMintPerps(
        IPerpetualTranche perp_,
        IERC20Upgradeable underlying_,
        uint256 perpTVL,
        uint256 seniorTR,
        uint256 perpAmtToMint
    ) private {
        // Skip if mint amount is zero
        if (perpAmtToMint <= 0) {
            return;
        }

        // Tranche as needed
        IBondController depositBond = perp.getDepositBond();
        ITranche trancheIntoPerp = perp.getDepositTranche();
        (uint256 underylingAmtToTranche, uint256 seniorAmtToDeposit) = PerpHelpers.estimateUnderlyingAmtToTranche(
            perpTVL,
            perp.totalSupply(),
            underlying_.balanceOf(address(depositBond)),
            depositBond.totalDebt(),
            trancheIntoPerp.totalSupply(),
            seniorTR,
            perpAmtToMint
        );
        _tranche(depositBond, underlying_, underylingAmtToTranche);

        // Mint perps
        _checkAndApproveMax(trancheIntoPerp, address(perp_), seniorAmtToDeposit);
        // NOTE: When the vault mints perps, it pays no fees.
        perp_.deposit(trancheIntoPerp, seniorAmtToDeposit);

        // sync holdings
        _syncAndRemoveDeployedAsset(trancheIntoPerp);
        _syncAsset(perp_);
    }

    /// @dev Given a bond and its tranche data, deposits the provided amount into the bond
    ///      and receives tranche tokens in return.
    ///      Additionally, performs some book-keeping to keep track of the vault's assets.
    function _tranche(IBondController bond, IERC20Upgradeable underlying_, uint256 underlyingAmt) private {
        // Skip if amount is zero
        if (underlyingAmt <= 0) {
            return;
        }

        // Get bond tranches
        BondTranches memory bt = bond.getTranches();

        // amount is tranched
        _checkAndApproveMax(underlying_, address(bond), underlyingAmt);
        bond.deposit(underlyingAmt);

        // sync holdings
        for (uint8 i = 0; i < bt.tranches.length; i++) {
            _syncAndAddDeployedAsset(bt.tranches[i]);
        }
        _syncAsset(underlying_);
    }

    /// @dev Rolls over freshly tranched tokens from the given bond for older tranches (close to maturity) from perp.
    ///      And performs some book-keeping to keep track of the vault's assets.
    /// @return Flag indicating if any tokens were rolled over.
    function _rollover(IPerpetualTranche perp_, IERC20Upgradeable underlying_) private returns (bool, ITranche) {
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
        _checkAndApproveMax(trancheIntoPerp, address(perp_), trancheInAmtAvailable);

        // We pair the senior tranche token held by the vault (from the deposit bond)
        // with each of the perp's tokens available for rollovers and execute a rollover.
        // We continue to rollover till either the vault's senior tranche balance is exhausted or
        // there are no more tokens in perp available to be rolled-over.
        for (uint256 i = 0; (i < rolloverTokens.length && trancheInAmtAvailable > 0); i++) {
            // tokenOutOfPerp is the reserve token coming out of perp into the vault
            IERC20Upgradeable tokenOutOfPerp = rolloverTokens[i];
            if (address(tokenOutOfPerp) == address(0)) {
                continue;
            }

            // Perform rollover
            RolloverData memory r = perp_.rollover(trancheIntoPerp, tokenOutOfPerp, trancheInAmtAvailable);

            // no rollover occured, skip updating balances
            if (r.tokenOutAmt <= 0) {
                continue;
            }

            // sync deployed asset sent to perp
            _syncAndRemoveDeployedAsset(trancheIntoPerp);

            // skip insertion into the deployed list the case of the mature tranche, ie underlying
            // NOTE: we know that `rolloverTokens[0]` points to the underlying asset so every other
            // token in the list is a tranche which the vault needs to keep track of.
            if (i > 0) {
                // sync deployed asset retrieved from perp
                _syncAndAddDeployedAsset(tokenOutOfPerp);
            }

            // Recompute trancheIn available amount
            trancheInAmtAvailable = trancheIntoPerp.balanceOf(address(this));

            // keep track if "at least" one rolled over operation occurred
            rollover = true;
        }

        // sync underlying
        _syncAsset(underlying_);

        return (rollover, trancheIntoPerp);
    }

    /// @dev Low level method that redeems the given mature tranche for the underlying asset.
    ///      It interacts with the button-wood bond contract.
    ///      This function should NOT be called directly, use `recover()` or `recover(tranche)`
    ///      which wrap this function with the internal book-keeping necessary,
    ///      to keep track of the vault's assets.
    function _execMatureTrancheRedemption(IBondController bond, ITranche tranche, uint256 amount) private {
        if (!bond.isMature()) {
            bond.mature();
        }
        bond.redeemMature(address(tranche), amount);
    }

    /// @dev Low level method that redeems the given tranche for the underlying asset, before maturity.
    ///      If the vault holds sibling tranches with proportional balances, those will also get redeemed.
    ///      It interacts with the button-wood bond contract.
    ///      This function should NOT be called directly, use `recover()` or `recover(tranche)`
    ///      which wrap this function with the internal book-keeping necessary,
    ///      to keep track of the vault's assets.
    function _execImmatureTrancheRedemption(IBondController bond, BondTranches memory bt) private {
        uint256[] memory trancheAmts = bt.computeRedeemableTrancheAmounts(address(this));

        // NOTE: It is guaranteed that if one tranche amount is zero, all amounts are zeros.
        if (trancheAmts[0] > 0) {
            bond.redeem(trancheAmts);
        }
    }

    // @dev Transfers a the set fixed fee amount of underlying tokens to the owner.
    function _deductProtocolFee(IERC20Upgradeable underlying_) private {
        underlying_.safeTransfer(owner(), feePolicy.computeVaultDeploymentFee());
    }

    /// @dev Syncs balance and adds the given asset into the deployed list if the vault has a balance.
    function _syncAndAddDeployedAsset(IERC20Upgradeable token) private {
        uint256 balance = token.balanceOf(address(this));
        emit AssetSynced(token, balance);

        if (balance > 0 && !_deployed.contains(address(token))) {
            // Inserts new token into the deployed assets list.
            _deployed.add(address(token));
            if (_deployed.length() > MAX_DEPLOYED_COUNT) {
                revert DeployedCountOverLimit();
            }
        }
    }

    /// @dev Syncs balance and removes the given asset from the deployed list if the vault has no balance.
    function _syncAndRemoveDeployedAsset(IERC20Upgradeable token) private {
        uint256 balance = token.balanceOf(address(this));
        emit AssetSynced(token, balance);

        if (balance <= 0 && _deployed.contains(address(token))) {
            // Removes token into the deployed assets list.
            _deployed.remove(address(token));
        }
    }

    /// @dev Logs the token balance held by the vault.
    function _syncAsset(IERC20Upgradeable token) private {
        uint256 balance = token.balanceOf(address(this));
        emit AssetSynced(token, balance);
    }

    /// @dev Checks if the spender has sufficient allowance. If not, approves the maximum possible amount.
    function _checkAndApproveMax(IERC20Upgradeable token, address spender, uint256 amount) private {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance < amount) {
            token.safeApprove(spender, type(uint256).max);
        }
    }

    /// @dev Queries the current subscription state of the perp and vault systems.
    function _querySubscriptionState(IPerpetualTranche perp_) private returns (SubscriptionParams memory) {
        return
            SubscriptionParams({
                perpTVL: perp_.getTVL(),
                vaultTVL: getTVL(),
                seniorTR: perp_.getDepositTrancheRatio()
            });
    }

    //--------------------------------------------------------------------------
    // Private methods

    // @dev Enforces vault composition after swap and meld operations.
    function _enforceVaultComposition(uint256 tvlBefore) private view {
        // Assert that the vault's TVL does not decrease after this operation
        uint256 tvlAfter = getTVL();
        if (tvlAfter < tvlBefore) {
            revert TVLDecreased();
        }
    }

    /// @dev Computes the value of the given amount of tranche tokens, based on it's current CDR.
    ///      Value is denominated in the underlying collateral.
    function _computeVaultTrancheValue(
        ITranche tranche,
        IERC20Upgradeable collateralToken,
        uint256 trancheAmt
    ) private view returns (uint256) {
        (uint256 trancheClaim, uint256 trancheSupply) = tranche.getTrancheCollateralization(collateralToken);
        return trancheClaim.mulDiv(trancheAmt, trancheSupply, MathUpgradeable.Rounding.Up);
    }
}
