// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20Upgradeable, IPerpetualTranche, IBondIssuer, IBondController, ITranche } from "../_interfaces/IPerpetualTranche.sol";
import { IVault, UnexpectedAsset, UnauthorizedTransferOut, InsufficientDeployment, DeployedCountOverLimit, UnacceptableDeposit, UnacceptableRedemption } from "../_interfaces/IVault.sol";

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { ERC20BurnableUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { BondTranches, BondTranchesHelpers } from "../_utils/BondTranchesHelpers.sol";
import { TrancheHelpers } from "../_utils/TrancheHelpers.sol";
import { BondHelpers } from "../_utils/BondHelpers.sol";

/// @notice Expected contract call to be triggered by authorized caller.
/// @param caller The address which triggered the call.
/// @param authorizedCaller The address which is authorized to trigger the call.
error UnauthorizedCall(address caller, address authorizedCaller);

/// @notice Storage array access out of bounds.
error OutOfBounds();

/// @notice Expected bond to be valid.
/// @param bond Address of the invalid bond.
error InvalidBond(IBondController bond);

/// @notice Expected the operation not to decrease the vault's tvl.
error TVLDecreased();

/// @notice Expected assets transferred into the vault to have non-zero value.
error ValuelessAssets();

/// @notice Expected percentage of vault's tvl held as underlying tokens to be lower.
error UnderlyingPercOverLimit();

/// @notice Percentage value must be lower than 100%.
error InvalidPerc();

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
 *                 system through a rollover operation and earns an income in perp tokens.
 *              2) recover: The vault redeems 1) perps for their underlying tranches and the
 *                          2) tranches it holds for the underlying asset.
 *                 NOTE: It performs both mature and immature redemption. Read more: https://bit.ly/3tuN6OC
 *
 *
 * @dev When new tranches are added into the system, always double check if they are not malicious.
 *      This vault accepts new tranches into the system during the `deploy` operation, i.e) the `tranche` and `rollover` functions.
 *      In the `tranche` function, it only accepts tranches from perp's deposit bond.
 *      In the `rollover` function, it only accepts tranches returned by perp.
 *
 */
