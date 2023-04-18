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
import { IVault, UnexpectedAsset, UnauthorizedTransferOut, NoDeployment } from "../_interfaces/IVault.sol";

// TODO: add mint cap
// TODO: limit size of vault assets

/// @notice Storage array access out of bounds.
error OutOfBounds();

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
 *              2) recover: The vault redeems tranches for the underlying asset.
 *                 NOTE: It performs both mature and immature redemption. Read more: https://bit.ly/3tuN6OC
 *
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
    uint8 public constant PERC_DECIMALS = 6;
    uint256 public constant UNIT_PERC = 10**PERC_DECIMALS;
    uint256 public constant HUNDRED_PERC = 100 * UNIT_PERC;

    /// @dev Initial exchange rate between the underlying asset and notes.
    uint256 private constant INITIAL_RATE = 10**6;

    /// @dev Values should line up as is in the perp contract.
    uint8 private constant PERP_PRICE_DECIMALS = 8;
    uint256 private constant PERP_UNIT_PRICE = (10**PERP_PRICE_DECIMALS);

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
    // Data

    /// @notice The perpetual token on which rollovers are performed.
    IPerpetualTranche public perp;

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
        __ERC20_init(name, symbol);
        __Ownable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        underlying = perp_.collateral();
        _syncAsset(underlying);

        require(underlying != perp_, "RolloverVault: unacceptable perp");
        perp = perp_;
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
    ///      Reverts if there are no funds to deploy.
    function deploy() public nonReentrant whenNotPaused {
        TrancheData memory td = _tranche(perp.getDepositBond());
        if (_rollover(perp, td) == 0) {
            revert NoDeployment();
        }
    }

    /// @inheritdoc IVault
    function recover() public nonReentrant whenNotPaused {
        _redeemTranches();
    }

    /// @inheritdoc IVault
    function deposit(uint256 amount) external override nonReentrant whenNotPaused returns (uint256) {
        uint256 totalSupply_ = totalSupply();
        uint256 notes = (totalSupply_ > 0) ? amount.mulDiv(totalSupply_, getTVL()) : (amount * INITIAL_RATE);

        underlying.safeTransferFrom(_msgSender(), address(this), amount);
        _syncAsset(underlying);

        _mint(_msgSender(), notes);
        return notes;
    }

    /// @inheritdoc IVault
    function redeem(uint256 notes) external override nonReentrant whenNotPaused returns (IVault.TokenAmount[] memory) {
        uint256 totalNotes = totalSupply();
        uint256 deployedCount_ = _deployed.length();
        uint256 assetCount = 2 + deployedCount_;

        // aggregating vault assets to be redeemed
        IVault.TokenAmount[] memory redemptions = new IVault.TokenAmount[](assetCount);
        redemptions[0].token = underlying;
        for (uint256 i = 0; i < deployedCount_; i++) {
            redemptions[i + 1].token = IERC20Upgradeable(_deployed.at(i));
        }
        redemptions[deployedCount_ + 1].token = IERC20Upgradeable(perp);

        // burn notes
        _burn(_msgSender(), notes);

        // calculating amounts and transferring assets out proportionally
        for (uint256 i = 0; i < assetCount; i++) {
            redemptions[i].amount = _calculateAssetShare(redemptions[i].token, notes, totalNotes);
            redemptions[i].token.safeTransfer(_msgSender(), redemptions[i].amount);
            _syncAsset(redemptions[i].token);
        }

        return redemptions;
    }

    /// @inheritdoc IVault
    /// @dev The total value is denominated in the underlying asset.
    function getTVL() public override returns (uint256) {
        uint256 totalAssets = 0;

        // The underlying balance
        totalAssets += underlying.balanceOf(address(this));

        // The deployed asset value denominated in the underlying
        for (uint256 i = 0; i < _deployed.length(); i++) {
            ITranche tranche = ITranche(_deployed.at(i));
            uint256 trancheBalance = tranche.balanceOf(address(this));
            if (trancheBalance > 0) {
                (uint256 collateralBalance, uint256 debt) = tranche.getTrancheCollateralization();
                totalAssets += trancheBalance.mulDiv(collateralBalance, debt);
            }
        }

        // The earned asset (perp token) value denominated in the underlying
        uint256 perpBalance = perp.balanceOf(address(this));
        if (perpBalance > 0) {
            // The "earned" asset is assumed to be the perp token.
            totalAssets += perpBalance.mulDiv(IPerpetualTranche(address(perp)).getAvgPrice(), PERP_UNIT_PRICE);
        }

        return totalAssets;
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
        return (token == underlying) || _deployed.contains(address(token)) || (address(perp) == address(token));
    }

    //--------------------------------------------------------------------------
    // Private write methods

    /// @dev Deposits underlying balance into the provided bond and receives tranche tokens in return.
    function _tranche(IBondController bond) private returns (TrancheData memory) {
        // Get bond's tranche data
        TrancheData memory td = bond.getTrancheData();

        // Get underlying balance
        uint256 balance = underlying.balanceOf(address(this));

        // Ensure initial deposit remains unspent
        if (balance == 0) {
            return td;
        }

        // balance is tranched
        underlying.approve(address(bond), balance);
        bond.deposit(balance);

        // sync holdings
        for (uint8 i = 0; i < td.trancheCount; i++) {
            _syncDeployedAsset(td.tranches[i]);
        }
        _syncAsset(underlying);

        return td;
    }

    /// @dev Rolls over freshly tranched tokens from the given bond for older tranches (close to maturity) from perp.
    /// @return The amount of perps rolled over.
    function _rollover(IPerpetualTranche perp_, TrancheData memory td) private returns (uint256) {
        // NOTE: The first element of the list is the mature tranche,
        //       there after the list is NOT ordered by maturity.
        IERC20Upgradeable[] memory rolloverTokens = perp_.getReserveTokensUpForRollover();

        // Batch rollover
        uint256 totalPerpRolledOver = 0;
        uint8 vaultTokenIdx = 0;
        uint256 perpTokenIdx = 0;

        // We pair tranche tokens held by the vault with tranche tokens held by perp,
        // And execute the rollover and continue to the next token with a usable balance.
        while (vaultTokenIdx < td.trancheCount && perpTokenIdx < rolloverTokens.length) {
            // trancheIntoPerp refers to the tranche going into perp from the vault
            ITranche trancheIntoPerp = td.tranches[vaultTokenIdx];

            // tokenOutOfPerp is the reserve token coming out of perp into the vault
            IERC20Upgradeable tokenOutOfPerp = rolloverTokens[perpTokenIdx];

            // compute available token out
            uint256 tokenOutAmtAvailable = address(tokenOutOfPerp) != address(0)
                ? tokenOutOfPerp.balanceOf(perp_.reserve())
                : 0;

            // trancheIntoPerp tokens are NOT exhausted but tokenOutOfPerp is exhausted
            if (tokenOutAmtAvailable == 0) {
                // Rollover is a no-op, so skipping to next tokenOutOfPerp
                perpTokenIdx++;
                continue;
            }

            // Compute available tranche in
            uint256 trancheInAmtAvailable = trancheIntoPerp.balanceOf(address(this));

            // trancheInAmtAvailable is exhausted
            if (trancheInAmtAvailable == 0) {
                // Rollover is a no-op, so skipping to next trancheIntoPerp
                vaultTokenIdx++;
                continue;
            }

            // Preview rollover
            IPerpetualTranche.RolloverPreview memory rd = perp_.computeRolloverAmt(
                trancheIntoPerp,
                tokenOutOfPerp,
                trancheInAmtAvailable,
                tokenOutAmtAvailable
            );

            // trancheIntoPerp isn't accepted by perp, likely because it's yield=0, refer perp docs for more info
            if (rd.perpRolloverAmt == 0) {
                // Rollover is a no-op, so skipping to next trancheIntoPerp
                vaultTokenIdx++;
                continue;
            }

            // Perform rollover
            trancheIntoPerp.approve(address(perp_), trancheInAmtAvailable);
            perp_.rollover(trancheIntoPerp, tokenOutOfPerp, trancheInAmtAvailable);

            // sync holdings
            _syncDeployedAsset(trancheIntoPerp);
            if (tokenOutOfPerp != underlying) {
                _syncDeployedAsset(tokenOutOfPerp);
            }
            _syncAsset(perp_);
            _syncAsset(underlying);

            // keep track of total amount rolled over
            totalPerpRolledOver += rd.perpRolloverAmt;
        }

        return totalPerpRolledOver;
    }

    /// @notice Redeems the deployed tranche tokens for the underlying asset.
    function _redeemTranches() private {
        uint256 deployedCount_ = _deployed.length();
        if (deployedCount_ <= 0) {
            return;
        }

        for (uint256 i = 0; i < deployedCount_; i++) {
            ITranche tranche = ITranche(_deployed.at(i));
            IBondController bond = IBondController(tranche.bond());

            // if bond has matured, redeem the tranche token
            if (bond.timeToMaturity() <= 0) {
                if (!bond.isMature()) {
                    bond.mature();
                }
                bond.redeemMature(address(tranche), tranche.balanceOf(address(this)));
            }
            // else redeem using proportional balances, redeems all tranches part of the bond
            else {
                TrancheData memory td;
                uint256[] memory trancheAmts;
                (td, trancheAmts) = bond.computeRedeemableTrancheAmounts(address(this));

                // NOTE: It is guaranteed that if one tranche amount is zero, all amounts are zeros.
                if (trancheAmts[0] == 0) {
                    continue;
                }

                bond.redeem(trancheAmts);
            }
        }

        // sync holdings
        // NOTE: We traverse the deployed set in the reverse order
        //       as deletions involve swapping the deleted element to the
        //       end of the set and removing the last element.
        for (uint256 i = deployedCount_; i > 0; i--) {
            _syncDeployedAsset(IERC20Upgradeable(_deployed.at(i - 1)));
        }
        _syncAsset(underlying);
    }

    /// @dev Logs the token balance held by the vault.
    /// @return The Vault's token balance.
    function _syncAsset(IERC20Upgradeable token) private returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        emit AssetSynced(token, balance);

        return balance;
    }

    /// @dev Syncs balance and keeps the deployed assets list up to date.
    /// @return The Vault's token balance.
    function _syncDeployedAsset(IERC20Upgradeable token) private returns (uint256) {
        uint256 balance = _syncAsset(token);
        bool isHeld = _deployed.contains(address(token));

        if (balance > 0 && !isHeld) {
            // Inserts new token into the deployed assets list.
            _deployed.add(address(token));
        }

        if (balance == 0 && isHeld) {
            // Removes token into the deployed assets list.
            _deployed.remove(address(token));
        }

        return balance;
    }

    //--------------------------------------------------------------------------
    // Private read methods

    /// @dev Computes the proportional share of the vault's asset token balance for a given amount of notes.
    function _calculateAssetShare(
        IERC20Upgradeable asset,
        uint256 notes,
        uint256 totalNotes
    ) private view returns (uint256) {
        return asset.balanceOf(address(this)).mulDiv(notes, totalNotes);
    }
}
