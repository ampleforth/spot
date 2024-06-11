// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { IERC20MetadataUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";
import { IERC20Upgradeable, IPerpetualTranche, IBondIssuer, IBalancer, IBondController, ITranche } from "./_interfaces/IPerpetualTranche.sol";
import { IRolloverVault } from "./_interfaces/IRolloverVault.sol";
import { TokenAmount, RolloverData, SubscriptionParams } from "./_interfaces/CommonTypes.sol";
import { UnauthorizedCall, UnauthorizedTransferOut, UnexpectedDecimals, UnexpectedAsset, UnacceptableParams, UnacceptableDeposit, UnacceptableRollover, ReserveCountOverLimit, InvalidPerc, ExceededMaxMintPerTranche } from "./_interfaces/ProtocolErrors.sol";

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
 *
 * @dev The time dependent system state is updated "lazily" without a need for an explicit poke
 *      from the outside world. Every external function that deals with the reserve
 *      invokes the `afterStateUpdate` modifier at the entry-point.
 *      This brings the system storage state up to date.
 *
 *      CRITICAL: On the 3 main system operations: deposit, redeem and rollover;
 *      We first compute fees before executing any transfers in or out of the system.
 *      The ordering of operations is very important as the fee computation logic,
 *      requires the system TVL as an input and which should be recorded prior to any value
 *      entering or leaving the system.
 *
 *      With the new demand based fee policy implementation,
 *      both perp and the rollover have a mutual dependency on each other.
 *      None of the perp operations will work unless it's pointed to a valid vault.
 *
 *      When computing the value of assets in the system, the code always over-values by
 *      rounding up. When computing the value of incoming assets, the code rounds down.
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

    /// @dev Internal percentages are fixed point numbers with {PERC_DECIMALS} places.
    uint8 public constant PERC_DECIMALS = 8;
    uint256 public constant ONE = (10 ** PERC_DECIMALS); // 1.0 or 100%

    /// @dev The maximum number of reserve assets that can be held by perp.
    uint8 public constant MAX_RESERVE_COUNT = 11;

    //-------------------------------------------------------------------------
    // Storage

    /// @dev The perp token balances are represented as a fixed point unsigned integer with these many decimals.
    uint8 private _decimals;

    //--------------------------------------------------------------------------
    // CONFIG

    /// @inheritdoc IPerpetualTranche
    address public override keeper;

    /// @notice External contract that orchestrates external interactions with the spot protocol.
    /// @custom:oz-upgrades-renamed-from feePolicy
    IBalancer public override balancer;

    /// @notice DEPRECATED.
    /// @dev This used to point to the external strategy that computes a given reserve token's price.
    /// @custom:oz-upgrades-renamed-from pricingStrategy
    // solhint-disable-next-line var-name-mixedcase
    address private _pricingStrategy_DEPRECATED;

    /// @notice DEPRECATED.
    /// @dev This used to point to the external strategy that computes a given reserve token's discount factor.
    ///      Now, we assume perp accepts only the "senior" most tranche from a bond. Seniors have a discount of 1.0,
    ///      every other tranche has a discount of 0.
    /// @custom:oz-upgrades-renamed-from discountStrategy
    // solhint-disable-next-line var-name-mixedcase
    address private _discountStrategy_DEPRECATED;

    /// @inheritdoc IPerpetualTranche
    /// @dev Only tranches of bonds issued by this whitelisted issuer are accepted into the reserve.
    IBondIssuer public override bondIssuer;

    /// @notice The active deposit bond of whose tranches are currently being accepted to mint perps.
    IBondController public depositBond;

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
    /// @custom:oz-upgrades-renamed-from matureValueTargetPerc
    // solhint-disable-next-line var-name-mixedcase
    uint256 private _matureValueTargetPerc_DEPRECATED;

    /// @notice DEPRECATED.
    /// @dev The used to store the supply cap for perps.
    // solhint-disable-next-line var-name-mixedcase
    uint256 private _maxSupply_DEPRECATED;

    /// @notice Enforced maximum percentage of reserve value in the deposit tranche.
    /// @custom:oz-upgrades-renamed-from maxMintAmtPerTranche
    uint256 public maxDepositTrancheValuePerc;

    /// @notice DEPRECATED.
    /// @dev This used to store the number of perps minted using each deposit tranche.
    /// @custom:oz-upgrades-renamed-from mintedSupplyPerTranche
    // solhint-disable-next-line var-name-mixedcase
    mapping(ITranche => uint256) private _mintedSupplyPerTranche_DEPRECATED;

    /// @notice DEPRECATED.
    /// @dev This used to store the discount factor applied on each reserve token.
    ///      Now, we assume all tokens in perp have a discount factor of 1.
    /// @custom:oz-upgrades-renamed-from appliedDiscounts
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
    // v2.0.0 STORAGE ADDITION

    /// @notice Address of the authorized rollover vault.
    /// @dev If this address is set, only the rollover vault can perform rollovers.
    ///      If not rollovers are publicly accessible.
    IRolloverVault public override vault;

    //--------------------------------------------------------------------------
    // Modifiers

    /// @dev Throws if called by any account other than the keeper.
    modifier onlyKeeper() {
        if (keeper != msg.sender) {
            revert UnauthorizedCall();
        }
        _;
    }

    /// @dev Throws if called not called by vault.
    modifier onlyVault() {
        if (address(vault) != msg.sender) {
            revert UnauthorizedCall();
        }
        _;
    }

    /// @dev Throws if called not called by balancer.
    modifier onlyBalancer() {
        if (address(balancer) != msg.sender) {
            revert UnauthorizedCall();
        }
        _;
    }

    /// @dev Throws if called not called by the vault or balancer.
    modifier onlyProtocol() {
        if (address(balancer) != msg.sender && address(vault) != msg.sender) {
            revert UnauthorizedCall();
        }
        _;
    }

    /// @dev Updates deposit bond.
    modifier onAfterUpdateDepositBond() {
        updateDepositBond();
        _;
    }

    /// @dev Recover mature tranches.
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
    /// @param name ERC-20 Name of the Perp token.
    /// @param symbol ERC-20 Symbol of the Perp token.
    /// @param collateral_ Address of the underlying collateral token.
    /// @param bondIssuer_ Address of the bond issuer contract.
    function init(
        string memory name,
        string memory symbol,
        IERC20Upgradeable collateral_,
        IBondIssuer bondIssuer_
    ) external initializer {
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

        updateKeeper(owner());
        updateBondIssuer(bondIssuer_);
        updateTolerableTrancheMaturity(1, type(uint256).max);
        updateMaxDepositTrancheValuePerc(ONE);
        updateState();
    }

    //--------------------------------------------------------------------------
    // ADMIN only methods

    /// @notice Updates the reference to the rollover vault.
    /// @param vault_ The address of the new vault.
    function updateVault(IRolloverVault vault_) external onlyOwner {
        vault = vault_;
    }

    /// @notice Update the reference to the balancer contract.
    /// @param balancer_ New strategy address.
    function updateBalancer(IBalancer balancer_) external onlyOwner {
        if (balancer_.decimals() != PERC_DECIMALS) {
            revert UnexpectedDecimals();
        }
        balancer = balancer_;
    }

    /// @notice Updates the reference to the keeper.
    /// @param keeper_ The address of the new keeper.
    function updateKeeper(address keeper_) public onlyOwner {
        keeper = keeper_;
    }
    /// @notice Update the reference to the bond issuer contract.
    /// @param bondIssuer_ New bond issuer address.
    function updateBondIssuer(IBondIssuer bondIssuer_) public onlyOwner {
        if (bondIssuer_.collateral() != address(_reserveAt(0))) {
            revert UnexpectedAsset();
        }
        bondIssuer = bondIssuer_;
    }

    /// @notice Update the maturity tolerance parameters.
    /// @param minTrancheMaturitySec_ New minimum maturity time.
    /// @param maxTrancheMaturitySec_ New maximum maturity time.
    function updateTolerableTrancheMaturity(
        uint256 minTrancheMaturitySec_,
        uint256 maxTrancheMaturitySec_
    ) public onlyOwner {
        if (minTrancheMaturitySec_ > maxTrancheMaturitySec_) {
            revert UnacceptableParams();
        }
        minTrancheMaturitySec = minTrancheMaturitySec_;
        maxTrancheMaturitySec = maxTrancheMaturitySec_;
    }

    /// @notice Allows the owner to transfer non-critical assets out of the system if required.
    /// @param token The token address.
    /// @param to The destination address.
    /// @param amount The amount of tokens to be transferred.
    function transferERC20(IERC20Upgradeable token, address to, uint256 amount) external nonReentrant onlyOwner {
        if (_inReserve(token)) {
            revert UnauthorizedTransferOut();
        }
        token.safeTransfer(to, amount);
    }

    //--------------------------------------------------------------------------
    // Keeper only methods

    /// @notice Pauses deposits, withdrawals and rollovers.
    /// @dev ERC-20 functions, like transfers will always remain operational.
    function pause() external onlyKeeper {
        _pause();
    }

    /// @notice Unpauses deposits, withdrawals and rollovers.
    /// @dev ERC-20 functions, like transfers will always remain operational.
    function unpause() external onlyKeeper {
        _unpause();
    }

    /// @notice Updates the enforced maximum percentage value of deposit tranches.
    /// @dev Stored as a fixed point number with {PERC_DECIMALS} places.
    /// @param maxDepositTrancheValuePerc_ New max percentage.
    function updateMaxDepositTrancheValuePerc(uint256 maxDepositTrancheValuePerc_) public onlyKeeper {
        if (maxDepositTrancheValuePerc_ > ONE) {
            revert InvalidPerc();
        }
        maxDepositTrancheValuePerc = maxDepositTrancheValuePerc_;
    }

    //--------------------------------------------------------------------------
    // External methods

    /// @inheritdoc IPerpetualTranche
    function deposit(
        ITranche trancheIn,
        uint256 trancheInAmt
    ) external override onlyProtocol onAfterUpdateDepositBond nonReentrant whenNotPaused returns (uint256) {
        if (trancheIn != depositBond.seniorTranche()) {
            revert UnacceptableDeposit();
        }

        uint256 perpAmtMint = computeMintAmt(trancheIn, trancheInAmt);
        if (trancheInAmt <= 0 || perpAmtMint <= 0) {
            return 0;
        }

        // transfers tranche tokens from the sender to the reserve
        _transferIntoReserve(trancheIn, trancheInAmt);

        // mints perp tokens to the sender
        _mint(msg.sender, perpAmtMint);

        // post-deposit checks
        _enforceMintCap(trancheIn);

        return perpAmtMint;
    }

    /// @inheritdoc IPerpetualTranche
    function redeem(
        uint256 perpAmtBurnt
    ) external override onlyProtocol onAfterRecover nonReentrant whenNotPaused returns (TokenAmount[] memory) {
        // verifies if burn amount is acceptable
        if (perpAmtBurnt <= 0) {
            return new TokenAmount[](0);
        }

        TokenAmount[] memory tokensOut = computeRedemptionAmts(perpAmtBurnt);

        // burns perp tokens from the sender
        _burn(msg.sender, perpAmtBurnt);

        // transfers reserve tokens out
        uint8 tokensOutCount = uint8(tokensOut.length);
        for (uint8 i = 0; i < tokensOutCount; ++i) {
            if (tokensOut[i].amount > 0) {
                _transferOutOfReserve(tokensOut[i].token, tokensOut[i].amount);
            }
        }

        return tokensOut;
    }

    /// @inheritdoc IPerpetualTranche
    function rollover(
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmtAvailable
    )
        external
        override
        onlyVault
        onAfterUpdateDepositBond
        onAfterRecover
        nonReentrant
        whenNotPaused
        returns (RolloverData memory)
    {
        // verifies if rollover is acceptable
        bool acceptableRollover = (trancheIn == depositBond.seniorTranche() &&
            _inReserve(tokenOut) &&
            address(tokenOut) != address(trancheIn) &&
            (tokenOut == _reserveAt(0) || _isTimeForRollout(ITranche(address(tokenOut)))));
        if (!acceptableRollover) {
            revert UnacceptableRollover();
        }

        RolloverData memory r = computeRolloverAmt(trancheIn, tokenOut, trancheInAmtAvailable);

        // Verifies if rollover amount is acceptable
        if (r.trancheInAmt <= 0 || r.tokenOutAmt <= 0) {
            return r;
        }

        // transfers tranche tokens from the sender to the reserve
        _transferIntoReserve(trancheIn, r.trancheInAmt);

        // transfers tranche from the reserve to the sender
        _transferOutOfReserve(tokenOut, r.tokenOutAmt);

        return r;
    }

    //--------------------------------------------------------------------------
    // Public methods

    /// @inheritdoc IPerpetualTranche
    function updateState() public override {
        updateDepositBond();
        recover();
    }

    /// @inheritdoc IPerpetualTranche
    /// @dev Lazily queries the bond issuer to get the most recently issued bond
    ///      and updates with the new deposit bond if it's valid.
    function updateDepositBond() public override nonReentrant whenNotPaused returns (IBondController) {
        IBondController newBond = bondIssuer.getLatestBond();

        // If the new bond has been issued by the issuer and is "valid"
        if (depositBond != newBond && _isValidDepositBond(newBond)) {
            // updates `depositBond` with the new bond
            depositBond = newBond;
            emit UpdatedDepositBond(newBond);
        }

        return depositBond;
    }

    /// @inheritdoc IPerpetualTranche
    function recover() public override nonReentrant whenNotPaused {
        // Checks if every reserve tranche has reached maturity.
        // If so redeems the tranche balance for the underlying collateral and
        // removes the tranche from the reserve set.
        // NOTE: We traverse the reserve set in the reverse order
        //       as deletions involve swapping the deleted element to the
        //       end of the set and removing the last element.
        //       We also skip the `reserveAt(0)`, i.e) the underlying collateral,
        //       which is never removed.
        uint8 reserveCount_ = uint8(_reserves.length());
        for (uint8 i = reserveCount_ - 1; i > 0; i--) {
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

    /// @inheritdoc IPerpetualTranche
    function sync(IERC20Upgradeable token) public override nonReentrant whenNotPaused onlyBalancer {
        if (!_inReserve(token)) {
            revert UnexpectedAsset();
        }
        _syncReserve(token);
    }

    //--------------------------------------------------------------------------
    // External view methods

    /// @inheritdoc IPerpetualTranche
    function underlying() external view override returns (IERC20Upgradeable) {
        return _reserveAt(0);
    }

    /// @inheritdoc IPerpetualTranche
    function depositTranche() external view override returns (ITranche) {
        return depositBond.seniorTranche();
    }

    /// @inheritdoc IPerpetualTranche
    function depositTrancheRatio() external view override returns (uint256) {
        return depositBond.seniorTrancheRatio();
    }

    /// @inheritdoc IPerpetualTranche
    function reserveCount() external view override returns (uint256) {
        return _reserves.length();
    }

    /// @inheritdoc IPerpetualTranche
    function reserveAt(uint256 i) external view override returns (IERC20Upgradeable) {
        return _reserveAt(i);
    }

    /// @inheritdoc IPerpetualTranche
    function inReserve(IERC20Upgradeable token) external view override returns (bool) {
        return _inReserve(token);
    }

    /// @inheritdoc IPerpetualTranche
    function reserveTokenBalance(IERC20Upgradeable token) external view override returns (uint256) {
        if (!_inReserve(token)) {
            return 0;
        }
        return token.balanceOf(address(this));
    }

    /// @inheritdoc IPerpetualTranche
    function reserveTokenValue(IERC20Upgradeable token) external view override returns (uint256) {
        if (!_inReserve(token)) {
            return 0;
        }
        if (_isUnderlying(token)) {
            return token.balanceOf(address(this));
        }

        ITranche tranche = ITranche(address(token));
        IBondController parentBond = IBondController(tranche.bond());
        return
            _computeReserveTrancheValue(
                tranche,
                parentBond,
                _reserveAt(0),
                tranche.balanceOf(address(this)),
                MathUpgradeable.Rounding.Up
            );
    }

    /// @inheritdoc IPerpetualTranche
    function reserveTokensUpForRollover() external view override returns (IERC20Upgradeable[] memory) {
        uint8 reserveCount_ = uint8(_reserves.length());
        IERC20Upgradeable[] memory activeRolloverTokens = new IERC20Upgradeable[](reserveCount_);

        // We count the number of tokens up for rollover.
        uint8 numTokensUpForRollover = 0;

        // If any underlying collateral exists it can be rolled over.
        IERC20Upgradeable underlying_ = _reserveAt(0);
        if (underlying_.balanceOf(address(this)) > 0) {
            activeRolloverTokens[0] = underlying_;
            numTokensUpForRollover++;
        }

        // Iterating through the reserve to find tranches that are ready to be rolled out.
        for (uint8 i = 1; i < reserveCount_; i++) {
            IERC20Upgradeable token = _reserveAt(i);
            if (_isTimeForRollout(ITranche(address(token)))) {
                activeRolloverTokens[i] = token;
                numTokensUpForRollover++;
            }
        }

        // We recreate a smaller array with just the tokens up for rollover.
        IERC20Upgradeable[] memory rolloverTokens = new IERC20Upgradeable[](numTokensUpForRollover);
        uint8 j = 0;
        for (uint8 i = 0; i < reserveCount_; i++) {
            if (address(activeRolloverTokens[i]) != address(0)) {
                rolloverTokens[j++] = activeRolloverTokens[i];
            }
        }

        return rolloverTokens;
    }

    /// @inheritdoc IPerpetualTranche
    function deviationRatio() external view override returns (uint256) {
        return balancer.deviationRatio();
    }

    //--------------------------------------------------------------------------
    // Public view methods

    /// @notice Returns the number of decimals used to get its user representation.
    /// @dev For example, if `decimals` equals `2`, a balance of `505` tokens should
    ///      be displayed to a user as `5.05` (`505 / 10 ** 2`).
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @inheritdoc IPerpetualTranche
    function computeMintAmt(ITranche trancheIn, uint256 trancheInAmt) public view override returns (uint256) {
        uint256 perpSupply = totalSupply();
        uint256 perpAmtMint = _computeReserveTrancheValue(
            trancheIn,
            depositBond,
            _reserveAt(0),
            trancheInAmt,
            MathUpgradeable.Rounding.Down
        );
        if (perpSupply > 0) {
            perpAmtMint = perpAmtMint.mulDiv(perpSupply, getTVL());
        }
        return perpAmtMint;
    }

    /// @inheritdoc IPerpetualTranche
    function computeRedemptionAmts(uint256 perpAmtBurnt) public view override returns (TokenAmount[] memory) {
        uint256 perpSupply = totalSupply();
        uint8 reserveCount_ = uint8(_reserves.length());
        TokenAmount[] memory reserveTokens = new TokenAmount[](reserveCount_);
        for (uint8 i = 0; i < reserveCount_; i++) {
            IERC20Upgradeable tokenOut = _reserveAt(i);
            reserveTokens[i] = TokenAmount({
                token: tokenOut,
                amount: tokenOut.balanceOf(address(this)).mulDiv(perpAmtBurnt, perpSupply)
            });
        }
        return reserveTokens;
    }

    /// @inheritdoc IPerpetualTranche
    function computeRolloverAmt(
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmtAvailable
    ) public view override returns (RolloverData memory) {
        //-----------------------------------------------------------------------------
        // The rollover fees are settled by, adjusting the exchange rate
        // between `trancheInAmt` and `tokenOutAmt`.
        //
        int256 feePerc = balancer.computeRolloverFeePerc(
            balancer.computeDeviationRatio(
                SubscriptionParams({
                    perpTVL: getTVL(),
                    vaultTVL: IRolloverVault(vault).getTVL(),
                    seniorTR: depositBond.seniorTrancheRatio()
                })
            )
        );
        //-----------------------------------------------------------------------------

        // We compute "price" as the value of a unit token.
        // The perp, tranche tokens and the underlying are denominated as fixed point numbers
        // with the same number of decimals.
        IERC20Upgradeable underlying_ = _reserveAt(0);
        uint256 unitTokenAmt = (10 ** _decimals);
        uint256 trancheInPrice = _computeReserveTrancheValue(
            trancheIn,
            depositBond,
            underlying_,
            unitTokenAmt,
            MathUpgradeable.Rounding.Down
        );
        uint256 tokenOutPrice = unitTokenAmt;
        if (tokenOut != underlying_) {
            ITranche trancheOut = ITranche(address(tokenOut));
            tokenOutPrice = _computeReserveTrancheValue(
                trancheOut,
                IBondController(trancheOut.bond()),
                underlying_,
                unitTokenAmt,
                MathUpgradeable.Rounding.Up
            );
        }

        uint256 tokenOutBalance = tokenOut.balanceOf(address(this));
        if (trancheInAmtAvailable <= 0 || tokenOutBalance <= 0 || trancheInPrice <= 0 || tokenOutPrice <= 0) {
            return RolloverData({ trancheInAmt: 0, tokenOutAmt: 0 });
        }
        //-----------------------------------------------------------------------------
        // Basic rollover with fees:
        // (1 +/- f) . (trancheInAmt . trancheInPrice) = (tokenOutAmt . tokenOutPrice)
        //-----------------------------------------------------------------------------

        // Using perp's tokenOutBalance, we calculate the amount of tokens in to rollover
        // the entire balance.

        RolloverData memory r = RolloverData({
            tokenOutAmt: tokenOutBalance,
            trancheInAmt: tokenOutBalance.mulDiv(tokenOutPrice, trancheInPrice, MathUpgradeable.Rounding.Up)
        });

        // A positive fee percentage implies that perp charges the vault by
        // offering tranchesOut for a premium, i.e) more tranches in.
        if (feePerc > 0) {
            r.trancheInAmt = r.trancheInAmt.mulDiv(ONE, ONE - feePerc.toUint256(), MathUpgradeable.Rounding.Up);
        }
        // A negative fee percentage (or a reward) implies that perp pays the the vault by
        // offering tranchesOut at a discount, i.e) fewer tranches in.
        else if (feePerc < 0) {
            r.trancheInAmt = r.trancheInAmt.mulDiv(ONE, ONE + feePerc.abs(), MathUpgradeable.Rounding.Up);
        }

        //-----------------------------------------------------------------------------

        // When the trancheInAmt exceeds trancheInAmtAvailable:
        // we fix trancheInAmt = trancheInAmtAvailable and re-calculate tokenOutAmt

        if (r.trancheInAmt > trancheInAmtAvailable) {
            // Given the amount of tranches In, we compute the amount of tokens out
            r.trancheInAmt = trancheInAmtAvailable;
            r.tokenOutAmt = trancheInAmtAvailable.mulDiv(trancheInPrice, tokenOutPrice);

            // A positive fee percentage implies that perp charges the vault by
            // accepting tranchesIn at a discount, i.e) fewer tokens out.
            // This results in perp enrichment.
            if (feePerc > 0) {
                r.tokenOutAmt = r.tokenOutAmt.mulDiv(ONE - feePerc.abs(), ONE);
            }
            // A negative fee percentage (or a reward) implies that perp pays the the vault by
            // accepting tranchesIn at a premium, i.e) more tokens out.
            // This results in perp debasement.
            else if (feePerc < 0) {
                r.tokenOutAmt = r.tokenOutAmt.mulDiv(ONE + feePerc.abs(), ONE);
            }
        }

        return r;
    }

    /// @inheritdoc IPerpetualTranche
    /// @dev Returns a fixed point with the same decimals as the underlying collateral.
    function getTVL() public view override returns (uint256) {
        IERC20Upgradeable underlying_ = _reserveAt(0);
        uint256 totalVal = underlying_.balanceOf(address(this));
        uint8 reserveCount_ = uint8(_reserves.length());
        for (uint8 i = 1; i < reserveCount_; i++) {
            ITranche tranche = ITranche(address(_reserveAt(i)));
            IBondController parentBond = IBondController(tranche.bond());
            totalVal += _computeReserveTrancheValue(
                tranche,
                parentBond,
                underlying_,
                tranche.balanceOf(address(this)),
                MathUpgradeable.Rounding.Up
            );
        }
        return totalVal;
    }

    //--------------------------------------------------------------------------
    // Private methods

    /// @dev Transfers tokens from the caller (msg.sender) and updates the reserve set.
    /// @return Reserve's token balance after transfer in.
    function _transferIntoReserve(IERC20Upgradeable token, uint256 trancheAmt) private returns (uint256) {
        token.safeTransferFrom(msg.sender, address(this), trancheAmt);
        return _syncReserve(token);
    }

    /// @dev Transfers tokens from self into the caller (msg.sender) and updates the reserve set.
    /// @return Reserve's token balance after transfer out.
    function _transferOutOfReserve(IERC20Upgradeable token, uint256 tokenAmt) private returns (uint256) {
        token.safeTransfer(msg.sender, tokenAmt);
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

            if (_reserves.length() > MAX_RESERVE_COUNT) {
                revert ReserveCountOverLimit();
            }
        } else if (balance <= 0 && inReserve_) {
            // Removes tranche from reserve set.
            _reserves.remove(address(token));
        }

        return balance;
    }

    /// @dev Enforces the deposit tranche mint cap. To be invoked AFTER the mint operation.
    function _enforceMintCap(ITranche depositTranche_) private view {
        // Checks if the value of deposit tranche relative to the other tranches in the reserve
        // is no higher than the defined limit.
        //
        // NOTE: We consider the tranches which are up for rollover and mature collateral (if any),
        // to be part of the deposit tranche, as given enough time
        // they will be eventually rolled over into the deposit tranche.
        IERC20Upgradeable underlying_ = _reserveAt(0);
        uint256 totalVal = underlying_.balanceOf(address(this));
        uint256 depositTrancheValue = totalVal;
        uint8 reserveCount_ = uint8(_reserves.length());
        for (uint8 i = 1; i < reserveCount_; ++i) {
            ITranche tranche = ITranche(address(_reserveAt(i)));
            uint256 trancheValue = _computeReserveTrancheValue(
                tranche,
                IBondController(tranche.bond()),
                underlying_,
                tranche.balanceOf(address(this)),
                MathUpgradeable.Rounding.Up
            );
            if (tranche == depositTranche_ || _isTimeForRollout(tranche)) {
                depositTrancheValue += trancheValue;
            }
            totalVal += trancheValue;
        }
        uint256 depositTrancheValuePerc = depositTrancheValue.mulDiv(ONE, totalVal, MathUpgradeable.Rounding.Up);
        if (depositTrancheValuePerc > maxDepositTrancheValuePerc) {
            revert ExceededMaxMintPerTranche();
        }
    }

    /// @dev Checks if the given bond is valid and can be accepted into the reserve.
    ///      * Expects the bond to to have the same collateral token as perp.
    ///      * Expects the bond to have only two tranches.
    ///      * Expects the bond controller to not withhold any fees.
    ///      * Expects the bond's time to maturity to be within the max safety bound.
    ///      * Expects the bond's senior and junior tranches to point back to the bond.
    /// @return True if the bond is valid.
    function _isValidDepositBond(IBondController bond) private view returns (bool) {
        return (bond.collateralToken() == address(_reserveAt(0)) &&
            bond.trancheCount() == 2 &&
            bond.feeBps() == 0 &&
            bond.secondsToMaturity() < maxTrancheMaturitySec &&
            (bond.trancheAt(0)).bond() == address(bond) &&
            (bond.trancheAt(1)).bond() == address(bond));
    }

    /// @dev Checks if the given tranche's parent bond's time remaining to maturity is less than `minTrancheMaturitySec`.
    /// @return True if the tranche can be rolled out of perp.
    function _isTimeForRollout(ITranche tranche) private view returns (bool) {
        // NOTE: `secondsToMaturity` will be 0 if the bond is past maturity.
        return (IBondController(tranche.bond()).secondsToMaturity() <= minTrancheMaturitySec);
    }

    /// @dev Fetches the reserve token by index.
    function _reserveAt(uint256 i) private view returns (IERC20Upgradeable) {
        return IERC20Upgradeable(_reserves.at(i));
    }

    /// @dev Checks if the given token is in the reserve.
    function _inReserve(IERC20Upgradeable token) private view returns (bool) {
        return _reserves.contains(address(token));
    }

    /// @dev Computes the value of the given amount reserve tranche tokens (i.e ones already accepted in the reserve or to be accepted),
    ///      based on it's current CDR.
    ///      NOTE: Callers should round up when valuing reserve assets and round down for incoming assets.
    function _computeReserveTrancheValue(
        ITranche tranche,
        IBondController parentBond,
        IERC20Upgradeable collateralToken,
        uint256 trancheAmt,
        MathUpgradeable.Rounding rounding
    ) private view returns (uint256) {
        // NOTE: `getTrancheCollateralization` computes the claimable value even if the tranche is mature.
        (uint256 trancheClaim, uint256 trancheSupply) = tranche.getTrancheCollateralization(
            parentBond,
            collateralToken
        );
        // Tranche supply is zero (its parent bond has no deposits yet);
        // the tranche's CDR is assumed 1.0.
        return (trancheSupply > 0) ? trancheClaim.mulDiv(trancheAmt, trancheSupply, rounding) : trancheAmt;
    }

    /// @dev Checks if the given token is the underlying collateral token.
    function _isUnderlying(IERC20Upgradeable token) private view returns (bool) {
        return (token == _reserveAt(0));
    }
}
