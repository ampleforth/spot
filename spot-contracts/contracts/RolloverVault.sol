// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { IERC20Upgradeable, IPerpetualTranche, IBondController, ITranche, IBalancer } from "./_interfaces/IPerpetualTranche.sol";
import { IRolloverVault, IVault } from "./_interfaces/IRolloverVault.sol";
import { TokenAmount, RolloverData } from "./_interfaces/CommonTypes.sol";
import { UnauthorizedCall, UnauthorizedTransferOut, UnexpectedAsset, OutOfBounds, UnacceptableSwap, InsufficientDeployment, DeployedCountOverLimit, LiquidityOutOfBounds, InvalidRange, UnacceptableDeposit } from "./_interfaces/ProtocolErrors.sol";

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

    // math
    using MathUpgradeable for uint256;

    //-------------------------------------------------------------------------
    // Events

    /// @notice Emits the vault asset's token balance that's recorded after a change.
    /// @param token Address of token.
    /// @param balance The recorded ERC-20 balance of the token.
    event AssetSynced(IERC20Upgradeable token, uint256 balance);

    //-------------------------------------------------------------------------
    // Constants & Immutables

    /// @dev Internal percentages are fixed point numbers with {PERC_DECIMALS} places.
    uint8 public constant PERC_DECIMALS = 8;
    uint256 public constant ONE = (10 ** PERC_DECIMALS); // 1.0 or 100%

    /// @dev Initial exchange rate between the underlying asset and notes.
    uint256 private constant INITIAL_RATE = 10 ** 6;

    /// @dev The maximum number of deployed assets that can be held in this vault at any given time.
    uint8 public constant MAX_DEPLOYED_COUNT = 47;

    // Replicating value used here:
    // https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 private constant TRANCHE_RATIO_GRANULARITY = 1000;

    /// @dev Immature redemption may result in some dust tranches when balances are not perfectly divisible by the tranche ratio.
    ///      Based on current the implementation of `computeRedeemableTrancheAmounts`,
    ///      the dust balances which remain after immature redemption will be *at most* {TRANCHE_RATIO_GRANULARITY} or 1000.
    ///      We exclude the vault's dust tranche balances from TVL computation, note redemption and
    ///      during recovery (through recurrent immature redemption).
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
    // Storage

    /// @notice Minimum amount of underlying assets that must be deployed, for a deploy operation to succeed.
    /// @dev The deployment transaction reverts, if the vaults does not have sufficient underlying tokens
    ///      to cover the minimum deployment amount.
    uint256 public minDeploymentAmt;

    /// @notice The perpetual token on which rollovers are performed.
    IPerpetualTranche public perp;

    //--------------------------------------------------------------------------
    // v2.0.0 STORAGE ADDITION

    /// @notice External contract that orchestrates external interactions with the spot protocol.
    /// @custom:oz-upgrades-renamed-from feePolicy
    IBalancer public balancer;

    /// @notice Reference to the address that has the ability to pause/unpause operations.
    /// @dev The keeper is meant for time-sensitive operations, and may be different from the owner address.
    /// @return The address of the keeper.
    address public keeper;

    /// @notice The enforced minimum absolute balance of underlying tokens to be held by the vault.
    /// @dev On deployment only the delta greater than this balance is deployed.
    ///      `minUnderlyingBal` is enforced on deployment and swapping operations which reduce the underlying balance.
    ///      This parameter ensures that the vault's tvl is never too low, which guards against the "share" manipulation attack.
    uint256 public minUnderlyingBal;

    /// @notice The enforced minimum percentage of the "maximum rollover amount" to be held as underlying tokens.
    /// @dev The maximum rollover amount is calculated as the amount of underlying tokens required to rollover
    ///      the entire supply of perp. The percentage minimum is enforced after swaps which change the vault's underlying token liquidity.
    ///      This ensures that the vault has sufficient liquid underlying tokens for upcoming rollovers.
    /// @custom:oz-upgrades-renamed-from minUnderlyingPerc
    uint256 public minRolloverAmtPerc;

    /// @notice The enforced maximum percentage of the "maximum rollover amount" to be held as underlying tokens.
    /// @dev The maximum rollover amount is calculated as the amount of underlying tokens required to rollover
    ///      the entire supply of perp. The percentage maximum is enforced after swaps which change the vault's underlying token liquidity.
    ///      This ensures that the vault doesn't have too much idle capital.
    uint256 public maxRolloverAmtPerc;

    //--------------------------------------------------------------------------
    // Modifiers

    /// @dev Throws if called by any account other than the keeper.
    modifier onlyKeeper() {
        if (msg.sender != keeper) {
            revert UnauthorizedCall();
        }
        _;
    }

    /// @dev Throws if called not called by the balancer.
    modifier onlyBalancer() {
        if (address(balancer) != msg.sender) {
            revert UnauthorizedCall();
        }
        _;
    }

    /// @dev Redeem intermediate tranches if possible.
    modifier onAfterRecover() {
        recover();
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
    function init(string memory name, string memory symbol, IPerpetualTranche perp_) external initializer {
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

        // set keeper reference
        updateKeeper(owner());

        // setting initial parameter values
        updateMinDeploymentAmt(0);
        updateLiquidityLimits(0, 0, type(uint256).max);

        // sync underlying
        _syncAsset(underlying);
    }

    //--------------------------------------------------------------------------
    // Owner only methods

    /// @notice Update the reference to the balancer contract.
    /// @param balancer_ New strategy address.
    function updateBalancer(IBalancer balancer_) external onlyOwner {
        balancer = balancer_;
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

    /// @notice Updates the minimum deployment amount requirement.
    /// @param minDeploymentAmt_ The new minimum deployment amount, denominated in underlying tokens.
    function updateMinDeploymentAmt(uint256 minDeploymentAmt_) public onlyKeeper {
        minDeploymentAmt = minDeploymentAmt_;
    }

    /// @notice Updates the underlying liquidity requirement.
    /// @param minUnderlyingBal_ The new minimum underlying balance.
    /// @param minRolloverAmtPerc_ The new minimum rollover amount percentage.
    /// @param maxRolloverAmtPerc_ The new maximum rollover amount percentage.
    function updateLiquidityLimits(
        uint256 minUnderlyingBal_,
        uint256 minRolloverAmtPerc_,
        uint256 maxRolloverAmtPerc_
    ) public onlyKeeper {
        if (minRolloverAmtPerc_ > maxRolloverAmtPerc_) {
            revert InvalidRange();
        }
        minUnderlyingBal = minUnderlyingBal_;
        minRolloverAmtPerc = minRolloverAmtPerc_;
        maxRolloverAmtPerc = maxRolloverAmtPerc_;
    }

    //--------------------------------------------------------------------------
    // Balancer only methods

    /// @inheritdoc IVault
    function deposit(
        uint256 underlyingAmtIn
    ) external override onlyBalancer nonReentrant whenNotPaused returns (uint256) {
        uint256 notes = computeMintAmt(underlyingAmtIn);
        if (underlyingAmtIn <= 0 || notes <= 0) {
            return 0;
        }

        // transfer underlying tokens in
        underlying.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // mint notes
        _mint(msg.sender, notes);

        // sync underlying
        _syncAsset(underlying);
        return notes;
    }

    /// @inheritdoc IRolloverVault
    function deposit(
        ITranche trancheIn,
        uint256 trancheInAmt
    ) external override onlyBalancer nonReentrant whenNotPaused returns (uint256) {
        // Vault only accepts the current deposit bond's junior tranche
        IBondController depositBond = perp.depositBond();
        if (trancheIn != depositBond.juniorTranche()) {
            revert UnacceptableDeposit();
        }

        uint256 notes = computeMintAmt(trancheIn, trancheInAmt);
        if (trancheInAmt <= 0 || notes <= 0) {
            return 0;
        }

        // transfer tranches in
        trancheIn.safeTransferFrom(msg.sender, address(this), trancheInAmt);

        // mint notes
        _mint(msg.sender, notes);

        // sync tranche
        _syncDeployedAsset(trancheIn);
        return notes;
    }

    /// @inheritdoc IVault
    function redeem(
        uint256 notes
    ) external override onlyBalancer onAfterRecover nonReentrant whenNotPaused returns (TokenAmount[] memory) {
        if (notes <= 0) {
            return new TokenAmount[](0);
        }

        TokenAmount[] memory redemptions = computeRedemptionAmts(notes);

        // burn notes
        _burn(msg.sender, notes);

        // transfer assets out
        for (uint8 i = 0; i < redemptions.length; i++) {
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

    /// @notice Allows users to swap their underlying tokens for perps held by the vault.
    /// @param underlyingAmtIn The amount of underlying tokens swapped in.
    /// @return The amount of perp tokens swapped out.
    /// @dev Callers should call `recover` before executing `swapUnderlyingForPerps` to maximize vault liquidity.
    function swapUnderlyingForPerps(
        uint256 underlyingAmtIn
    ) external onlyBalancer nonReentrant whenNotPaused returns (uint256) {
        IERC20Upgradeable underlying_ = underlying;
        IPerpetualTranche perp_ = perp;

        uint256 perpSupply = perp_.totalSupply();
        uint256 perpTVL = perp_.getTVL();
        uint256 perpAmtOut = underlyingAmtIn.mulDiv(perpSupply, perpTVL);

        // Revert if insufficient tokens are swapped in or out
        if (perpAmtOut <= 0 || underlyingAmtIn <= 0) {
            revert UnacceptableSwap();
        }

        // transfer underlying in
        underlying_.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // tranche and mint perps as needed
        uint256 depositTrancheTR = perp.depositTrancheRatio();
        _trancheAndMintPerps(perp_, underlying_, perpTVL, perpSupply, perpAmtOut, depositTrancheTR);

        // transfer remaining perps out to the user
        IERC20Upgradeable(address(perp_)).safeTransfer(msg.sender, perpAmtOut);

        // NOTE: In case this operation mints slightly more perps than that are required for the swap,
        // The vault continues to hold the perp dust until the subsequent `swapPerpsForUnderlying` or manual `recover(perp)`.

        // sync underlying
        _syncAsset(underlying_);

        // Revert if vault liquidity is out of bounds.
        // Swap uses vault's underlying tokens to mint perps, thus underlying liquidity reduces.
        _enforceUnderlyingLiquidity(underlying_, perpTVL, depositTrancheTR, true);

        return perpAmtOut;
    }

    /// @notice Allows users to swap their perp tokens for underlying tokens held by the vault.
    /// @param perpAmtIn The amount of perp tokens swapped in.
    /// @return The amount of underlying tokens swapped out.
    function swapPerpsForUnderlying(
        uint256 perpAmtIn
    ) external onlyBalancer nonReentrant whenNotPaused returns (uint256) {
        // Calculates the fee adjusted underlying amount to transfer to the user.
        IPerpetualTranche perp_ = perp;
        IERC20Upgradeable underlying_ = underlying;

        uint256 perpTVL = perp_.getTVL();
        uint256 underlyingAmtOut = perpAmtIn.mulDiv(perpTVL, perp_.totalSupply());

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

        // sync underlying
        _syncAsset(underlying_);

        // Revert if vault liquidity is out of bounds.
        // Swap frees up vault's underlying tokens, thus underlying liquidity increases.
        _enforceUnderlyingLiquidity(underlying_, perpTVL, perp.depositTrancheRatio(), false);

        return underlyingAmtOut;
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

        // `minUnderlyingBal` worth of underlying liquidity is excluded from the usable balance
        uint256 usableBal = underlying_.balanceOf(address(this));
        if (usableBal <= minUnderlyingBal) {
            revert LiquidityOutOfBounds();
        }
        usableBal -= minUnderlyingBal;

        // We ensure that at-least `minDeploymentAmt` amount of underlying tokens are deployed
        if (usableBal <= minDeploymentAmt) {
            revert InsufficientDeployment();
        }

        // We tranche all the underlying held by the vault to create seniors and juniors
        _tranche(perp_.depositBond(), underlying_, usableBal);

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
        if (deployedCount_ <= 0) {
            return;
        }

        // execute redemption on each deployed asset
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
            // In case the vault holds perp tokens after swaps or if transferred in erroneously,
            // anyone can execute this function to recover perps into tranches.
            // This is not part of the regular recovery flow.
            _meldPerps(perp_);
            _syncAsset(perp_);
            _syncAsset(underlying);
            return;
        }
        revert UnexpectedAsset();
    }

    /// @inheritdoc IVault
    function sync(IERC20Upgradeable token) public override nonReentrant whenNotPaused onlyBalancer {
        if (!isVaultAsset(token)) {
            revert UnexpectedAsset();
        }
        _syncAsset(token);
    }

    //--------------------------------------------------------------------------
    // External & Public read methods

    /// @inheritdoc IRolloverVault
    function deviationRatio() external view override returns (uint256) {
        return balancer.deviationRatio();
    }

    /// @inheritdoc IVault
    /// @dev The asset value is denominated in the underlying asset.
    function vaultAssetValue(IERC20Upgradeable token) external view override returns (uint256) {
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
    function computeMintAmt(uint256 underlyingAmtIn) public view override returns (uint256) {
        uint256 noteSupply = totalSupply();
        uint256 notes = (noteSupply > 0)
            ? noteSupply.mulDiv(underlyingAmtIn, getTVL())
            : (underlyingAmtIn * INITIAL_RATE);
        return notes;
    }

    /// @inheritdoc IRolloverVault
    function computeMintAmt(ITranche trancheIn, uint256 trancheInAmt) public view override returns (uint256) {
        uint256 noteSupply = totalSupply();
        uint256 valueIn = _computeVaultTrancheValue(trancheIn, underlying, trancheInAmt);
        uint256 notes = (noteSupply > 0) ? noteSupply.mulDiv(valueIn, getTVL()) : (valueIn * INITIAL_RATE);
        return notes;
    }

    /// @inheritdoc IVault
    function computeRedemptionAmts(uint256 noteAmtBurnt) public view override returns (TokenAmount[] memory) {
        uint256 noteSupply = totalSupply();
        uint8 assetCount_ = 1 + uint8(_deployed.length());

        // aggregating vault assets to be redeemed
        TokenAmount[] memory redemptions = new TokenAmount[](assetCount_);

        // underlying share to be redeemed
        IERC20Upgradeable underlying_ = underlying;
        redemptions[0] = TokenAmount({
            token: underlying_,
            amount: underlying_.balanceOf(address(this)).mulDiv(noteAmtBurnt, noteSupply)
        });

        for (uint8 i = 1; i < assetCount_; i++) {
            // tranche token share to be redeemed
            IERC20Upgradeable token = IERC20Upgradeable(_deployed.at(i - 1));
            redemptions[i] = TokenAmount({
                token: token,
                amount: token.balanceOf(address(this)).mulDiv(noteAmtBurnt, noteSupply)
            });

            // in case the redemption amount is just dust, we skip
            if (redemptions[i].amount < TRANCHE_DUST_AMT) {
                redemptions[i].amount = 0;
            }
        }

        return redemptions;
    }

    /// @inheritdoc IVault
    /// @dev The total value is denominated in the underlying asset.
    function getTVL() public view override returns (uint256) {
        // The underlying balance
        uint256 totalValue = underlying.balanceOf(address(this));

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
    function isVaultAsset(IERC20Upgradeable token) public view override returns (bool) {
        return token == underlying || _deployed.contains(address(token));
    }

    //--------------------------------------------------------------------------
    // Private write methods

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
            _execMatureTrancheRedemption(bond, tranche, trancheBalance);

            // sync deployed asset
            _syncDeployedAsset(tranche);
        }
        // if not redeem using proportional balances
        // redeems this tranche and it's siblings if the vault holds balances.
        // We skip if the tranche balance is too low as immature redemption will be a no-op.
        else if (trancheBalance > TRANCHE_DUST_AMT) {
            // execute redemption
            BondTranches memory bt = bond.getTranches();
            _execImmatureTrancheRedemption(bond, bt);

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
        uint256 perpSupply,
        uint256 perpAmtToMint,
        uint256 depositTrancheTR
    ) private {
        // Tranche as needed
        IBondController depositBond = perp_.depositBond();
        ITranche trancheIntoPerp = perp_.depositTranche();

        (uint256 underylingAmtToTranche, uint256 seniorAmtToDeposit) = PerpHelpers.estimateUnderlyingAmtToTranche(
            PerpHelpers.MintEstimationParams({
                perpTVL: perpTVL,
                perpSupply: perpSupply,
                depositBondCollateralBalance: depositBond.collateralBalance(),
                depositBondTotalDebt: depositBond.totalDebt(),
                depositTrancheSupply: trancheIntoPerp.totalSupply(),
                depositTrancheTR: depositTrancheTR
            }),
            perpAmtToMint
        );
        _tranche(depositBond, underlying_, underylingAmtToTranche);

        // Mint perps
        _checkAndApproveMax(trancheIntoPerp, address(perp_), seniorAmtToDeposit);
        perp_.deposit(trancheIntoPerp, seniorAmtToDeposit);

        // sync holdings
        _syncDeployedAsset(trancheIntoPerp);
    }

    /// @dev Given a bond and its tranche data, deposits the provided amount into the bond
    ///      and receives tranche tokens in return.
    ///      Performs some book-keeping to keep track of the vault's assets.
    function _tranche(IBondController bond, IERC20Upgradeable underlying_, uint256 underlyingAmt) private {
        // Get bond tranches
        BondTranches memory bt = bond.getTranches();

        // amount is tranched
        _checkAndApproveMax(underlying_, address(bond), underlyingAmt);
        bond.deposit(underlyingAmt);

        // sync holdings
        _syncDeployedAsset(bt.tranches[0]);
        _syncDeployedAsset(bt.tranches[1]);
    }

    /// @dev Rolls over freshly tranched tokens from the given bond for older tranches (close to maturity) from perp.
    ///      Redeems intermediate tranches for underlying if possible.
    ///      Performs some book-keeping to keep track of the vault's assets.
    /// @return Flag indicating if any tokens were rolled over.
    function _rollover(IPerpetualTranche perp_, IERC20Upgradeable underlying_) private returns (bool) {
        // NOTE: The first element of the list is the mature tranche,
        //       there after the list is NOT ordered by maturity.
        IERC20Upgradeable[] memory rolloverTokens = perp_.reserveTokensUpForRollover();

        // Batch rollover
        bool rollover = false;

        // We query perp's current deposit tranche
        ITranche trancheIntoPerp = perp_.depositTranche();

        // Compute available tranche in to rollover
        uint256 trancheInAmtAvailable = trancheIntoPerp.balanceOf(address(this));

        // Approve once for all rollovers
        _checkAndApproveMax(trancheIntoPerp, address(perp_), trancheInAmtAvailable);

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

    /// @dev Low level method that redeems the given mature tranche for the underlying asset.
    ///      It interacts with the button-wood bond contract.
    ///      This function should NOT be called directly, use `recover()` or `_redeemTranche(tranche)`
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
            bond.safeRedeemImmature(trancheAmts);
        }
    }

    /// @dev Syncs balance and updates the deployed list based on the vault's token balance.
    function _syncDeployedAsset(IERC20Upgradeable token) private {
        uint256 balance = token.balanceOf(address(this));
        emit AssetSynced(token, balance);

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
    function _syncAsset(IERC20Upgradeable token) private {
        emit AssetSynced(token, token.balanceOf(address(this)));
    }

    /// @dev Checks if the spender has sufficient allowance. If not, approves the maximum possible amount.
    function _checkAndApproveMax(IERC20Upgradeable token, address spender, uint256 amount) private {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance < amount) {
            token.safeApprove(spender, type(uint256).max);
        }
    }

    //--------------------------------------------------------------------------
    // Private methods

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

    /// @dev Checks if the vault's underlying balance is above admin defined constraints.
    ///      - Absolute balance is strictly greater than `minUnderlyingBal`.
    ///      - Ratio of the balance to the `maxRolloverAmt` is strictly greater than `minRolloverAmtPerc`.
    ///      - Ratio of the balance to the `maxRolloverAmt` is strictly lesser than `maxRolloverAmtPerc`.
    ///      NOTE: We assume the vault TVL and the underlying to have the same base denomination.
    function _enforceUnderlyingLiquidity(
        IERC20Upgradeable underlying_,
        uint256 perpTVL,
        uint256 seniorTR,
        bool isLiquidityReducing
    ) private view {
        uint256 underlyingBal = underlying_.balanceOf(address(this));
        if (underlyingBal <= minUnderlyingBal) {
            revert LiquidityOutOfBounds();
        }

        // We calculate the maximum amount of underlying tokens
        // required to rollover the entire perp supply.
        uint256 maxRolloverAmt = perpTVL.mulDiv(TRANCHE_RATIO_GRANULARITY - seniorTR, seniorTR);
        uint256 rolloverAmtPerc = ONE.mulDiv(underlyingBal, maxRolloverAmt);
        if (isLiquidityReducing && rolloverAmtPerc <= minRolloverAmtPerc) {
            revert LiquidityOutOfBounds();
        } else if (!isLiquidityReducing && rolloverAmtPerc >= maxRolloverAmtPerc) {
            revert LiquidityOutOfBounds();
        }
    }
}