contract RolloverVault is
    ERC20BurnableUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    IVault
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
    uint8 public constant PERC_DECIMALS = 8;
    uint256 public constant UNIT_PERC = 10**(PERC_DECIMALS - 2);
    uint256 public constant HUNDRED_PERC = 10**PERC_DECIMALS;

    /// @dev Initial exchange rate between the underlying asset and notes.
    uint256 private constant INITIAL_RATE = 10**6;

    /// @dev Values should line up as is in the perp contract.
    uint8 private constant PERP_PRICE_DECIMALS = 8;
    uint256 private constant PERP_UNIT_PRICE = (10**PERP_PRICE_DECIMALS);

    /// @dev The maximum number of deployed assets that can be held in this vault at any given time.
    uint256 public constant MAX_DEPLOYED_COUNT = 47;

    //--------------------------------------------------------------------------
    // ASSETS
    //
    // The vault's assets are represented by a master list of ERC-20 tokens
    //      => { [underlying] U _deployed U _earned }
    //
    // In the case of this vault, the "earned" assets are the perp tokens themselves.
    // The reward (or yield) for performing rollovers is paid out in perp tokens.

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

    /// @notice Reference to the wallet or contract that has the ability to pause/unpause operations.
    /// @return The address of the keeper.
    address public keeper;

    /// @notice The enforced minimum balance of underlying tokens to be held by the vault at all times.
    /// @dev On deployment only the delta greater than this balance is deployed.
    uint256 public minUnderlyingBal;

    /// @notice The enforced maximum percentage of the vault's TVL that can be held as underlying tokens.
    /// @dev When the users meld or swap assets with the vault, the vault effectively exchanges tranches
    ///      for more liquidity that can be used for future deployments. This parameter controls
    ///      the extent to which the vault can allow melding or swapping.
    uint256 public maxUnderlyingPerc;

    struct FeeData {
        // @notice The percentage of vault notes withheld as fees on redemption.
        uint256 redemptionFeePerc;
        // @notice The maximum percentage fee paid in the underlying assets by users who meld.
        // @dev The final fee is discounted based on remaining time to maturity.
        uint256 meldFeePerc;
        // @notice The maximum percentage fee paid in the underlying assets by users who swap.
        // @dev The final fee is discounted based on remaining time to maturity.
        uint256 swapFeePerc;
        // @notice A fixed cost charged at the time of deployment denominated in the underlying asset.
        uint256 protocolFee;
    }

    // @notice The vault operational fees set by the owner.
    FeeData public fees;

    //--------------------------------------------------------------------------
    // Modifiers

    /// @dev Throws if called by any account other than the keeper.
    modifier onlyKeeper() {
        if (_msgSender() != keeper) {
            revert UnauthorizedCall(_msgSender(), keeper);
        }
        _;
    }

    //--------------------------------------------------------------------------
    // Construction & Initialization

    /// @notice Contract state initialization.
    /// @param name ERC-20 Name of the vault token.
    /// @param symbol ERC-20 Symbol of the vault token.
    /// @param perp_ ERC-20 address of the perpetual tranche rolled over.
    function init(
        string memory name,
        string memory symbol,
        IPerpetualTranche perp_
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
        underlying = perp_.collateral();
        _syncAsset(underlying);

        // set reference to perp
        perp = perp_;

        // setting initial fees
        fees.redemptionFeePerc = 0;
        fees.meldFeePerc = 10 * UNIT_PERC;
        fees.swapFeePerc = 10 * UNIT_PERC;
        fees.protocolFee = 0;

        // setting initial parameter values
        minDeploymentAmt = 0;
        minUnderlyingBal = 0;
        maxUnderlyingPerc = 0;
    }

    //--------------------------------------------------------------------------
    // ADMIN only methods

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

    /// @notice Updates the maximum underlying percentage requirement.
    /// @param maxUnderlyingPerc_ The new maximum underlying percentage.
    function updateMaxUnderlyingPerc(uint256 maxUnderlyingPerc_) external onlyOwner {
        if (maxUnderlyingPerc_ > HUNDRED_PERC) {
            revert InvalidPerc();
        }
        maxUnderlyingPerc = maxUnderlyingPerc_;
    }

    /// @notice Updates all the fee parameters.
    /// @param fees_ The new fee parameters.
    function updateFees(FeeData memory fees_) external onlyOwner {
        if (
            fees_.redemptionFeePerc > HUNDRED_PERC ||
            fees_.meldFeePerc > HUNDRED_PERC ||
            fees_.swapFeePerc > HUNDRED_PERC
        ) {
            revert InvalidPerc();
        }
        fees = fees_;
    }

    /// @notice Transfers a non-vault token out of the contract, which may have been added accidentally.
    /// @param token The token address.
    /// @param to The destination address.
    /// @param amount The amount of tokens to be transferred.
    function transferERC20(
        IERC20Upgradeable token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (isVaultAsset(token)) {
            revert UnauthorizedTransferOut(token);
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
    ///      Reverts if no funds are rolled over or if the minimum deployment threshold is not reached.
    function deploy() public override nonReentrant whenNotPaused {
        // NOTE: we only trust and add tranches from perp's deposit bond, or tranches rolled out from perp.
        (uint256 deployedAmt, BondTranches memory bt) = _tranche(perp.getDepositBond());
        // NOTE: The following enforces that we only tranche the underlying if it can immediately be used for rotations.
        if (deployedAmt <= minDeploymentAmt || !_rollover(perp, bt)) {
            revert InsufficientDeployment();
        }
    }

    /// @inheritdoc IVault
    function recover() public override nonReentrant whenNotPaused {
        // Redeem perp for tranches
        _redeemPerp(perp);

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

            // if bond has matured, redeem the tranche token
            if (bond.secondsToMaturity() <= 0) {
                // execute redemption
                _execMatureTrancheRedemption(bond, tranche, trancheBalance);
            }
            // if not redeem using proportional balances
            // redeems this tranche and it's siblings if the vault holds balances.
            // NOTE: For gas optimization, we perform this operation only once
            // ie) when we encounter the most-senior tranche.
            else if (tranche == bond.trancheAt(0)) {
                // execute redemption
                _execImmatureTrancheRedemption(bond, bond.getTranches());
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
        if (address(token) == address(perp)) {
            _redeemPerp(perp);
        } else if (_deployed.contains(address(token))) {
            _redeemTranche(ITranche(address(token)));
        } else {
            revert UnexpectedAsset(token);
        }
    }

    /// @inheritdoc IVault
    function deposit(uint256 amount) external override nonReentrant whenNotPaused returns (uint256) {
        uint256 totalSupply_ = totalSupply();
        uint256 notes = (totalSupply_ > 0) ? totalSupply_.mulDiv(amount, getTVL()) : (amount * INITIAL_RATE);
        if (amount <= 0 || notes <= 0) {
            revert UnacceptableDeposit();
        }

        underlying.safeTransferFrom(_msgSender(), address(this), amount);
        _syncAsset(underlying);

        _mint(_msgSender(), notes);
        return notes;
    }

    /// @inheritdoc IVault
    function redeem(uint256 notes) external override nonReentrant whenNotPaused returns (IVault.TokenAmount[] memory) {
        if (notes <= 0) {
            revert UnacceptableRedemption();
        }
        uint256 totalNotes = totalSupply();
        uint8 deployedCount_ = uint8(_deployed.length());
        uint8 assetCount = 2 + deployedCount_;

        // aggregating vault assets to be redeemed
        IVault.TokenAmount[] memory redemptions = new IVault.TokenAmount[](assetCount);
        redemptions[0].token = underlying;
        for (uint8 i = 0; i < deployedCount_; i++) {
            redemptions[i + 1].token = IERC20Upgradeable(_deployed.at(i));
        }
        redemptions[deployedCount_ + 1].token = IERC20Upgradeable(perp);

        // burn notes
        _burn(_msgSender(), notes);

        // calculating amounts and transferring assets out proportionally
        for (uint8 i = 0; i < assetCount; i++) {
            redemptions[i].amount = redemptions[i].token.balanceOf(address(this)).mulDiv(notes, totalNotes);
            redemptions[i].token.safeTransfer(_msgSender(), redemptions[i].amount);
            _syncAsset(redemptions[i].token);
        }

        return redemptions;
    }

    /// @notice Swaps the bond tranche slices from the user into the underlying collateral for a fee,
    ///         given that the vault has the remaining slices for immature redemption.
    /// @dev When a user has some tranche slices from a given bond, and the vault has the remaining slices,
    ///      this method allows the user and the vault to "meld" their assets together to redeem the underlying collateral
    ///      from the bond. The user's share of the underlying is returned back and the vault charges
    ///      the user a fee for providing liquidity.
    /// @param bond The bond whose tranches are to be swapped.
    /// @param trancheAmtsIn A list of amounts of each bond tranche the user is to deposit.
    ///                      When the user does not have a particular slice, its amount in the list is to be set to zero.
    /// @return The amount of underlying tokens returned.
    function meld(IBondController bond, uint256[] memory trancheAmtsIn)
        external
        nonReentrant
        whenNotPaused
        returns (uint256)
    {
        // get bond tranches
        BondTranches memory bt = bond.getTranches();

        // * We check that the bond's underlying collateral token matches the vault's underlying.
        // * We validate that the bond has at least 2 tranches to perform the meld operation.
        // * We validate that the bond hasn't reached maturity as matching only works through immature redemption.
        if (bond.collateralToken() != address(underlying) || bt.tranches.length <= 1 || bond.isMature()) {
            revert InvalidBond(bond);
        }

        // We check if the given bond is NOT malicious by examining if:
        // * The parent bond of all the children tranches is the given bond.
        // * At least one of the bond's tranches is already in the vault from previous deployments.
        bool isValidBond = false;
        for (uint8 i = 0; i < bt.tranches.length; i++) {
            if (bt.tranches[i].bond() != address(bond)) {
                revert InvalidBond(bond);
            }

            isValidBond = isValidBond || _deployed.contains(address(bt.tranches[i]));
        }
        if (!isValidBond) {
            revert InvalidBond(bond);
        }

        // track the vault's TVL before the match operation
        uint256 tvlBefore = getTVL();

        // First we check if the vault has all the tranches for proportional redemption and if so recover the underlying.
        // On successful redemption, The vault's individual tranche balances will decrease, and the underlying balance will increase.
        // If the vault tranches are not eligible for proportional redemption, its a no-op.
        // NOTE: We sync balances finally at the end of this function.
        _execImmatureTrancheRedemption(bond, bt);

        // calculate total amount to be used by summing available amount from the user and the vault's balance
        uint256[] memory trancheAmtsUsed = new uint256[](bt.tranches.length);
        for (uint8 i = 0; i < bt.tranches.length; i++) {
            trancheAmtsUsed[i] = trancheAmtsIn[i] + bt.tranches[i].balanceOf(address(this));
        }

        // compute proportional tranche amounts which can be redeemed for the underlying collateral
        trancheAmtsUsed = bt.computeRedeemableTrancheAmounts(trancheAmtsUsed);

        // computes the collateralizations for each tranche in the current immature bond
        uint256[] memory trancheUnderlyingBalances;
        uint256[] memory trancheSupplies;
        (trancheUnderlyingBalances, trancheSupplies) = bond.getImmatureTrancheCollateralizations(bt);

        // the user's share of the underlying collateral to be returned
        uint256 underlyingAmt = 0;
        for (uint8 i = 0; i < bt.tranches.length; i++) {
            // compute the user's tranche balance to be used
            // transfer tranche balance out of the user's wallet to the vault
            trancheAmtsIn[i] = MathUpgradeable.min(trancheAmtsIn[i], trancheAmtsUsed[i]);
            IERC20Upgradeable(bt.tranches[i]).safeTransferFrom(_msgSender(), address(this), trancheAmtsIn[i]);

            // pre-calculate the user's share
            underlyingAmt += trancheUnderlyingBalances[i].mulDiv(trancheAmtsIn[i], trancheSupplies[i]);
        }

        // ensure that the user is sending in tranches with some redeemable value.
        if (underlyingAmt <= 0) {
            revert ValuelessAssets();
        }

        // redeem the underlying using pooled balances
        bond.redeem(trancheAmtsUsed);

        // deduct fee before returning to the user
        underlyingAmt -= _computeMeldFee(bond, underlyingAmt);

        // transfer to the user
        underlying.safeTransfer(_msgSender(), underlyingAmt);

        // sync vault's tranche balances
        for (uint8 i = 0; i < bt.tranches.length; i++) {
            _syncAndRemoveDeployedAsset(bt.tranches[i]);
        }

        // sync underlying
        _syncAsset(underlying);

        // assert that the vault's TVL does not decrease after this operation
        if (getTVL() < tvlBefore) {
            revert TVLDecreased();
        }

        // TODO: assert that the percentage of raw ampl to the TVL is under
        //       a onwer specified value. (ie) Limit the amount the meld opration
        //       can de-lever the vault.

        return underlyingAmt;
    }

    /// @inheritdoc IVault
    /// @dev The total value is denominated in the underlying asset.
    function getTVL() public override returns (uint256) {
        uint256 totalValue = 0;

        // The underlying balance
        totalValue += underlying.balanceOf(address(this));

        // The deployed asset value denominated in the underlying
        for (uint8 i = 0; i < _deployed.length(); i++) {
            ITranche tranche = ITranche(_deployed.at(i));
            uint256 balance = tranche.balanceOf(address(this));
            if (balance > 0) {
                totalValue += _computeVaultTrancheValue(tranche, balance);
            }
        }

        // The earned asset (perp token) value denominated in the underlying
        uint256 perpBalance = perp.balanceOf(address(this));
        if (perpBalance > 0) {
            // The "earned" asset is assumed to be the perp token.
            // Perp tokens are assumed to have the same denomination as the underlying
            totalValue += perpBalance.mulDiv(IPerpetualTranche(address(perp)).getAvgPrice(), PERP_UNIT_PRICE);
        }

        return totalValue;
    }

    /// @inheritdoc IVault
    /// @dev The asset value is denominated in the underlying asset.
    function getVaultAssetValue(IERC20Upgradeable token) external override returns (uint256) {
        uint256 balance = token.balanceOf(address(this));

        // Underlying asset
        if (token == underlying) {
            return balance;
        }
        // Deployed asset
        else if (_deployed.contains(address(token))) {
            return _computeVaultTrancheValue(ITranche(address(token)), balance);
        }
        // Earned asset
        else if (address(token) == address(perp)) {
            return (balance.mulDiv(IPerpetualTranche(address(perp)).getAvgPrice(), PERP_UNIT_PRICE));
        }

        // Not a vault asset, so returning zero
        return 0;
    }

    //--------------------------------------------------------------------------
    // External & Public read methods

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
    function earnedCount() external pure returns (uint256) {
        return 1;
    }

    /// @inheritdoc IVault
    function earnedAt(uint256 i) external view override returns (IERC20Upgradeable) {
        if (i > 0) {
            revert OutOfBounds();
        }
        return IERC20Upgradeable(perp);
    }

    /// @inheritdoc IVault
    function isVaultAsset(IERC20Upgradeable token) public view override returns (bool) {
        return (token == underlying) || _deployed.contains(address(token)) || (address(token) == address(perp));
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
        else {
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

    /// @dev Redeems perp tokens held by the vault for tranches.
    function _redeemPerp(IPerpetualTranche perp_) private {
        uint256 perpBalance = perp_.balanceOf(address(this));
        if (perpBalance > 0) {
            (IERC20Upgradeable[] memory tranchesRedeemed, ) = perp_.redeem(perpBalance);

            // sync underlying
            // require(tranchesRedeemed[0] == underlying);
            _syncAsset(underlying);

            // sync new tranches
            for (uint8 i = 1; i < tranchesRedeemed.length; i++) {
                _syncAndAddDeployedAsset(tranchesRedeemed[i]);
            }
            // sync perp
            _syncAsset(perp_);
        }
    }

    /// @dev Given a bond and its tranche data, deposits the provided amount into the bond
    ///      and receives tranche tokens in return.
    ///      Additionally, performs some book-keeping to keep track of the vault's assets.
    function _tranche(
        IBondController bond,
        BondTranches memory bt,
        uint256 amount
    ) private {
        // Skip if balance is zero
        if (amount <= 0) {
            return;
        }

        // balance is tranched
        _checkAndApproveMax(underlying, address(bond), amount);
        bond.deposit(amount);

        // sync holdings
        for (uint8 i = 0; i < bt.tranches.length; i++) {
            _syncAndAddDeployedAsset(bt.tranches[i]);
        }
        _syncAsset(underlying);
    }

    /// @dev Rolls over freshly tranched tokens from the given bond for older tranches (close to maturity) from perp.
    ///      And performs some book-keeping to keep track of the vault's assets.
    /// @return Flag indicating if any tokens were rolled over.
    function _rollover(IPerpetualTranche perp_, BondTranches memory bt) private returns (bool) {
        // NOTE: The first element of the list is the mature tranche,
        //       there after the list is NOT ordered by maturity.
        IERC20Upgradeable[] memory rolloverTokens = perp_.getReserveTokensUpForRollover();

        // Batch rollover
        bool rollover = false;

        // Note: We roll-in ONLY the "senior" most tranche as perp ONLY accepts seniors.
        // trancheIntoPerp refers to the tranche going into perp from the vault
        ITranche trancheIntoPerp = bt.tranches[0];

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
            IPerpetualTranche.RolloverData memory r = perp_.rollover(
                trancheIntoPerp,
                tokenOutOfPerp,
                trancheInAmtAvailable
            );

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

        // sync underlying and earned (ie perp)
        _syncAsset(underlying);
        _syncAsset(perp_);

        return rollover;
    }

    /// @dev Low level method that redeems the given mature tranche for the underlying asset.
    ///      It interacts with the button-wood bond contract.
    ///      This function should NOT be called directly, use `recover()` or `recover(tranche)`
    ///      which wrap this function with the internal book-keeping necessary,
    ///      to keep track of the vault's assets.
    function _execMatureTrancheRedemption(
        IBondController bond,
        ITranche tranche,
        uint256 amount
    ) private {
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
    function _checkAndApproveMax(
        IERC20Upgradeable token,
        address spender,
        uint256 amount
    ) private {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance < amount) {
            token.safeApprove(spender, 0);
            token.safeApprove(spender, type(uint256).max);
        }
    }

    //--------------------------------------------------------------------------
    // Private view methods

    // @dev Computes the value of the tranche tokens held by the vault,
    //      based on the current CDR. Value is denominated in the underlying collateral.
    function _computeVaultTrancheValue(ITranche tranche, uint256 amount) private view returns (uint256) {
        (uint256 collateralBalance, uint256 trancheSupply) = tranche.getTrancheCollateralization();
        return collateralBalance.mulDiv(amount, trancheSupply);
    }

    /// @dev Computes the final fee percentage as linear function,
    ///      based on the bond's time remaining to maturity wrt is duration.
    function _computeFeePerc(IBondController bond, uint256 maxFeePerc) private view returns (uint256) {
        uint256 maturityTimestampSec = bond.maturityDate();
        uint256 bondDurationSec = maturityTimestampSec - bond.creationDate();
        uint256 secondsToMaturity = (
            maturityTimestampSec > block.timestamp ? maturityTimestampSec - block.timestamp : 0
        );
        return maxFeePerc.mulDiv(secondsToMaturity, bondDurationSec);
    }
}
