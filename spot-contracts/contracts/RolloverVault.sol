// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20Upgradeable, IPerpetualTranche, IBondIssuer, IBondController, ITranche, IFeePolicy } from "./_interfaces/IPerpetualTranche.sol";
import { IVault } from "./_interfaces/IVault.sol";
import { IERC20Burnable } from "./_interfaces/IERC20Burnable.sol";
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
 *          With v2.0, vault provides swap liquidity and charges a fee.
 *          The swap fees are an additional source of yield for vault note holders.
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
    uint8 public constant FEE_POLICY_DECIMALS = 8;
    uint256 public constant FEE_ONE_PERC = (10**FEE_POLICY_DECIMALS);

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
    function transferERC20(
        IERC20Upgradeable token,
        address to,
        uint256 amount
    ) external onlyOwner {
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
        _deductProtocolFee();

        uint256 usableBal = underlying.balanceOf(address(this));
        if (usableBal <= minUnderlyingBal) {
            revert InsufficientDeployment();
        }

        uint256 deployedAmt = usableBal - minUnderlyingBal;
        if (deployedAmt <= minDeploymentAmt) {
            revert InsufficientDeployment();
        }

        // NOTE: We only trust incoming tranches from perp's deposit bond,
        // or ones rolled out of perp.
        IBondController depositBond = perp.getDepositBond();
        BondTranches memory bt = depositBond.getTranches();
        _tranche(depositBond, bt, deployedAmt);
        if (!_rollover(perp, bt)) {
            revert InsufficientDeployment();
        }
    }

    /// @inheritdoc IVault
    function recover() public override nonReentrant whenNotPaused {
        // Redeem perp for tranches
        _redeemPerps(perp);

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
            _redeemPerps(perp);
        } else if (_deployed.contains(address(token))) {
            _redeemTranche(ITranche(address(token)));
        } else {
            revert UnexpectedAsset();
        }
    }

    /// @inheritdoc IVault
    function deposit(uint256 amount) external override nonReentrant whenNotPaused returns (uint256) {
        uint256 totalSupply_ = totalSupply();
        uint256 notes = (totalSupply_ > 0) ? totalSupply_.mulDiv(amount, getTVL()) : (amount * INITIAL_RATE);

        // deduct mint fees
        notes = notes.mulDiv(FEE_ONE_PERC - feePolicy.computeVaultMintFeePerc(), FEE_ONE_PERC);

        // Revert if no tokens are transferred
        if (amount <= 0 || notes <= 0) {
            revert UnacceptableDeposit();
        }

        // transfer user assets in
        underlying.safeTransferFrom(_msgSender(), address(this), amount);
        _syncAsset(underlying);

        // mint notes
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
            // computing users share
            redemptions[i].amount = redemptions[i].token.balanceOf(address(this)).mulDiv(notes, totalNotes);

            // deduct redemption fees
            redemptions[i].amount = redemptions[i].amount.mulDiv(
                FEE_ONE_PERC - feePolicy.computeVaultBurnFeePerc(),
                FEE_ONE_PERC
            );

            // transfering assets out
            redemptions[i].token.safeTransfer(_msgSender(), redemptions[i].amount);
            _syncAsset(redemptions[i].token);
        }

        return redemptions;
    }

    /// @notice Allows users to swap their underlying tokens for perps held by the vault
    /// @param underlyingAmtIn The amount of underlying tokens swapped in.
    /// @return The amount of perp tokens swapped out.
    function swapUnderlyingForPerps(uint256 underlyingAmtIn) external nonReentrant whenNotPaused returns (uint256) {
        // compute equal value perps to swap out
        uint256 perpPrice = perp.getAvgPrice();
        uint256 perpAmtOut = underlyingAmtIn.mulDiv(PERP_UNIT_PRICE, perpPrice);

        // Compute fees
        (uint256 swapFeePerpSharePerc, uint256 swapFeeVaultSharePerc) = feePolicy.computeUnderlyingToPerpSwapFeePercs(
            underlyingAmtIn
        );

        // We compute perp's fee share
        uint256 perpAmtToBurn = perpAmtOut.mulDiv(swapFeePerpSharePerc, FEE_ONE_PERC, MathUpgradeable.Rounding.Up);

        // We deduct fees by transferring out fewer perp tokens
        perpAmtOut = perpAmtOut.mulDiv(FEE_ONE_PERC - (swapFeePerpSharePerc + swapFeeVaultSharePerc), FEE_ONE_PERC);

        // Revert if no tokens are swapped in or out
        if (underlyingAmtIn == 0 || perpAmtOut == 0) {
            revert UnacceptableSwap();
        }

        // transfer underlying in
        underlying.safeTransferFrom(_msgSender(), address(this), underlyingAmtIn);

        // tranche and mint perps as needed
        {
            uint256 perpBal = perp.balanceOf(address(this));
            uint256 perpsReq = perpAmtOut + perpAmtToBurn;
            if (perpBal < perpsReq) {
                recover();
                _trancheAndMintPerps(perp, perpPrice, perpsReq - perpBal);
            }
        }

        // Pay perp's fee share by burning some of the minted perps
        if (perpAmtToBurn > 0) {
            IERC20Burnable(address(perp)).burn(perpAmtToBurn);
        }

        // transfer remaining perps out to the user
        perp.transfer(_msgSender(), perpAmtOut);

        // sync balances
        _syncAsset(underlying);
        _syncAsset(perp);

        return perpAmtOut;
    }

    /// @notice Allows users to swap their perp tokens for underlying tokens held by the vault
    /// @param perpAmtIn The amount of perp tokens swapped in.
    /// @return The amount of underlying tokens swapped out.
    function swapPerpsForUnderlying(uint256 perpAmtIn) external nonReentrant whenNotPaused returns (uint256) {
        // Compute equal value underlying tokens to swap out
        uint256 perpPrice = perp.getAvgPrice();
        uint256 underlyingAmtOut = perpAmtIn.mulDiv(perpPrice, PERP_UNIT_PRICE);

        // Compute fees
        (uint256 swapFeePerpSharePerc, uint256 swapFeeVaultSharePerc) = feePolicy.computePerpToUnderlyingSwapFeePercs(
            underlyingAmtOut
        );

        // We compute perp's fee share
        uint256 perpAmtToBurn = perpAmtIn.mulDiv(swapFeePerpSharePerc, FEE_ONE_PERC, MathUpgradeable.Rounding.Up);

        // We deduct fees by transferring out fewer underlying tokens
        underlyingAmtOut = underlyingAmtOut.mulDiv(
            FEE_ONE_PERC - (swapFeePerpSharePerc + swapFeeVaultSharePerc),
            FEE_ONE_PERC
        );

        // Revert if no tokens are swapped in or out
        if (perpAmtIn == 0 || underlyingAmtOut == 0) {
            revert UnacceptableSwap();
        }

        // transfer perps in
        IERC20Upgradeable(perp).safeTransferFrom(_msgSender(), address(this), perpAmtIn);

        // Pay perp's fee share by burning some of the transferred perps
        if (perpAmtToBurn > 0) {
            IERC20Burnable(address(perp)).burn(perpAmtToBurn);
        }

        // redeem perps and tranches to maximize underlying balance
        {
            uint256 underlyingBal = underlying.balanceOf(address(this));
            if (underlyingBal < underlyingAmtOut) {
                recover();
            }
        }

        // transfer underlying out
        underlying.transfer(_msgSender(), underlyingAmtOut);

        // sync balances
        _syncAsset(perp);
        _syncAsset(underlying);

        return underlyingAmtOut;
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
    function _redeemPerps(IPerpetualTranche perp_) private {
        uint256 perpBalance = perp_.balanceOf(address(this));
        if (perpBalance > 0) {
            // NOTE: When the vault redeems its perps, it pays no fees.
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

    /// @dev Tranches the vault's underlying to mint perps.
    ///      If the vault already holds required perps, it skips minting new ones.
    ///      Additionally, performs some book-keeping to keep track of the vault's assets.
    function _trancheAndMintPerps(
        IPerpetualTranche perp_,
        uint256 perpPrice,
        uint256 perpAmtToMint
    ) private {
        // Skip if mint amount is zero
        if (perpAmtToMint <= 0) {
            return;
        }

        // Get the minting bond data
        IBondController depositBond = perp.getDepositBond();
        BondTranches memory bt = depositBond.getTranches();

        // NOTE: we use only the most senior tranche to mint perps
        ITranche tranche = bt.tranches[0];

        // Compute the senior tranche amount needed to mint perps.
        uint256 seniorAmtToDeposit = perpAmtToMint.mulDiv(
            perpPrice,
            perp_.computePrice(tranche),
            MathUpgradeable.Rounding.Up
        );

        // Tranche as needed
        uint256 seniorBal = tranche.balanceOf(address(this));
        uint256 seniorAmtToMint = (seniorAmtToDeposit > seniorBal) ? (seniorAmtToDeposit - seniorBal) : 0;
        if (seniorAmtToMint > 0) {
            _tranche(depositBond, bt, depositBond.estimateDepositAmt(seniorAmtToMint, bt.trancheRatios[0]));
        }

        // Mint perps as needed
        if (seniorAmtToDeposit > 0) {
            // NOTE: When the vault mints perps, it pays no fees.
            _checkAndApproveMax(tranche, address(perp_), seniorAmtToDeposit);
            perp_.deposit(tranche, seniorAmtToDeposit);
        }

        // sync holdings
        _syncAndRemoveDeployedAsset(tranche);
        _syncAsset(perp_);
    }

    /// @dev Given a bond and its tranche data, deposits the provided amount into the bond
    ///      and receives tranche tokens in return.
    ///      Additionally, performs some book-keeping to keep track of the vault's assets.
    function _tranche(
        IBondController bond,
        BondTranches memory bt,
        uint256 amount
    ) private {
        // Skip if amount is zero
        if (amount <= 0) {
            return;
        }

        // amount is tranched
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

    // @dev Transfers a the set fixed fee amount of underlying tokens to the owner.
    function _deductProtocolFee() private {
        underlying.safeTransfer(owner(), feePolicy.computeVaultDeploymentFee());
    }

    // @dev Enforces vault composition after swap and meld operations.
    function _enforceVaultComposition(uint256 tvlBefore) private {
        // Assert that the vault's TVL does not decrease after this operation
        uint256 tvlAfter = getTVL();
        if (tvlAfter < tvlBefore) {
            revert TVLDecreased();
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
}
