// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";

import { ERC20BurnableUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { TrancheData, TrancheHelpers, BondHelpers } from "../_utils/BondHelpers.sol";
import { IERC20Upgradeable, IPerpetualTranche, IBondIssuer, IBondController, ITranche } from "../_interfaces/IPerpetualTranche.sol";

/// @notice Expected usable balance to perform tranching.
error UnusableBalance();

/// @notice Expected tokens to be rolled over.
error ExpectedRollover();

/// @notice Expected transfer out asset to not be a reserve asset.
/// @param token Address of the token transferred.
error UnauthorizedTransferOut(IERC20Upgradeable token);

/*
 *  @title RolloverVault
 *
 *  @notice A vault which generates yield (from fees) by performing rollovers on PerpetualTranche.
 *
 *          Users deposit a "deposit asset" (like AMPL or any other rebasing collateral) for "shares".
 *
 *          The vault operates though two external poke which off-chain keepers can execute:
 *              1) trancheAndRollover: When executed, the vault "tranches" the deposit assets which it holds,
 *                 swaps these fresh tranches for near mature (or mature tranches) from the `PerpetualTranche`
 *                 system through a rollover operation.
 *
 *              2) redeemTranches: When executed, the vault redeems tranche tokens it holds for the deposit asset.
 *                 NOTE: it performs both mature and immature redemption. Read more: https://bit.ly/3tuN6OC
 *
 *          At any time the vault will hold a combination of the deposit asset tokens and multiple
 *          tranche tokens, together referred to as the vault's "holdings".
 *          On redemption users burn their "shares" to receive a proportional slice
 *          of all the holding tokens and generated yield.
 *
 *
 */
contract RolloverVault is
    ERC20BurnableUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    // data handling
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.AddressSet;
    using BondHelpers for IBondController;
    using TrancheHelpers for ITranche;

    // ERC20 operations
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // math
    using MathUpgradeable for uint256;

    //-------------------------------------------------------------------------
    // Events

    /// @notice Event emitted when the vault's new token balance is recorded after change.
    /// @param t Address of the token.
    /// @param balance The recorded ERC-20 balance of the token.
    event HoldingsSynced(IERC20Upgradeable t, uint256 balance);

    //-------------------------------------------------------------------------
    // Constants
    uint8 public constant PERC_DECIMALS = 6;
    uint256 public constant UNIT_PERC = 10**PERC_DECIMALS;
    uint256 public constant HUNDRED_PERC = 100 * UNIT_PERC;

    /// @dev Initial micro-deposit into the vault so that the totalSupply is never zero.
    uint256 public constant INITIAL_DEPOSIT = 10**9;

    //-------------------------------------------------------------------------
    // Data

    /// @notice Address of the perpetual tranche contract to be rolled over.
    IPerpetualTranche public immutable perp;

    /// @notice The minimum percentage of the vault's holdings to be held in the form as deposit asset tokens.
    //          The remaining are tranched and held as tranche tokens.
    uint256 public minCashPerc;

    //--------------------------------------------------------------------------
    // RESERVE

    /// @notice A record of all tokens (deposit asset and tranches) held by the vault.
    /// @dev `_holdings[0]` points to the deposit asset, ie) the rebasing ERC-20 token accepted by this vault.
    EnumerableSetUpgradeable.AddressSet private _holdings;

    //--------------------------------------------------------------------------
    // Construction & Initialization

    /// @notice Constructor to create the contract.
    /// @param perp_ ERC-20 address of the perpetual tranche contract.
    constructor(IPerpetualTranche perp_) {
        perp = perp_;
    }

    /// @notice Contract state initialization.
    /// @param initialRate Initial exchange rate between vault shares and assets for micro-deposit.
    /// @param name ERC-20 Name of the vault token.
    /// @param symbol ERC-20 Symbol of the vault token.
    function init(
        uint256 initialRate,
        string memory name,
        string memory symbol
    ) public initializer {
        __ERC20_init(name, symbol);
        __Ownable_init();

        // first mint
        IERC20Upgradeable depositAsset_ = perp.collateral();
        uint256 shares = initialRate * INITIAL_DEPOSIT;
        depositAsset_.safeTransferFrom(_msgSender(), address(this), INITIAL_DEPOSIT);
        _mint(address(this), shares);

        // NOTE: `_holdings[0]` always points to the deposit asset and is to be never updated.
        _holdings.add(address(depositAsset_));
        _updateHoldings(depositAsset_);
    }

    //--------------------------------------------------------------------------
    // ADMIN only methods

    /// @notice Pauses deposits, withdrawals and vault operations.
    /// @dev NOTE: ERC-20 functions, like transfers will always remain operational.
    function pause() public onlyOwner {
        _pause();
    }

    /// @notice Unpauses deposits, withdrawals and vault operations.
    /// @dev NOTE: ERC-20 functions, like transfers will always remain operational.
    function unpause() public onlyOwner {
        _unpause();
    }

    /// @notice Allows the owner to transfer non-core assets out of the vault if required.
    /// @param token The token address.
    /// @param to The destination address.
    /// @param amount The amount of tokens to be transferred.
    function transferERC20(
        IERC20Upgradeable token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (_holdings.contains(address(token)) || incomeAsset() == token) {
            revert UnauthorizedTransferOut(token);
        }
        token.safeTransfer(to, amount);
    }

    //--------------------------------------------------------------------------
    // External & Public write methods

    /// @notice Mints tranches and executes a rollover.
    /// @dev Mints tranches by depositing the deposit asset into the perpetual tranche contract's active minting bond.
    ///      Then executes a rollover operations to swap newly minted tranches for older tranches.
    function trancheAndRollover() external nonReentrant whenNotPaused {
        // TODO: call `redeemTranches()` here to ensure no denial of service?

        IERC20Upgradeable depositAsset_ = depositAsset();

        // Calculate usable balance
        uint256 usableBalance = depositAsset_.balanceOf(address(this)).min(
            (HUNDRED_PERC - minCashPerc).mulDiv(totalAssets(), UNIT_PERC, MathUpgradeable.Rounding.Down)
        );

        // Ensure usable balance before tranching
        if (usableBalance == 0) {
            revert UnusableBalance();
        }

        // Collateral is tranched
        IBondController depositBond = perp.getDepositBond();
        TrancheData memory td = depositBond.getTrancheData();
        _checkAndApproveMax(depositAsset_, address(depositBond), usableBalance);
        depositBond.deposit(usableBalance);

        // Tokens up for rollover
        IERC20Upgradeable[] memory rolloverTokens = perp.getReserveTokensUpForRollover();

        // For each tranche token, and each token up for rollover
        uint256 totalAmtRolledOver = 0;
        uint8 i = 0;
        uint8 j = 0;
        while (i < td.trancheCount && j < rolloverTokens.length) {
            ITranche trancheIn = td.tranches[i];
            IERC20Upgradeable tokenOut = rolloverTokens[j];

            // Compute available amounts
            uint256 trancheInAmtAvailable = trancheIn.balanceOf(address(this));
            uint256 tokenOutAmtAvailable = address(tokenOut) != address(0) ? tokenOut.balanceOf(perp.reserve()) : 0;

            // no more trancheIn tokens remaining, move on to the next
            if (trancheInAmtAvailable == 0) {
                i++;
                continue;
            }

            //  no more tokens to rollover, move on to the next
            if (tokenOutAmtAvailable == 0) {
                j++;
                continue;
            }

            // Preview rollover
            IPerpetualTranche.RolloverPreview memory rd = perp.computeRolloverAmt(
                trancheIn,
                tokenOut,
                trancheInAmtAvailable,
                tokenOutAmtAvailable
            );

            // trancheIn isn't accepted, move on to the next
            if (rd.perpRolloverAmt == 0) {
                i++;
                continue;
            }

            
            // TODO: handle case when fees need to paid by the vault for rolling over
            // _checkAndApproveMax(incomeAsset(), address(perp), type(uint256).max);

            // Perform rollover
            _checkAndApproveMax(trancheIn, address(perp), rd.trancheInAmt);
            perp.rollover(trancheIn, tokenOut, rd.trancheInAmt);
            totalAmtRolledOver += rd.perpRolloverAmt;

            // update holdings
            _updateHoldings(trancheIn);
            _updateHoldings(tokenOut);
        }

        // update holdings
        _updateHoldings(depositAsset_);

        // ensure rollover executed
        if (totalAmtRolledOver == 0) {
            revert ExpectedRollover();
        }
    }

    /// @notice Redeems tranche tokens held by the vault for deposit asset tokens.
    function redeemTranches() external nonReentrant whenNotPaused {
        // NOTE: we skip can _holdings[0], i.e the deposit asset.
        for (uint256 i = 1; i < _holdings.length(); i++) {
            ITranche tranche = ITranche(_holdings.at(i));
            IBondController bond = IBondController(tranche.bond());

            // if bond has mature
            if (bond.timeToMaturity() == 0) {
                redeemMatureTranches(bond);
            }
            // else redeem using proportional balances
            else {
                redeemTranches(bond);
            }
        }
    }

    /// @notice Redeems the mature tranche tokens held by the vault for deposit asset tokens.
    /// @param bond The address of the bond to redeem from.
    /// @dev Reverts if tranche's parent bond is not mature.
    function redeemMatureTranches(IBondController bond) public nonReentrant whenNotPaused {
        if (!bond.isMature()) {
            bond.mature();
        }
        TrancheData memory td = bond.getTrancheData();
        for (uint8 i = 0; i < td.trancheCount; i++) {
            bond.redeemMature(address(td.tranches[i]), td.tranches[i].balanceOf(address(this)));
            _updateHoldings(td.tranches[i]);
        }
        _updateHoldings(depositAsset());
    }

    /// @notice Redeems the tranche tokens before maturity,
    ///         if the vault holds all tranche tokens in the required proportions.
    /// @param bond The address of the bond to redeem.
    function redeemTranches(IBondController bond) public nonReentrant whenNotPaused {
        TrancheData memory td;
        uint256[] memory trancheAmts;
        (td, trancheAmts) = bond.computeRedeemableTrancheAmounts(address(this));

        // NOTE: Its guaranteed that if one tranche amount is zero, all amounts are zeros.
        if (trancheAmts[0] == 0) {
            return;
        }

        bond.redeem(trancheAmts);
        for (uint8 i = 0; i < td.trancheCount; i++) {
            _updateHoldings(td.tranches[i]);
        }
        _updateHoldings(depositAsset());
    }

    /// @notice Deposits the deposit asset tokens from {msg.sender} into the vault and mints vault shares.
    /// @param assets The amount of deposit asset tokens to be deposited into the vault.
    function deposit(uint256 assets) external nonReentrant whenNotPaused {
        uint256 shares = convertToShares(assets);

        depositAsset().safeTransferFrom(_msgSender(), address(this), assets);
        _mint(_msgSender(), shares);
    }

    /// @notice Burns shares and sends deposit asset tokens, other holdings and income tokens back to {msg.sender}.
    /// @param shares The amount of vault shares to be burnt.
    function redeem(uint256 shares) external nonReentrant whenNotPaused {
        (IERC20Upgradeable[] memory tokens, uint256[] memory amounts) = convertToAssets(shares);

        _burn(_msgSender(), shares);

        // Transfer out share of all holdings
        for (uint256 i = 0; i < tokens.length; i++) {
            if (address(tokens[i]) != address(0)) {
                tokens[i].safeTransfer(_msgSender(), amounts[i]);
            }
        }
    }

    //--------------------------------------------------------------------------
    // External & Public read methods

    /// @notice Reference to the deposit asset.
    /// @return Address of the deposit asset.
    function depositAsset() public view returns (IERC20Upgradeable) {
        return IERC20Upgradeable(_holdings.at(0));
    }

    /// @notice Computes the amount of shares minted for a given number of deposit assets.
    /// @return The amount of shares.
    function convertToShares(uint256 assets) public view returns (uint256) {
        return _convertToShares(assets, totalAssets(), totalSupply(), MathUpgradeable.Rounding.Down);
    }

    /// @notice Computes the value redeemable denominated in deposit assets for a given number of shares.
    /// @return The value of assets redeemable.
    function convertToAssetValue(uint256 shares) public view returns (uint256) {
        return _convertToAssetVaule(shares, totalAssets(), totalSupply(), MathUpgradeable.Rounding.Down);
    }

    /// @notice Computes the amount of holding assets redeemable for a given number of shares.
    /// @return The list of tokens to be redeemed and amounts.
    function convertToAssets(uint256 shares) public view returns (IERC20Upgradeable[] memory, uint256[] memory) {
        uint256 totalSupply_ = totalSupply();

        IERC20Upgradeable[] memory tokens = new IERC20Upgradeable[](_holdings.length() + 1);
        uint256[] memory amounts = new uint256[](_holdings.length() + 1);

        // compute share of all holdings
        uint256 i;
        for (i = 0; i < _holdings.length(); i++) {
            tokens[i] = IERC20Upgradeable(_holdings.at(i));
            amounts[i] = tokens[i].balanceOf(address(this)).mulDiv(shares, totalSupply_, MathUpgradeable.Rounding.Down);
        }

        // compute share of income asset
        IERC20Upgradeable incomeAsset_ = incomeAsset();
        if (!_holdings.contains(address(incomeAsset_))) {
            tokens[i] = incomeAsset_;
            amounts[i] = incomeAsset_.balanceOf(address(this)).mulDiv(
                shares,
                totalSupply_,
                MathUpgradeable.Rounding.Down
            );
        }

        return (tokens, amounts);
    }

    /// @notice Total value of assets currently held by the vault denominated in the deposit asset.
    /// @dev At any time the vault holds a combination of the deposit asset and
    ///      multiple tranche tokens. Tranche tokens are priced based on the number of
    ///      deposit asset each tranche token is redeemable for at maturity. The total value
    ///      is computed as the balance weighted sum of price of all the holding tokens.
    function totalAssets() public view returns (uint256) {
        uint256 totalAssets_ = depositAsset().balanceOf(address(this));
        for (uint256 i = 1; i < _holdings.length(); i++) {
            ITranche tranche = ITranche(_holdings.at(i));
            uint256 trancheBalance = tranche.balanceOf(address(this));
            (uint256 collateralBalance, uint256 debt) = tranche.getTrancheCollateralization();
            totalAssets_ += trancheBalance.mulDiv(collateralBalance, debt, MathUpgradeable.Rounding.Down);
        }
        return totalAssets_;
    }

    /// @notice ERC-20 token in which rollover rewards are paid out.
    /// @return Address of the token.
    function incomeAsset() public view returns (IERC20Upgradeable) {
        return perp.feeToken();
    }

    /// @notice Total income generated by the vault currently held in the reserve.
    /// @return Vaults income token balance.
    function totalIncome() public view returns (uint256) {
        return incomeAsset().balanceOf(address(this));
    }

    /// @notice Total count of tokens held by the vault.
    /// @return The total number of tokens held by the vault.
    function holdingsCount() public view returns (uint256) {
        return _holdings.length();
    }

    /// @notice The address form the token holdings list by index.
    /// @param index The index of a token.
    /// @return The address of the token.
    function holdingsAt(uint256 index) public view returns (IERC20Upgradeable) {
        return IERC20Upgradeable(_holdings.at(index));
    }

    /// @notice Checks if the given token is held by the vault.
    /// @param token The address of a token to check.
    function isInHoldings(IERC20Upgradeable token) public view returns (bool) {
        return _holdings.contains(address(token));
    }

    //--------------------------------------------------------------------------
    // Private write methods

    /// @dev Keeps the reserve storage up to date. Logs the token balance held by the reserve.
    /// @return The Reserve's token balance.
    function _updateHoldings(IERC20Upgradeable token) private returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        emit HoldingsSynced(token, balance);

        // If token is the deposit asset,
        // it NEVER gets removed from the `_holdings` list.
        if (token == depositAsset()) {
            return balance;
        }

        // Otherwise `_holdings` list gets updated.
        bool isHeld = _holdings.contains(address(token));
        if (balance > 0 && !isHeld) {
            // Inserts new tranche into reserve list.
            _holdings.add(address(token));
        }

        if (balance == 0 && isHeld) {
            // Removes tranche from reserve list.
            _holdings.remove(address(token));
        }

        return balance;
    }

    /// @dev Approves the spender to spend an infinite tokens from the reserve's balance.
    // NOTE: Only audited & immutable spender contracts should have infinite approvals.
    function _checkAndApproveMax(
        IERC20Upgradeable token,
        address spender,
        uint256 amount
    ) private {
        if (token.allowance(address(this), spender) < amount) {
            token.approve(spender, type(uint256).max);
        }
    }

    //--------------------------------------------------------------------------
    // Private read methods

    /// @dev Computes the amount of shares that the vault would exchange for the amount of deposit asset provided.
    function _convertToShares(
        uint256 assets,
        uint256 totalAssets_,
        uint256 totalSupply_,
        MathUpgradeable.Rounding rounding
    ) private pure returns (uint256) {
        return assets.mulDiv(totalSupply_, totalAssets_, rounding);
    }

    /// @dev Computes the value in deposit assets that the vault would exchange for the amount of shares provided.
    function _convertToAssetVaule(
        uint256 shares,
        uint256 totalAssets_,
        uint256 totalSupply_,
        MathUpgradeable.Rounding rounding
    ) private pure returns (uint256) {
        return shares.mulDiv(totalAssets_, totalSupply_, rounding);
    }
}
