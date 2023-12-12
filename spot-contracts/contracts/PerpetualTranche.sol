// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20MetadataUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";
import { IERC20Upgradeable, IPerpetualTranche, IBondIssuer, IFeePolicy, IPricingStrategy, IBondController, ITranche } from "./_interfaces/IPerpetualTranche.sol";
import { UnauthorizedCall, UnauthorizedTransferOut, UnacceptableReference, UnexpectedDecimals, UnexpectedAsset, UnacceptableDeposit, UnacceptableRedemption, UnacceptableParams } from "./_interfaces/ProtocolErrors.sol";

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

/// @notice Expected rollover to be acceptable.
error UnacceptableRollover();

/// @notice Expected supply to be lower than the defined max supply.
error ExceededMaxSupply();

/// @notice Expected the total mint amount per tranche to be lower than the limit.
error ExceededMaxMintPerTranche();

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
 *          ie) the seniors and the underlying collateral.
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

    /// @notice Event emitted when the fee strategy is updated.
    /// @param strategy Address of the strategy contract.
    event UpdatedFeeStrategy(IFeeStrategy strategy);

    /// @notice Event emitted when the pricing strategy is updated.
    /// @param strategy Address of the strategy contract.
    event UpdatedPricingStrategy(IPricingStrategy strategy);

    /// @notice Event emitted when maturity tolerance parameters are updated.
    /// @param min The minimum maturity time.
    /// @param max The maximum maturity time.
    event UpdatedTolerableTrancheMaturity(uint256 min, uint256 max);

    /// @notice Event emitted when the supply caps are updated.
    /// @param maxSupply The max total supply.
    /// @param maxMintAmtPerTranche The max mint amount per tranche.
    event UpdatedMintingLimits(uint256 maxSupply, uint256 maxMintAmtPerTranche);

    /// @notice Event emitted when the authorized rollers are updated.
    /// @param roller The address of the roller.
    /// @param authorized If the roller is has been authorized or not.
    event UpdatedRollerAuthorization(address roller, bool authorized);

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
    uint8 public constant DISCOUNT_DECIMALS = 18;
    uint256 public constant UNIT_DISCOUNT = (10**DISCOUNT_DECIMALS);

    uint8 public constant PRICE_DECIMALS = 8;
    uint256 public constant UNIT_PRICE = (10**PRICE_DECIMALS);

    uint8 public constant PERC_DECIMALS = 8;
    uint256 public constant HUNDRED_PERC = 10**PERC_DECIMALS;

    //-------------------------------------------------------------------------
    // Storage

    /// @dev The perp token balances are represented as a fixed point unsigned integer with these many decimals.
    uint8 private _decimals;

    //--------------------------------------------------------------------------
    // CONFIG

    /// @inheritdoc IPerpetualTranche
    address public override keeper;

    /// @notice External contract points controls fees & incentives for rollovers.
    IFeeStrategy public override feeStrategy;

    /// @notice External contract that computes a given reserve token's price.
    /// @dev The computed price is expected to be a fixed point unsigned integer with {PRICE_DECIMALS} decimals.
    IPricingStrategy public pricingStrategy;

    /// @notice DEPRECATED.
    /// @dev This used to point to the external strategy that computes a given reserve token's discount factor.
    ///      Now, we assume perp accepts only the "senior" most tranche from a bond. Seniors have a discount of 1.0,
    ///      every other tranche has a discount of 0.
    // solhint-disable-next-line var-name-mixedcase
    address private _discountStrategy_DEPRECATED;

    /// @notice External contract that stores a predefined bond config and frequency,
    ///         and issues new bonds when poked.
    /// @dev Only tranches of bonds issued by this whitelisted issuer are accepted into the reserve.
    IBondIssuer public bondIssuer;

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

    /// @notice Set of all authorized addresses which can execute rollovers.
    /// @dev The contract owner can modify this set.
    ///      NOTE: If the set is empty, all addresses are considered authorized and can execute rollovers.
    ///            else only addresses in the set can execute rollovers.
    EnumerableSetUpgradeable.AddressSet private _rollers;

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

    /// @dev Throws if called by any account other than an authorized roller.
    modifier onlyRollers() {
        // If the set it empty, permit all callers
        // else permit only whitelisted callers.
        if (_rollers.length() > 0 && !_rollers.contains(_msgSender())) {
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
    /// @param feeStrategy_ Address of the fee strategy contract.
    /// @param pricingStrategy_ Address of the pricing strategy contract.
    function init(
        string memory name,
        string memory symbol,
        IERC20Upgradeable collateral_,
        IBondIssuer bondIssuer_,
        IFeeStrategy feeStrategy_,
        IPricingStrategy pricingStrategy_
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
        updateFeeStrategy(feeStrategy_);
        updatePricingStrategy(pricingStrategy_);

        updateTolerableTrancheMaturity(1, type(uint256).max);
        updateMintingLimits(type(uint256).max, type(uint256).max);
    }

    //--------------------------------------------------------------------------
    // ADMIN only methods

    /// @notice Pauses deposits, withdrawals and rollovers.
    /// @dev NOTE: ERC-20 functions, like transfers will always remain operational.
    function pause() public onlyKeeper {
        _pause();
    }

    /// @notice Unpauses deposits, withdrawals and rollovers.
    /// @dev NOTE: ERC-20 functions, like transfers will always remain operational.
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

    /// @notice Updates the authorized roller set.
    /// @dev CAUTION: If the authorized roller set is empty, all rollers are authorized.
    /// @param roller The address of the roller.
    /// @param authorize If the roller is to be authorized or unauthorized.
    function authorizeRoller(address roller, bool authorize) external onlyOwner {
        if (authorize && !_rollers.contains(roller)) {
            _rollers.add(roller);
        } else if (!authorize && _rollers.contains(roller)) {
            _rollers.remove(roller);
        } else {
            return;
        }

        emit UpdatedRollerAuthorization(roller, authorize);
    }

    /// @notice Update the reference to the bond issuer contract.
    /// @param bondIssuer_ New bond issuer address.
    function updateBondIssuer(IBondIssuer bondIssuer_) public onlyOwner {
        if (address(bondIssuer_) == address(0)) {
            revert UnacceptableReference();
        }
        if (address(_reserveAt(0)) != bondIssuer_.collateral()) {
            revert InvalidCollateral();
        }
        bondIssuer = bondIssuer_;
        emit UpdatedBondIssuer(bondIssuer_);
    }

    /// @notice Update the reference to the fee strategy contract.
    /// @param feeStrategy_ New strategy address.
    function updateFeeStrategy(IFeeStrategy feeStrategy_) public onlyOwner {
        if (address(feeStrategy_) == address(0)) {
            revert UnacceptableReference();
        }
        if (feeStrategy_.decimals() != PERC_DECIMALS) {
            revert InvalidStrategyDecimals();
        }
        feeStrategy = feeStrategy_;
        emit UpdatedFeeStrategy(feeStrategy_);
    }

    /// @notice Update the reference to the pricing strategy contract.
    /// @param pricingStrategy_ New strategy address.
    function updatePricingStrategy(IPricingStrategy pricingStrategy_) public onlyOwner {
        if (address(pricingStrategy_) == address(0)) {
            revert UnacceptableReference();
        }
        if (pricingStrategy_.decimals() != PRICE_DECIMALS) {
            revert UnexpectedDecimals();
        }
        pricingStrategy = pricingStrategy_;
        emit UpdatedPricingStrategy(pricingStrategy_);
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

        // calculates the amount of perp tokens minted when depositing `trancheInAmt` of tranche tokens
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
        returns (IERC20Upgradeable[] memory, uint256[] memory)
    {
        // gets the current perp supply
        uint256 perpSupply = totalSupply();

        // verifies if burn amount is acceptable
        if (perpAmtBurnt <= 0 || perpAmtBurnt > perpSupply) {
            revert UnacceptableRedemption();
        }

        // calculates share of reserve tokens to be redeemed
        (IERC20Upgradeable[] memory tokensOuts, uint256[] memory tokenOutAmts) = _computeRedemptionAmts(perpAmtBurnt);

        // burns perp tokens from the sender
        _burn(msg.sender, perpAmtBurnt);

        // transfers reserve tokens out
        for (uint256 i = 0; i < tokensOuts.length; i++) {
            if (tokenOutAmts[i] > 0) {
                _transferOutOfReserve(msg.sender, tokensOuts[i], tokenOutAmts[i]);
            }
        }

        return (tokensOuts, tokenOutAmts);
    }

    /// @inheritdoc IPerpetualTranche
    function rollover(
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmtAvailable
    )
        external
        override
        onlyRollers
        nonReentrant
        whenNotPaused
        afterStateUpdate
        returns (IPerpetualTranche.RolloverData memory)
    {
        // verifies if rollover is acceptable
        if (!_isAcceptableRollover(trancheIn, tokenOut)) {
            revert UnacceptableRollover();
        }

        // calculates the perp denominated amount rolled over and the tokenOutAmt
        IPerpetualTranche.RolloverData memory r = _computeRolloverAmt(
            trancheIn,
            tokenOut,
            trancheInAmtAvailable,
            type(uint256).max
        );

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
        return token.balanceOf(address(this)).mulDiv(_tranchePrice(ITranche(address(token))), UNIT_PRICE);
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
    /// @dev Returns a fixed point with {PRICE_DECIMALS} decimals.
    function getAvgPrice() external override afterStateUpdate returns (uint256) {
        uint256 totalSupply_ = totalSupply();
        return totalSupply_ > 0 ? _reserveValue().mulDiv(UNIT_PRICE, totalSupply_) : 0;
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
        returns (IERC20Upgradeable[] memory, uint256[] memory)
    {
        return _computeRedemptionAmts(perpAmtBurnt);
    }

    /// @inheritdoc IPerpetualTranche
    /// @dev Set `tokenOutAmtRequested` to max(uint256) to use the reserve balance.
    function computeRolloverAmt(
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmtAvailable,
        uint256 tokenOutAmtRequested
    ) external override afterStateUpdate returns (IPerpetualTranche.RolloverData memory) {
        return _computeRolloverAmt(trancheIn, tokenOut, trancheInAmtAvailable, tokenOutAmtRequested);
    }

    /// @return Returns the number of authorized rollers.
    function authorizedRollersCount() external view returns (uint256) {
        return _rollers.length();
    }

    /// @return Returns the roller address from the authorized set by index.
    /// @param i The index of the address in the set.
    function authorizedRollerAt(uint256 i) external view returns (address) {
        return _rollers.at(i);
    }

    /// @inheritdoc IPerpetualTranche
    function computeDiscount(IERC20Upgradeable token) external view override returns (uint256) {
        return _inReserve(token) ? UNIT_DISCOUNT : 0;
    }

    /// @inheritdoc IPerpetualTranche
    function computePrice(IERC20Upgradeable token) external view override returns (uint256) {
        if (_isUnderlying(token)) {
            return UNIT_PRICE;
        }
        return _tranchePrice(ITranche(address(token)));
    }

    //--------------------------------------------------------------------------
    // Public methods

    /// @inheritdoc IPerpetualTranche
    /// @dev Lazily updates time-dependent reserve storage state.
    ///      This function is to be invoked on all external function entry points which are
    ///      read the reserve storage. This function is intended to be idempotent.
    function updateState() public override {
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
    function collateral() external view override returns (IERC20Upgradeable) {
        return _reserveAt(0);
    }

    /// @inheritdoc IPerpetualTranche
    function underlying() external view override returns (IERC20Upgradeable) {
        return _reserveAt(0);
    }

    //--------------------------------------------------------------------------
    // Public view methods

    /// @inheritdoc IPerpetualTranche
    function perpERC20() public view override returns (IERC20Upgradeable) {
        return IERC20Upgradeable(address(this));
    }

    /// @inheritdoc IPerpetualTranche
    function reserve() public view override returns (address) {
        return address(this);
    }

    /// @notice Returns the number of decimals used to get its user representation.
    /// @dev For example, if `decimals` equals `2`, a balance of `505` tokens should
    ///      be displayed to a user as `5.05` (`505 / 10 ** 2`).
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    //--------------------------------------------------------------------------
    // Private methods

    /// @dev Computes the perp mint amount for given amount of tranche tokens deposited into the reserve.
    function _computeMintAmt(ITranche trancheIn, uint256 trancheInAmt) private returns (uint256) {
        uint256 feePerc = feeStrategy.computeMintFeePerc();
        uint256 totalSupply_ = totalSupply();
        uint256 trancheInPrice = _tranchePrice(trancheIn);
        uint256 perpAmtMint = trancheInAmt.mulDiv(trancheInPrice, UNIT_PRICE);
        if (totalSupply_ > 0) {
            perpAmtMint = perpAmtMint.mulDiv(totalSupply_, _reserveValue());
        }
        // NOTE: The mint fees are settled by simply minting fewer perps.
        perpAmtMint = perpAmtMint.mulDiv(HUNDRED_PERC - feePerc, HUNDRED_PERC);
        return perpAmtMint;
    }

    /// @dev Computes the reserve token amounts redeemed when a given number of perps are burnt.
    function _computeRedemptionAmts(uint256 perpAmtBurnt)
        private
        returns (IERC20Upgradeable[] memory, uint256[] memory)
    {
        uint256 feePerc = feeStrategy.computeBurnFeePerc();
        uint256 totalSupply_ = totalSupply();
        uint256 reserveCount = _reserveCount();
        IERC20Upgradeable[] memory reserveTokens = new IERC20Upgradeable[](reserveCount);
        uint256[] memory redemptionAmts = new uint256[](reserveCount);
        for (uint256 i = 0; i < reserveCount; i++) {
            reserveTokens[i] = _reserveAt(i);
            redemptionAmts[i] = (totalSupply_ > 0)
                ? reserveTokens[i].balanceOf(address(this)).mulDiv(perpAmtBurnt, totalSupply_)
                : 0;
            // NOTE: The burn fees are settled by simply redeeming for fewer tranches.
            redemptionAmts[i] = redemptionAmts[i].mulDiv(HUNDRED_PERC - feePerc, HUNDRED_PERC);
        }
        return (reserveTokens, redemptionAmts);
    }

    /// @dev Computes the amount of reserve tokens that can be rolled out for the given amount of tranches deposited.
    ///      The relative ratios of tokens In/Out are adjusted based on the current rollver fee perc.
    function _computeRolloverAmt(
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmtAvailable,
        uint256 tokenOutAmtRequested
    ) private returns (IPerpetualTranche.RolloverData memory) {
        // NOTE: The rollover fees are settled by,
        // adjusting the exchange rate between `trancheInAmt` and `tokenOutAmt`.
        int256 feePerc = feeStrategy.computeRolloverFeePerc();

        IPerpetualTranche.RolloverData memory r;

        uint256 trancheInPrice = _tranchePrice(trancheIn);
        uint256 tokenOutPrice = _isUnderlying(tokenOut) ? UNIT_PRICE : _tranchePrice(ITranche(address(tokenOut)));
        uint256 tokenOutBalance = tokenOut.balanceOf(address(this));
        tokenOutAmtRequested = MathUpgradeable.min(tokenOutAmtRequested, tokenOutBalance);

        if (trancheInAmtAvailable <= 0 || trancheInPrice <= 0 || tokenOutPrice <= 0 || tokenOutAmtRequested <= 0) {
            return r;
        }

        //-----------------------------------------------------------------------------
        // Basic rollover with fees:
        // (1 +/- f) . (trancheInAmt . trancheInPrice) = (tokenOutAmt . tokenOutPrice)
        //-----------------------------------------------------------------------------

        // Given the amount of tranches In, we compute the amount of tokens out
        r.trancheInAmt = trancheInAmtAvailable;
        r.tokenOutAmt = r.trancheInAmt.mulDiv(trancheInPrice, tokenOutPrice);

        // A positive fee percentage implies that perp charges rotators by
        // accepting tranchesIn at a discount, ie) fewer tokens out.
        if (feePerc > 0) {
            r.tokenOutAmt = r.tokenOutAmt.mulDiv(HUNDRED_PERC - feePerc.abs(), HUNDRED_PERC);
        }
        // A negative fee percentage (or a reward) implies that perp pays the rotators by
        // accepting tranchesIn at a premium, ie) more tokens out.
        else if (feePerc < 0) {
            r.tokenOutAmt = r.tokenOutAmt.mulDiv(HUNDRED_PERC + feePerc.abs(), HUNDRED_PERC);
        }
        //-----------------------------------------------------------------------------

        // When the tokenOut balance is NOT covered:
        // we fix tokenOutAmt = tokenOutAmtRequested and re-calculate other values
        if (r.tokenOutAmt > tokenOutAmtRequested) {
            // Given the amount of tokens out, we compute the amount of tranches in
            r.tokenOutAmt = tokenOutAmtRequested;
            r.trancheInAmt = r.tokenOutAmt.mulDiv(tokenOutPrice, trancheInPrice, MathUpgradeable.Rounding.Up);

            // A postive fee percentage implies that perp charges rotators by
            // offering tranchesOut for a premium, ie) more tranches in.
            if (feePerc > 0) {
                r.trancheInAmt = r.trancheInAmt.mulDiv(
                    HUNDRED_PERC,
                    HUNDRED_PERC - feePerc.toUint256(),
                    MathUpgradeable.Rounding.Up
                );
            }
            // A negative fee percentage (or a reward) implies that perp pays the rotators by
            // offering tranchesOut at a discount, ie) fewer tranches in.
            else if (feePerc < 0) {
                r.trancheInAmt = r.trancheInAmt.mulDiv(
                    HUNDRED_PERC,
                    HUNDRED_PERC + feePerc.abs(),
                    MathUpgradeable.Rounding.Up
                );
            }
        }

        return r;
    }

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
    /// @return True if the bond is "acceptable".
    function _isAcceptableBond(IBondController bond) private view returns (bool) {
        // NOTE: `secondsToMaturity` will be 0 if the bond is past maturity.
        uint256 secondsToMaturity = bond.secondsToMaturity();
        return (address(_reserveAt(0)) == bond.collateralToken() &&
            secondsToMaturity >= minTrancheMaturitySec &&
            secondsToMaturity < maxTrancheMaturitySec);
    }

    /// @dev Checks if the given tranche can be accepted into the reserve.
    ///      * Expects the given tranche belongs to the current deposit bond.
    ///      * Expects the given tranche is the most "senior" in the bond.
    /// @return True if the tranche is "acceptable".
    function _isAcceptableTranche(ITranche tranche) private view returns (bool) {
        bool isDepositBondTranche = (_depositBond.trancheTokenAddresses(tranche) &&
            address(_depositBond) == tranche.bond());
        return (isDepositBondTranche && (_depositBond.trancheAt(0) == tranche));
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

    /// @dev Calculates the total value of all the tranches in the reserve.
    ///      Value of each reserve tranche is calculated as = trancheBalance . tranchePrice.
    function _reserveValue() private view returns (uint256) {
        uint256 totalVal = _reserveAt(0).balanceOf(address(this));
        for (uint256 i = 1; i < _reserveCount(); i++) {
            IERC20Upgradeable token = _reserveAt(i);
            totalVal += token.balanceOf(address(this)).mulDiv(_tranchePrice(ITranche(address(token))), UNIT_PRICE);
        }
        return totalVal;
    }

    /// @dev Fetches price of a given tranche from the pricing strategy.
    function _tranchePrice(ITranche t) private view returns (uint256) {
        return pricingStrategy.computeTranchePrice(t);
    }

    /// @dev Checks if the given token is the underlying collateral token.
    function _isUnderlying(IERC20Upgradeable token) private view returns (bool) {
        return (token == _reserveAt(0));
    }
}
