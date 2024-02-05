// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20MetadataUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";
import { IERC20Upgradeable, IPerpetualTranche, IBondIssuer, IFeePolicy, IBondController, ITranche } from "./_interfaces/IPerpetualTranche.sol";
import { IRolloverVault } from "./_interfaces/IRolloverVault.sol";
import { TokenAmount, RolloverData, SubscriptionParams } from "./_interfaces/CommonTypes.sol";
import { UnauthorizedCall, UnauthorizedTransferOut, UnacceptableReference, UnexpectedDecimals, UnexpectedAsset, UnacceptableDeposit, UnacceptableRedemption, UnacceptableParams, UnacceptableRollover, ExceededMaxSupply, ExceededMaxMintPerTranche } from "./_interfaces/ProtocolErrors.sol";

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";
import { ERC20BurnableUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { BondHelpers } from "./_utils/BondHelpers.sol";
import { TrancheHelpers } from "./_utils/TrancheHelpers.sol";

/**
 *  @title PerpetualTranche
 *
 *  @notice An opinionated implementation of a perpetual note ERC-20 token contract, backed by buttonwood tranches.
 *
 *          Perpetual note tokens (or perps for short) are backed by senior tranche tokens (aka seniors) held in this contract's reserve.
 *          Users can mint perps by depositing seniors into the reserve.
 *          They can redeem tokens from the reserve by burning their perps.
 *
 *          The whitelisted bond issuer issues new deposit bonds periodically based on a predefined frequency.
 *          Users can ONLY mint perps for seniors belonging to the active "deposit" bond.
 *          Users can burn perps, and redeem a proportional share of tokens held in the reserve.
 *
 *          Once seniors held in the reserve mature, the underlying collateral is extracted
 *          into the reserve. At any time, the reserve holds at most 2 classes of tokens
 *          i.e) the seniors and the underlying collateral.
 *
 *          Incentivized parties can "rollover" tranches approaching maturity or the underlying collateral,
 *          for newer seniors (which expire further out in the future) that belong to the updated "depositBond".
 *
 *          The time dependent system state is updated "lazily" without a need for an explicit poke
 *          from the outside world. Every external function that deals with the reserve
 *          invokes the `afterStateUpdate` modifier at the entry-point.
 *          This brings the system storage state up to date.
 *
 *          CRITICAL: On the 3 main system operations: deposit, redeem and rollover;
 *          We first compute fees before executing any transfers in or out of the system.
 *          The ordering of operations is very important as the fee computation logic,
 *          requires the system TVL as an input and which should be recorded prior to any value
 *          entering or leaving the system.
 *
 */
contract PerpetualTranche is
    ERC20BurnableUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    IPerpetualTranche
{
    //-------------------------------------------------------------------------
    // Libraries

    // data handling
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.AddressSet;
    using BondHelpers for IBondController;
    using TrancheHelpers for ITranche;

    // ERC20 operations
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // Math
    using MathUpgradeable for uint256;
    using SignedMathUpgradeable for int256;
    using SafeCastUpgradeable for int256;

    //-------------------------------------------------------------------------
    // Events

    /// @notice Event emitted when the keeper is updated.
    /// @param prevKeeper The address of the previous keeper.
    /// @param newKeeper The address of the new keeper.
    event UpdatedKeeper(address prevKeeper, address newKeeper);

    /// @notice Event emitted when the bond issuer is updated.
    /// @param issuer Address of the issuer contract.
    event UpdatedBondIssuer(IBondIssuer issuer);

    /// @notice Event emitted when the fee policy is updated.
    /// @param strategy Address of the strategy contract.
    event UpdatedFeePolicy(IFeePolicy strategy);

    /// @notice Event emitted when maturity tolerance parameters are updated.
    /// @param min The minimum maturity time.
    /// @param max The maximum maturity time.
    event UpdatedTolerableTrancheMaturity(uint256 min, uint256 max);

    /// @notice Event emitted when the supply caps are updated.
    /// @param maxSupply The max total supply.
    /// @param maxMintAmtPerTranche The max mint amount per tranche.
    event UpdatedMintingLimits(uint256 maxSupply, uint256 maxMintAmtPerTranche);

    /// @notice Event emitted when the authorized rollover vault is updated.
    /// @param vault The address of the rollover vault.
    event UpdatedVault(IRolloverVault vault);

    //-------------------------------------------------------------------------
    // Perp Math Basics:
    //
    // System holds tokens in the reserve {t1, t2 ... tn}
    // with balances {b1, b2 ... bn}.
    //
    // System reserve value:
    // RV => b1 . price(t1) + b2 . price(t2) + .... + bn . price(tn)
    //    => Σ bi . price(ti)
    //
    // When `ai` tokens of type `ti` are deposited into the system:
    // Mint: mintAmt (perps) => (ai * price(ti) / RV) * supply(perps)
    //
    // This ensures that if 10% of the collateral value is deposited,
    // the minter receives 10% of the perp token supply.
    // This removes any race conditions for minters based on reserve state.
    //
    // When `p` perp tokens are redeemed:
    // Redeem: ForEach ti => (p / supply(perps)) * bi
    //
    // When `ai` tokens of type `ti` are rolled in for tokens of type `tj`
    //  => ai * price(ti) =  aj * price(tj)
    // Rollover: aj => ai * price(ti) / (price(tj))
    //
    //
    //-------------------------------------------------------------------------
    // Constants & Immutables
    // Number of decimals for a multiplier of 1.0x (i.e. 100%)
    uint8 public constant FEE_POLICY_DECIMALS = 8;
    uint256 public constant FEE_ONE = (10**FEE_POLICY_DECIMALS);

    //-------------------------------------------------------------------------
    // Storage

    /// @dev The perp token balances are represented as a fixed point unsigned integer with these many decimals.
    uint8 private _decimals;

    //--------------------------------------------------------------------------
    // CONFIG

    /// @inheritdoc IPerpetualTranche
    address public override keeper;

    /// @notice External contract that orchestrates fees across the spot protocol.
    IFeePolicy public override feePolicy;

    /// @notice DEPRECATED.
    /// @dev This used to point to the external strategy that computes a given reserve token's price.
    // solhint-disable-next-line var-name-mixedcase
    address private _pricingStrategy_DEPRECATED;

    /// @notice DEPRECATED.
    /// @dev This used to point to the external strategy that computes a given reserve token's discount factor.
    ///      Now, we assume perp accepts only the "senior" most tranche from a bond. Seniors have a discount of 1.0,
    ///      every other tranche has a discount of 0.
    // solhint-disable-next-line var-name-mixedcase
    address private _discountStrategy_DEPRECATED;

    /// @inheritdoc IPerpetualTranche
    /// @dev Only tranches of bonds issued by this whitelisted issuer are accepted into the reserve.
    IBondIssuer public override bondIssuer;

    /// @notice The active deposit bond of whose tranches are currently being accepted to mint perps.
    IBondController private _depositBond;

    /// @notice The minimum maturity time in seconds for a tranche below which
    ///         it can be rolled over.
    uint256 public minTrancheMaturitySec;

    /// @notice The maximum maturity time in seconds for a tranche above which
    ///         it can NOT get added into the reserve.
    uint256 public maxTrancheMaturitySec;

    /// @notice DEPRECATED.
    /// @dev This used to control the percentage of the reserve value to be held as the underlying collateral.
    ///      With V2 perp cannot control this anymore, the rollover mechanics are dictated
    ///      by the amount of capital in the vault system.
    // solhint-disable-next-line var-name-mixedcase
    uint256 private _matureValueTargetPerc_DEPRECATED;

    /// @notice The maximum supply of perps that can exist at any given time.
    uint256 public maxSupply;

    /// @notice The max number of perps that can be minted for each tranche in the minting bond.
    uint256 public maxMintAmtPerTranche;

    /// @notice The total number of perps that have been minted using a given tranche.
    mapping(ITranche => uint256) public mintedSupplyPerTranche;

    /// @notice DEPRECATED.
    /// @dev This used to store the discount factor applied on each reserve token.
    ///      Now, we assume all tokens in perp have a discount factor of 1.
    // solhint-disable-next-line var-name-mixedcase
    mapping(IERC20Upgradeable => uint256) private _appliedDiscounts_DEPRECATED;

    //--------------------------------------------------------------------------
    // RESERVE

    /// @notice Set of all tokens in the reserve which back the perps.
    EnumerableSetUpgradeable.AddressSet private _reserves;

    /// @notice DEPRECATED.
    /// @dev The used to store the amount of all the mature tranches extracted and held as the collateral token,
    ///      i.e) the reserve's "virtual" mature tranche balance. The system no longer tracks this.
    // solhint-disable-next-line var-name-mixedcase
    uint256 private _matureTrancheBalance_DEPRECATED;

    //--------------------------------------------------------------------------
    // v1.1.0 STORAGE ADDITION

    /// @notice Address of the authorized rollover vault.
    /// @dev If this address is set, only the rollover vault can perform rollovers.
    ///      If not rollovers are publicly accessible.
    IRolloverVault public override vault;

    //--------------------------------------------------------------------------
    // Modifiers

    /// @dev Updates time-dependent reserve state.
    modifier afterStateUpdate() {
        updateState();
        _;
    }

    /// @dev Throws if called by any account other than the keeper.
    modifier onlyKeeper() {
        if (keeper != _msgSender()) {
            revert UnauthorizedCall();
        }
        _;
    }

    /// @dev Throws if called not called by vault.
    modifier onlyVault() {
        if (address(vault) != _msgSender()) {
            revert UnauthorizedCall();
        }
        _;
    }

    //--------------------------------------------------------------------------
    // Construction & Initialization

    /// @notice Contract state initialization.
    /// @param name ERC-20 Name of the Perp token.
    /// @param symbol ERC-20 Symbol of the Perp token.
    /// @param collateral_ Address of the underlying collateral token.
    /// @param bondIssuer_ Address of the bond issuer contract.
    /// @param feePolicy_ Address of the fee policy contract.
    function init(
        string memory name,
        string memory symbol,
        IERC20Upgradeable collateral_,
        IBondIssuer bondIssuer_,
        IFeePolicy feePolicy_
    ) public initializer {
        __ERC20_init(name, symbol);
        __ERC20Burnable_init();
        __Ownable_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        _decimals = IERC20MetadataUpgradeable(address(collateral_)).decimals();

        // NOTE: `_reserveAt(0)` always points to the underling collateral token
        // and is to be never updated.
        _reserves.add(address(collateral_));
        _syncReserve(collateral_);

        updateBondIssuer(bondIssuer_);
        updateFeePolicy(feePolicy_);

        updateTolerableTrancheMaturity(1, type(uint256).max);
        updateMintingLimits(type(uint256).max, type(uint256).max);
    }

    //--------------------------------------------------------------------------
    // ADMIN only methods

    /// @notice Pauses deposits, withdrawals and rollovers.
    /// @dev ERC-20 functions, like transfers will always remain operational.
    function pause() public onlyKeeper {
        _pause();
    }

    /// @notice Unpauses deposits, withdrawals and rollovers.
    /// @dev ERC-20 functions, like transfers will always remain operational.
    function unpause() public onlyKeeper {
        _unpause();
    }

    /// @notice Updates the reference to the keeper.
    /// @param newKeeper The address of the new keeper.
    function updateKeeper(address newKeeper) public onlyOwner {
        address prevKeeper = keeper;
        keeper = newKeeper;
        emit UpdatedKeeper(prevKeeper, newKeeper);
    }

    /// @notice Updates the reference to the rollover vault.
    /// @param newVault The address of the new vault.
    function updateVault(IRolloverVault newVault) public onlyOwner {
        if (address(newVault) == address(0)) {
            revert UnacceptableReference();
        }
        vault = newVault;
        emit UpdatedVault(newVault);
    }

    /// @notice Update the reference to the bond issuer contract.
    /// @param bondIssuer_ New bond issuer address.
    function updateBondIssuer(IBondIssuer bondIssuer_) public onlyOwner {
        if (address(bondIssuer_) == address(0)) {
            revert UnacceptableReference();
        }
        if (address(_reserveAt(0)) != bondIssuer_.collateral()) {
            revert UnexpectedAsset();
        }
        bondIssuer = bondIssuer_;
        emit UpdatedBondIssuer(bondIssuer_);
    }

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
        emit UpdatedFeePolicy(feePolicy_);
    }

    /// @notice Update the maturity tolerance parameters.
    /// @param minTrancheMaturitySec_ New minimum maturity time.
    /// @param maxTrancheMaturitySec_ New maximum maturity time.
    function updateTolerableTrancheMaturity(uint256 minTrancheMaturitySec_, uint256 maxTrancheMaturitySec_)
        public
        onlyOwner
    {
        if (minTrancheMaturitySec_ > maxTrancheMaturitySec_) {
            revert UnacceptableParams();
        }
        minTrancheMaturitySec = minTrancheMaturitySec_;
        maxTrancheMaturitySec = maxTrancheMaturitySec_;
        emit UpdatedTolerableTrancheMaturity(minTrancheMaturitySec_, maxTrancheMaturitySec_);
    }

    /// @notice Update parameters controlling the perp token mint limits.
    /// @param maxSupply_ New max total supply.
    /// @param maxMintAmtPerTranche_ New max total for per tranche in minting bond.
    function updateMintingLimits(uint256 maxSupply_, uint256 maxMintAmtPerTranche_) public onlyOwner {
        maxSupply = maxSupply_;
        maxMintAmtPerTranche = maxMintAmtPerTranche_;
        emit UpdatedMintingLimits(maxSupply_, maxMintAmtPerTranche_);
    }

    /// @notice Allows the owner to transfer non-critical assets out of the system if required.
    /// @param token The token address.
    /// @param to The destination address.
    /// @param amount The amount of tokens to be transferred.
    function transferERC20(
        IERC20Upgradeable token,
        address to,
        uint256 amount
    ) external afterStateUpdate onlyOwner {
        if (_inReserve(token)) {
            revert UnauthorizedTransferOut();
        }
        token.safeTransfer(to, amount);
    }

    //--------------------------------------------------------------------------
    // External methods

    /// @inheritdoc IPerpetualTranche
    function deposit(ITranche trancheIn, uint256 trancheInAmt)
        external
        override
        nonReentrant
        whenNotPaused
        afterStateUpdate
        returns (uint256)
    {
        if (!_isAcceptableTranche(trancheIn)) {
            revert UnexpectedAsset();
        }

        // Calculates the fee adjusted amount of perp tokens minted when depositing `trancheInAmt` of tranche tokens
        // NOTE: This operation should precede any token transfers.
        uint256 perpAmtMint = _computeMintAmt(trancheIn, trancheInAmt);
        if (trancheInAmt <= 0 || perpAmtMint <= 0) {
            revert UnacceptableDeposit();
        }

        // transfers tranche tokens from the sender to the reserve
        _transferIntoReserve(msg.sender, trancheIn, trancheInAmt);

        // mints perp tokens to the sender
        _mint(msg.sender, perpAmtMint);

        // post-deposit checks
        mintedSupplyPerTranche[trancheIn] += perpAmtMint;
        _enforceMintCaps(trancheIn);

        return perpAmtMint;
    }

    /// @inheritdoc IPerpetualTranche
    function redeem(uint256 perpAmtBurnt)
        external
        override
        nonReentrant
        whenNotPaused
        afterStateUpdate
        returns (TokenAmount[] memory)
    {
        // gets the current perp supply
        uint256 perpSupply = totalSupply();

        // verifies if burn amount is acceptable
        if (perpAmtBurnt <= 0 || perpAmtBurnt > perpSupply) {
            revert UnacceptableRedemption();
        }

        // Calculates the fee adjusted share of reserve tokens to be redeemed
        // NOTE: This operation should precede any token transfers.
        TokenAmount[] memory tokensOut = _computeRedemptionAmts(perpAmtBurnt, perpSupply);

        // burns perp tokens from the sender
        _burn(msg.sender, perpAmtBurnt);

        // transfers reserve tokens out
        for (uint256 i = 0; i < tokensOut.length; i++) {
            if (tokensOut[i].amount > 0) {
                _transferOutOfReserve(msg.sender, tokensOut[i].token, tokensOut[i].amount);
            }
        }

        return tokensOut;
    }

    /// @inheritdoc IPerpetualTranche
    function rollover(
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmtAvailable
    ) external override onlyVault nonReentrant whenNotPaused afterStateUpdate returns (RolloverData memory) {
        // verifies if rollover is acceptable
        if (!_isAcceptableRollover(trancheIn, tokenOut)) {
            revert UnacceptableRollover();
        }

        // Calculates the fee adjusted amount of tranches exchanged during a rolled over
        // NOTE: This operation should precede any token transfers.
        RolloverData memory r = _computeRolloverAmt(trancheIn, tokenOut, trancheInAmtAvailable, type(uint256).max);

        // Verifies if rollover amount is acceptable
        if (r.trancheInAmt <= 0 || r.tokenOutAmt <= 0) {
            return r;
        }

        // transfers tranche tokens from the sender to the reserve
        _transferIntoReserve(msg.sender, trancheIn, r.trancheInAmt);

        // transfers tranche from the reserve to the sender
        _transferOutOfReserve(msg.sender, tokenOut, r.tokenOutAmt);

        return r;
    }

    /// @inheritdoc IPerpetualTranche
    function getDepositBond() external override afterStateUpdate returns (IBondController) {
        return _depositBond;
    }

    /// @inheritdoc IPerpetualTranche
    function getDepositTranche() external override afterStateUpdate returns (ITranche) {
        return _depositBond.getSeniorTranche();
    }

    /// @inheritdoc IPerpetualTranche
    function getDepositTrancheRatio() external override afterStateUpdate returns (uint256) {
        return _depositBond.getSeniorTrancheRatio();
    }

    /// @inheritdoc IPerpetualTranche
    function isAcceptableRollover(ITranche trancheIn, IERC20Upgradeable tokenOut)
        external
        override
        afterStateUpdate
        returns (bool)
    {
        return _isAcceptableRollover(trancheIn, tokenOut);
    }

    /// @inheritdoc IPerpetualTranche
    function getReserveCount() external override afterStateUpdate returns (uint256) {
        return _reserveCount();
    }

    /// @inheritdoc IPerpetualTranche
    function getReserveAt(uint256 i) external override afterStateUpdate returns (IERC20Upgradeable) {
        return _reserveAt(i);
    }

    /// @inheritdoc IPerpetualTranche
    function inReserve(IERC20Upgradeable token) external override afterStateUpdate returns (bool) {
        return _inReserve(token);
    }

    /// @inheritdoc IPerpetualTranche
    function getReserveTokenBalance(IERC20Upgradeable token) external override afterStateUpdate returns (uint256) {
        if (!_inReserve(token)) {
            return 0;
        }
        return token.balanceOf(address(this));
    }

    /// @inheritdoc IPerpetualTranche
    function getReserveTokenValue(IERC20Upgradeable token) external override afterStateUpdate returns (uint256) {
        if (!_inReserve(token)) {
            return 0;
        }
        if (_isUnderlying(token)) {
            return token.balanceOf(address(this));
        }

        ITranche tranche = ITranche(address(token));
        IBondController parentBond = IBondController(tranche.bond());
        return _computeReserveTrancheValue(tranche, parentBond, _reserveAt(0), tranche.balanceOf(address(this)), true);
    }

    /// @inheritdoc IPerpetualTranche
    /// @dev Reserve tokens which are not up for rollover are marked by `address(0)`.
    function getReserveTokensUpForRollover() external override afterStateUpdate returns (IERC20Upgradeable[] memory) {
        uint256 reserveCount = _reserveCount();
        IERC20Upgradeable[] memory rolloverTokens = new IERC20Upgradeable[](reserveCount);

        // If any underlying collateral exists it can be rolled over.
        IERC20Upgradeable underlying_ = _reserveAt(0);
        if (underlying_.balanceOf(address(this)) > 0) {
            rolloverTokens[0] = underlying_;
        }

        // Iterating through the reserve to find tranches that are no longer "acceptable"
        for (uint256 i = 1; i < reserveCount; i++) {
            IERC20Upgradeable token = _reserveAt(i);
            IBondController bond = IBondController(ITranche(address(token)).bond());
            if (!_isAcceptableBond(bond)) {
                rolloverTokens[i] = token;
            }
        }

        return rolloverTokens;
    }

    /// @inheritdoc IPerpetualTranche
    /// @dev Returns a fixed point with the same decimals as the underlying collateral.
    function getTVL() external override afterStateUpdate returns (uint256) {
        return _reserveValue();
    }

    /// @inheritdoc IPerpetualTranche
    function computeMintAmt(ITranche trancheIn, uint256 trancheInAmt)
        external
        override
        afterStateUpdate
        returns (uint256)
    {
        return _computeMintAmt(trancheIn, trancheInAmt);
    }

    /// @inheritdoc IPerpetualTranche
    function computeRedemptionAmts(uint256 perpAmtBurnt)
        external
        override
        afterStateUpdate
        returns (TokenAmount[] memory)
    {
        uint256 perpSupply = totalSupply();
        if (perpSupply == 0) {
            revert UnacceptableRedemption();
        }
        return _computeRedemptionAmts(perpAmtBurnt, perpSupply);
    }

    /// @inheritdoc IPerpetualTranche
    /// @dev Set `tokenOutAmtRequested` to max(uint256) to use the reserve balance.
    function computeRolloverAmt(
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmtAvailable,
        uint256 tokenOutAmtRequested
    ) external override afterStateUpdate returns (RolloverData memory) {
        return _computeRolloverAmt(trancheIn, tokenOut, trancheInAmtAvailable, tokenOutAmtRequested);
    }

    //--------------------------------------------------------------------------
    // Public methods

    /// @inheritdoc IPerpetualTranche
    /// @dev Lazily updates time-dependent reserve storage state.
    ///      This function is to be invoked on all external function entry points which are
    ///      read the reserve storage. This function is intended to be idempotent.
    function updateState() public override {
        // Skip state update when system is paused.
        if (paused()) {
            return;
        }

        // Lazily queries the bond issuer to get the most recently issued bond
        // and updates with the new deposit bond if it's "acceptable".
        IBondController newBond = bondIssuer.getLatestBond();

        // If the new bond has been issued by the issuer and is "acceptable"
        if (_depositBond != newBond && _isAcceptableBond(newBond)) {
            // updates `_depositBond` with the new bond
            _depositBond = newBond;
            emit UpdatedDepositBond(newBond);
        }

        // Lazily checks if every reserve tranche has reached maturity.
        // If so redeems the tranche balance for the underlying collateral and
        // removes the tranche from the reserve set.
        // NOTE: We traverse the reserve set in the reverse order
        //       as deletions involve swapping the deleted element to the
        //       end of the set and removing the last element.
        //       We also skip the `reserveAt(0)`, i.e) the underlying collateral,
        //       which is never removed.
        uint256 reserveCount = _reserveCount();
        for (uint256 i = reserveCount - 1; i > 0; i--) {
            ITranche tranche = ITranche(address(_reserveAt(i)));
            IBondController bond = IBondController(tranche.bond());

            // If bond is not mature yet, move to the next tranche
            if (bond.secondsToMaturity() > 0) {
                continue;
            }

            // If bond has reached maturity but hasn't been poked
            if (!bond.isMature()) {
                bond.mature();
            }

            // Redeeming the underlying collateral token
            bond.redeemMature(address(tranche), tranche.balanceOf(address(this)));
            _syncReserve(tranche);
        }

        // Keeps track of the underlying collateral balance
        _syncReserve(_reserveAt(0));
    }

    //--------------------------------------------------------------------------
    // External view methods

    /// @inheritdoc IPerpetualTranche
    function underlying() external view override returns (IERC20Upgradeable) {
        return _reserveAt(0);
    }

    //--------------------------------------------------------------------------
    // Public view methods

    /// @notice Returns the number of decimals used to get its user representation.
    /// @dev For example, if `decimals` equals `2`, a balance of `505` tokens should
    ///      be displayed to a user as `5.05` (`505 / 10 ** 2`).
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    //--------------------------------------------------------------------------
    // Private methods

    /// @dev Transfers tokens from the given address to self and updates the reserve set.
    /// @return Reserve's token balance after transfer in.
    function _transferIntoReserve(
        address from,
        IERC20Upgradeable token,
        uint256 trancheAmt
    ) private returns (uint256) {
        token.safeTransferFrom(from, address(this), trancheAmt);
        return _syncReserve(token);
    }

    /// @dev Transfers tokens from self into the given address and updates the reserve set.
    /// @return Reserve's token balance after transfer out.
    function _transferOutOfReserve(
        address to,
        IERC20Upgradeable token,
        uint256 tokenAmt
    ) private returns (uint256) {
        token.safeTransfer(to, tokenAmt);
        return _syncReserve(token);
    }

    /// @dev Keeps the reserve storage up to date. Logs the token balance held by the reserve.
    /// @return The Reserve's token balance.
    function _syncReserve(IERC20Upgradeable token) private returns (uint256) {
        uint256 balance = token.balanceOf(address(this));
        emit ReserveSynced(token, balance);

        // The underlying collateral NEVER gets removed from the `_reserves` set.
        if (_isUnderlying(token)) {
            return balance;
        }

        // Otherwise `_reserves` set gets updated.
        bool inReserve_ = _inReserve(token);
        if (balance > 0 && !inReserve_) {
            // Inserts new tranche into reserve set.
            _reserves.add(address(token));
        }

        if (balance <= 0 && inReserve_) {
            // Removes tranche from reserve set.
            _reserves.remove(address(token));

            // Frees up minted supply.
            delete mintedSupplyPerTranche[ITranche(address(token))];
        }

        return balance;
    }

    /// @dev Computes the fee adjusted perp mint amount for given amount of tranche tokens deposited into the reserve.
    function _computeMintAmt(ITranche trancheIn, uint256 trancheInAmt) private view returns (uint256) {
        uint256 valueIn = _computeReserveTrancheValue(trancheIn, _depositBond, _reserveAt(0), trancheInAmt, false);

        //-----------------------------------------------------------------------------
        // We charge no mint fee when interacting with other callers within the system.
        uint256 feePerc = 0;
        uint256 perpTVL = 0;
        if (!_isProtocolCaller()) {
            // Minting more perps reduces the subscription ratio,
            // We check the post-mint subscription state to account for fees accordingly.
            SubscriptionParams memory s = _querySubscriptionState();
            feePerc = feePolicy.computePerpMintFeePerc(
                feePolicy.computeDeviationRatio(s.perpTVL + valueIn, s.vaultTVL, s.seniorTR)
            );
            perpTVL = s.perpTVL;
        } else {
            perpTVL = _reserveValue();
        }
        //-----------------------------------------------------------------------------

        // Compute mint amt
        uint256 totalSupply_ = totalSupply();
        uint256 perpAmtMint = valueIn;
        if (totalSupply_ > 0) {
            perpAmtMint = perpAmtMint.mulDiv(totalSupply_, perpTVL);
        }

        // The mint fees are settled by simply minting fewer perps.
        if (feePerc > 0) {
            perpAmtMint = perpAmtMint.mulDiv(FEE_ONE - feePerc, FEE_ONE);
        }

        return perpAmtMint;
    }

    /// @dev Computes the reserve token amounts redeemed when a given number of perps are burnt.
    function _computeRedemptionAmts(uint256 perpAmtBurnt, uint256 perpSupply)
        private
        view
        returns (TokenAmount[] memory)
    {
        //-----------------------------------------------------------------------------
        // We charge no burn fee when interacting with other parts of the system.
        uint256 feePerc = 0;

        if (!_isProtocolCaller()) {
            // Burning perps increases the subscription ratio,
            // We check the post-burn subscription state to account for fees accordingly.
            // We calculate the perp post-burn TVL, by multiplying the current TVL by
            // the fraction of supply remaining.
            SubscriptionParams memory s = _querySubscriptionState();
            feePerc = (perpSupply > 0)
                ? feePolicy.computePerpBurnFeePerc(
                    feePolicy.computeDeviationRatio(
                        s.perpTVL.mulDiv(perpSupply - perpAmtBurnt, perpSupply),
                        s.vaultTVL,
                        s.seniorTR
                    )
                )
                : 0;
        }
        //-----------------------------------------------------------------------------

        // Compute redemption amounts
        uint256 reserveCount = _reserveCount();
        TokenAmount[] memory reserveTokens = new TokenAmount[](reserveCount);
        for (uint256 i = 0; i < reserveCount; i++) {
            reserveTokens[i] = TokenAmount({
                token: _reserveAt(i),
                amount: _reserveAt(i).balanceOf(address(this)).mulDiv(perpAmtBurnt, perpSupply)
            });

            // The burn fees are settled by simply redeeming for fewer tranches.
            if (feePerc > 0) {
                reserveTokens[i].amount = reserveTokens[i].amount.mulDiv(FEE_ONE - feePerc, FEE_ONE);
            }
        }

        return (reserveTokens);
    }

    /// @dev Computes the amount of reserve tokens that can be rolled out for the given amount of tranches deposited.
    ///      The relative ratios of tokens In/Out are adjusted based on the current rollover fee perc.
    function _computeRolloverAmt(
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmtAvailable,
        uint256 tokenOutAmtRequested
    ) private view returns (RolloverData memory) {
        //-----------------------------------------------------------------------------
        // The rollover fees are settled by, adjusting the exchange rate
        // between `trancheInAmt` and `tokenOutAmt`.
        //
        int256 feePerc = feePolicy.computePerpRolloverFeePerc(
            feePolicy.computeDeviationRatio(_querySubscriptionState())
        );
        //-----------------------------------------------------------------------------

        // We compute "price" as the value of a unit token.
        // The perp, tranche tokens and the underlying are denominated as fixed point numbers
        // with the same number of decimals.
        IERC20Upgradeable underlying_ = _reserveAt(0);
        uint256 unitTokenAmt = (10**_decimals);
        uint256 trancheInPrice = _computeReserveTrancheValue(trancheIn, _depositBond, underlying_, unitTokenAmt, false);
        uint256 tokenOutPrice = unitTokenAmt;
        if (tokenOut != underlying_) {
            ITranche trancheOut = ITranche(address(tokenOut));
            IBondController trancheOutParentBond = IBondController(trancheOut.bond());
            tokenOutPrice = _computeReserveTrancheValue(
                trancheOut,
                trancheOutParentBond,
                underlying_,
                unitTokenAmt,
                true
            );
        }

        uint256 tokenOutBalance = tokenOut.balanceOf(address(this));
        tokenOutAmtRequested = MathUpgradeable.min(tokenOutAmtRequested, tokenOutBalance);
        if (trancheInAmtAvailable <= 0 || trancheInPrice <= 0 || tokenOutPrice <= 0 || tokenOutAmtRequested <= 0) {
            return RolloverData({ trancheInAmt: 0, tokenOutAmt: 0 });
        }
        //-----------------------------------------------------------------------------
        // Basic rollover with fees:
        // (1 +/- f) . (trancheInAmt . trancheInPrice) = (tokenOutAmt . tokenOutPrice)
        //-----------------------------------------------------------------------------

        // Given the amount of tranches In, we compute the amount of tokens out
        RolloverData memory r = RolloverData({
            trancheInAmt: trancheInAmtAvailable,
            tokenOutAmt: trancheInAmtAvailable.mulDiv(trancheInPrice, tokenOutPrice)
        });

        // A positive fee percentage implies that perp charges rotators by
        // accepting tranchesIn at a discount, i.e) fewer tokens out.
        // This results in perp enrichment.
        if (feePerc > 0) {
            r.tokenOutAmt = r.tokenOutAmt.mulDiv(FEE_ONE - feePerc.abs(), FEE_ONE);
        }
        // A negative fee percentage (or a reward) implies that perp pays the rotators by
        // accepting tranchesIn at a premium, i.e) more tokens out.
        // This results in perp debasement.
        else if (feePerc < 0) {
            r.tokenOutAmt = r.tokenOutAmt.mulDiv(FEE_ONE + feePerc.abs(), FEE_ONE);
        }
        //-----------------------------------------------------------------------------

        // When the tokenOut balance is NOT covered:
        // we fix tokenOutAmt = tokenOutAmtRequested and re-calculate other values
        if (r.tokenOutAmt > tokenOutAmtRequested) {
            // Given the amount of tokens out, we compute the amount of tranches in
            r.tokenOutAmt = tokenOutAmtRequested;
            r.trancheInAmt = r.tokenOutAmt.mulDiv(tokenOutPrice, trancheInPrice, MathUpgradeable.Rounding.Up);

            // A postive fee percentage implies that perp charges rotators by
            // offering tranchesOut for a premium, i.e) more tranches in.
            if (feePerc > 0) {
                r.trancheInAmt = r.trancheInAmt.mulDiv(
                    FEE_ONE,
                    FEE_ONE - feePerc.toUint256(),
                    MathUpgradeable.Rounding.Up
                );
            }
            // A negative fee percentage (or a reward) implies that perp pays the rotators by
            // offering tranchesOut at a discount, i.e) fewer tranches in.
            else if (feePerc < 0) {
                r.trancheInAmt = r.trancheInAmt.mulDiv(
                    FEE_ONE,
                    FEE_ONE + feePerc.abs(),
                    MathUpgradeable.Rounding.Up
                );
            }
        }

        return r;
    }

    /// @dev Checks if the given token pair is a valid rollover.
    ///      * When rolling out underlying collateral,
    ///          - expects incoming tranche to be part of the deposit bond
    ///      * When rolling out immature tranches,
    ///          - expects incoming tranche to be part of the deposit bond
    ///          - expects outgoing tranche to NOT be part of the deposit bond, (ie bondIn != bondOut)
    ///          - expects outgoing tranche to be in the reserve
    ///          - expects outgoing bond to NOT be "acceptable" any more
    function _isAcceptableRollover(ITranche trancheIn, IERC20Upgradeable tokenOut) private view returns (bool) {
        // when rolling out the underlying collateral
        if (_isUnderlying(tokenOut)) {
            return _isAcceptableTranche(trancheIn);
        }

        // when rolling out a normal tranche
        ITranche trancheOut = ITranche(address(tokenOut));
        IBondController bondOut = IBondController(trancheOut.bond());
        return (_isAcceptableTranche(trancheIn) &&
            !_isAcceptableTranche(trancheOut) &&
            _inReserve(trancheOut) &&
            !_isAcceptableBond(bondOut));
    }

    /// @dev Checks if the bond's tranches can be accepted into the reserve.
    ///      * Expects the bond to to have the same collateral token as perp.
    ///      * Expects the bond's maturity to be within expected bounds.
    ///      * Expects the bond to have only two tranches.
    ///      * Expects the bond controller to not withhold any fees.
    /// @return True if the bond is "acceptable".
    function _isAcceptableBond(IBondController bond) private view returns (bool) {
        // NOTE: `secondsToMaturity` will be 0 if the bond is past maturity.
        uint256 secondsToMaturity = bond.secondsToMaturity();
        return (address(_reserveAt(0)) == bond.collateralToken() &&
            secondsToMaturity >= minTrancheMaturitySec &&
            secondsToMaturity < maxTrancheMaturitySec &&
            bond.trancheCount() == 2 &&
            bond.feeBps() == 0);
    }

    /// @dev Checks if the given tranche can be accepted into the reserve.
    ///      * Expects the given tranche belongs to the current deposit bond.
    ///      * Expects the given tranche is the most "senior" in the bond.
    /// @return True if the tranche is "acceptable".
    function _isAcceptableTranche(ITranche tranche) private view returns (bool) {
        bool isDepositBondTranche = (_depositBond.trancheTokenAddresses(tranche) &&
            address(_depositBond) == tranche.bond());
        return (isDepositBondTranche && (_depositBond.getSeniorTranche() == tranche));
    }

    /// @dev Enforces the total supply and per tranche mint cap. To be invoked AFTER the mint operation.
    function _enforceMintCaps(ITranche trancheIn) private view {
        // checks if supply minted using the given tranche is within the cap
        if (mintedSupplyPerTranche[trancheIn] > maxMintAmtPerTranche) {
            revert ExceededMaxMintPerTranche();
        }

        // checks if new total supply is within the max supply cap
        uint256 newSupply = totalSupply();
        if (newSupply > maxSupply) {
            revert ExceededMaxSupply();
        }
    }

    /// @dev Counts the number of tokens currently in the reserve.
    function _reserveCount() private view returns (uint256) {
        return _reserves.length();
    }

    /// @dev Fetches the reserve token by index.
    function _reserveAt(uint256 i) private view returns (IERC20Upgradeable) {
        return IERC20Upgradeable(_reserves.at(i));
    }

    /// @dev Checks if the given token is in the reserve.
    function _inReserve(IERC20Upgradeable token) private view returns (bool) {
        return _reserves.contains(address(token));
    }

    /// @dev Queries the current subscription state of the perp and vault systems.
    function _querySubscriptionState() private view returns (SubscriptionParams memory) {
        return
            SubscriptionParams({
                perpTVL: _reserveValue(),
                vaultTVL: IRolloverVault(vault).getTVL(),
                seniorTR: _depositBond.getSeniorTrancheRatio()
            });
    }

    /// @dev Calculates the total value of all the tranches in the reserve.
    ///      Value of each reserve tranche is denominated in the underlying collateral.
    function _reserveValue() private view returns (uint256) {
        IERC20Upgradeable underlying_ = _reserveAt(0);
        uint256 totalVal = underlying_.balanceOf(address(this));
        for (uint256 i = 1; i < _reserveCount(); i++) {
            ITranche tranche = ITranche(address(_reserveAt(i)));
            IBondController parentBond = IBondController(tranche.bond());
            totalVal += _computeReserveTrancheValue(
                tranche,
                parentBond,
                underlying_,
                tranche.balanceOf(address(this)),
                true
            );
        }
        return totalVal;
    }

    /// @dev Computes the value of the given amount reserve tranche tokens (i.e ones already accepted in the reserve or to be accepted),
    ///      based on it's current CDR.
    ///      NOTE: Callers should round up when valuing reserve assets and round down for incoming assets.
    function _computeReserveTrancheValue(
        ITranche tranche,
        IBondController parentBond,
        IERC20Upgradeable collateralToken,
        uint256 trancheAmt,
        bool roundUp
    ) private view returns (uint256) {
        // NOTE: As an optimization here, we assume that the reserve tranche is immature and has the most senior claim.
        uint256 parentBondCollateralBalance = collateralToken.balanceOf(address(parentBond));
        (uint256 trancheClaim, uint256 trancheSupply) = tranche.getImmatureSeniorTrancheCollateralization(
            parentBondCollateralBalance
        );

        // Tranche supply is zero (its parent bond has no deposits yet); the tranche's CDR is assumed 1.0.
        return
            (trancheSupply > 0)
                ? trancheClaim.mulDiv(
                    trancheAmt,
                    trancheSupply,
                    roundUp ? MathUpgradeable.Rounding.Up : MathUpgradeable.Rounding.Down
                )
                : trancheAmt;
    }

    /// @dev Checks if the given token is the underlying collateral token.
    function _isUnderlying(IERC20Upgradeable token) private view returns (bool) {
        return (token == _reserveAt(0));
    }

    /// @dev Checks if caller is another module within the protocol.
    ///      If so, we do not charge mint/burn for internal operations.
    function _isProtocolCaller() private view returns (bool) {
        return (_msgSender() == address(vault));
    }
}
