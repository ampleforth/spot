// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { AddressQueueHelpers } from "./_utils/AddressQueueHelpers.sol";
import { TrancheData, TrancheDataHelpers, BondHelpers } from "./_utils/BondHelpers.sol";

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ITranche } from "./_interfaces/buttonwood/ITranche.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";

import { IPerpetualTranche } from "./_interfaces/IPerpetualTranche.sol";
import { IBondIssuer } from "./_interfaces/IBondIssuer.sol";
import { IFeeStrategy } from "./_interfaces/IFeeStrategy.sol";
import { IPricingStrategy } from "./_interfaces/IPricingStrategy.sol";

/// @notice Expected bond issuer to not be `address(0)`.
error UnacceptableBondIssuer();

/// @notice Expected fee strategy to not be `address(0)`.
error UnacceptableFeeStrategy();

/// @notice Expected pricing strategy to not be `address(0)`.
error UnacceptablePricingStrategy();

/// @notice Expected pricing strategy to return a fixed point with exactly {PRICE_DECIMALS} decimals.
error InvalidPricingStrategyDecimals();

/// @notice Expected minTrancheMaturity be less than or equal to maxTrancheMaturity.
/// @param minTrancheMaturiySec Minimum tranche maturity time in seconds.
/// @param minTrancheMaturiySec Maximum tranche maturity time in seconds.
error InvalidTrancheMaturityBounds(uint256 minTrancheMaturiySec, uint256 maxTrancheMaturiySec);

/// @notice Expected transfer out asset to not be a reserve asset.
/// @param token Address of the token transferred.
error UnauthorizedTransferOut(IERC20Upgradeable token);

/// @notice Expected deposited tranche to be of current deposit bond.
/// @param trancheIn Address of the deposit tranche.
/// @param depositBond Address of the currently accepted deposit bond.
error UnacceptableDepositTranche(ITranche trancheIn, IBondController depositBond);

/// @notice Expected to mint a non-zero amount of tokens.
/// @param trancheInAmt The amount of tranche tokens deposited.
/// @param mintAmt The amount of tranche tokens mint.
error UnacceptableMintAmt(uint256 trancheInAmt, uint256 mintAmt);

/// @notice Expected to redeem current redemption tranche.
/// @param trancheOut Address of the withdrawn tranche.
/// @param redemptionTranche Address of the next tranche up for redemption.
error UnacceptableRedemptionTranche(ITranche trancheOut, ITranche redemptionTranche);

/// @notice Expected to burn a non-zero amount of tokens.
/// @param trancheOutAmt The amount of tranche tokens withdrawn.
/// @param requestedBurnAmt The amount of tranche tokens requested to be burnt.
error UnacceptableBurnAmt(uint256 trancheOutAmt, uint256 requestedBurnAmt);

/// @notice Expected rollover to be acceptable.
/// @param trancheIn Address of the tranche token transferred in.
/// @param trancheOut Address of the tranche token transferred out.
error UnacceptableRollover(ITranche trancheIn, ITranche trancheOut);

/// @notice Expected to rollover a non-zero amount of tokens.
/// @param trancheInAmt The amount of tranche tokens deposited.
/// @param trancheOutAmt The amount of tranche tokens withdrawn.
/// @param rolloverAmt The perp denominated value of tokens rolled over.
error UnacceptableRolloverAmt(uint256 trancheInAmt, uint256 trancheOutAmt, uint256 rolloverAmt);

/// @notice Expected supply to be lower than the defined max supply.
/// @param newSupply The new total supply after minting.
/// @param currentMaxSupply The current max supply.
error ExceededMaxSupply(uint256 newSupply, uint256 currentMaxSupply);

/// @notice Expected the total mint amount per tranche to be lower than the limit.
/// @param trancheIn Address of the deposit tranche.
/// @param mintAmtForCurrentTranche The amount of perp tokens that have been minted using the tranche.
/// @param maxMintAmtPerTranche The amount of perp tokens that can be minted per tranche.
error ExceededMaxMintPerTranche(ITranche trancheIn, uint256 mintAmtForCurrentTranche, uint256 maxMintAmtPerTranche);

/*
 *  @title PerpetualTranche
 *
 *  @notice An opinionated implementation of a perpetual tranche ERC-20 token contract.
 *
 *          Perp tokens are backed by tranche tokens. Users can mint perp tokens by depositing tranches.
 *          They can redeem tranches by burning their perp tokens.
 *
 *          Users can ONLY mint perp tokens for tranches belonging to the active "deposit" bond.
 *
 *          The PerpetualTranche contract enforces tranche redemption through a FIFO queue.
 *          1) The queue is ordered by the maturity date, the tail of the queue has the newest issued tranches
 *             i.e) the one that matures furthest out into the future.
 *          2) When a user deposits a tranche belonging to the depositBond for the first time,
 *             it is added to the tail of the queue.
 *          3) When a user burns perp tokens, it iteratively redeems tranches from the head of the queue
 *             till the requested amount is covered.
 *          4) Tranches which are about to mature are removed from the tranche queue.
 *          5) If the queue is empty the users cant redeem anything until the queue has tranches again
 *             (either through more minting or rolling over).
 *
 *          Once tranches (that are about to mature) are removed from the queue,
 *          they enter a holding area called the "icebox".
 *
 *          Incentivized parties can "rollover" older tranches in the icebox for
 *          newer tranches that belong to the "depositBond".
 *
 *          At any time perp contract holds 2 classes of tokens. "reserve" tokens and "non-reserve" tokens.
 *          The system maintains a list of tokens which it considers are "reserve" tokens.
 *          The reserve tokens are the list of tranche tokens which back the supply of perp tokens.
 *          These reserve tokens can only leave the system on "redeem" and "rollover".
 *          Non reserve assets on the other hand can be transferred out by the contract owner if need be.
 *
 *          The tranche queue is updated "lazily" without a need for an explicit poke from the outside world.
 *          NOTE: Every external function that deals with the queue invokes the `afterQueueUpdate` modifier
 *                at the entry-point. This brings the queue storage state up to date.
 *                All code then on assumes the queue is up to date and interacts
 *                with the queue storage state variables directly.
 *
 */
contract PerpetualTranche is ERC20Upgradeable, OwnableUpgradeable, IPerpetualTranche {
    // math
    using MathUpgradeable for uint256;
    using SafeCastUpgradeable for uint256;
    using SignedMathUpgradeable for int256;

    // data handling
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.AddressSet;
    using AddressQueueHelpers for AddressQueueHelpers.AddressQueue;
    using BondHelpers for IBondController;
    using TrancheDataHelpers for TrancheData;

    // ERC20 operations
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using SafeERC20Upgradeable for ITranche;

    //-------------------------------------------------------------------------
    // Constants & Immutables
    uint8 public constant YIELD_DECIMALS = 18;
    uint8 public constant PRICE_DECIMALS = 8;

    // @dev Number of ERC-20 decimal places to get the perp token amount for user representation.
    uint8 private _decimals;

    //-------------------------------------------------------------------------
    // Data

    // @notice Issuer stores a predefined bond config and frequency and issues new bonds when poked
    // @dev Only tranches of bonds issued by the whitelisted issuer are accepted by the system.
    IBondIssuer public bondIssuer;

    // @notice External contract points to the fee token and computes mint, burn and rollover fees.
    IFeeStrategy public override feeStrategy;

    // @notice External contract that computes a given tranche's price.
    // @dev The computed price is expected to be a fixed point unsigned integer with {PRICE_DECIMALS} decimals.
    IPricingStrategy public pricingStrategy;

    // @notice A FIFO queue of tranches ordered by maturity time used to enforce redemption ordering.
    // @dev Most recently created tranches pushed to the tail of the queue (on deposit) and
    //      the oldest ones are pulled from the head of the queue (on redemption).
    AddressQueueHelpers.AddressQueue private _redemptionQueue;

    // @notice A record of all tranches with a balance held in the reserve which backs perp token supply.
    EnumerableSetUpgradeable.AddressSet private _reserve;

    // TODO: allow multiple deposit bonds
    // @notice The active deposit bond of whose tranches are currently being accepted as deposits
    //         to mint perp tokens.
    IBondController private _depositBond;

    // @notice The minimum maturity time in seconds for a tranche below which
    //         it can get removed from the tranche queue.
    uint256 public minTrancheMaturiySec;

    // @notice The maximum maturity time in seconds for a tranche above which
    //         it can NOT get added into the tranche queue.
    uint256 public maxTrancheMaturiySec;

    // @notice The maximum supply of perp tokens that can exist at any given time.
    uint256 public maxSupply;

    // @notice The max number of perp tokens that can be minted for each tranche in the minting bond.
    uint256 public maxMintAmtPerTranche;

    // @notice The total number of perp tokens that have been minted using a given tranche.
    mapping(ITranche => uint256) private _totalMintAmtPerTranche;

    // @notice Yield factor defined for a particular "class" of tranches.
    //         Any tranche's class is defined as the unique combination of:
    //          - it's collateralToken
    //          - it's parent bond's trancheRatios
    //          - it's seniorityIDX
    //
    // @dev For example:
    //      all AMPL [35-65] bonds can be configured to have a yield of [1, 0] and
    //      all AMPL [50-50] bonds can be configured to have a yield of [0.8,0]
    //
    //      An AMPL-A tranche token from any [35-65] bond will be applied a yield factor of 1.
    //      An AMPL-A tranche token from any [50-50] bond will be applied a yield factor of 0.8.
    //
    //      The yield is specified as a fixed point unsigned integer with {YIELD_DECIMALS} decimals.
    mapping(bytes32 => uint256) private _definedTrancheYields;

    // @notice Yield factor actually "applied" on each tranche instance. It is recorded when
    //         a particular tranche token is deposited into the system for the first time.
    //
    // @dev The yield factor is computed and set when a tranche instance enters the system for the first time.
    //      For all calculations thereafter, the set factor will be used.
    //      This distinction between the "defined" and "applied" yield allows the owner to safely
    //      update tranche yields without affecting the system's collateralization ratio.
    //      The yield is stored as a fixed point unsigned integer with {YIELD_DECIMALS} decimals
    mapping(ITranche => uint256) private _appliedTrancheYields;

    //--------------------------------------------------------------------------
    // Modifiers
    modifier afterQueueUpdate() {
        updateQueue();
        _;
    }

    //--------------------------------------------------------------------------
    // Construction & Initialization

    // @notice Contract state initialization.
    // @param name ERC-20 Name of the Perp token.
    // @param symbol ERC-20 Symbol of the Perp token.
    // @param decimals_ Number of ERC-20 decimal places.
    // @param bondIssuer_ Address of the bond issuer contract.
    // @param feeStrategy_ Address of the fee strategy contract.
    // @param pricingStrategy_ Address of the pricing strategy contract.
    function init(
        string memory name,
        string memory symbol,
        uint8 decimals_,
        IBondIssuer bondIssuer_,
        IFeeStrategy feeStrategy_,
        IPricingStrategy pricingStrategy_
    ) public initializer {
        __ERC20_init(name, symbol);
        _decimals = decimals_;

        __Ownable_init();

        updateBondIssuer(bondIssuer_);
        updateFeeStrategy(feeStrategy_);
        updatePricingStrategy(pricingStrategy_);

        minTrancheMaturiySec = 1;
        maxTrancheMaturiySec = type(uint256).max;

        maxSupply = 1000000 * (10**decimals_); // 1m
        maxMintAmtPerTranche = 200000 * (10**decimals_); // 200k

        _redemptionQueue.init();
    }

    //--------------------------------------------------------------------------
    // ADMIN only methods

    // @notice Update the reference to the bond issuer contract.
    // @param bondIssuer_ New bond issuer address.
    // @dev CAUTION: While updating the issuer, immediately set the defined
    //      yields for the new issuer's tranche config.
    function updateBondIssuer(IBondIssuer bondIssuer_) public onlyOwner {
        if (address(bondIssuer_) == address(0)) {
            revert UnacceptableBondIssuer();
        }
        bondIssuer = bondIssuer_;
        emit UpdatedBondIssuer(bondIssuer_);
    }

    // @notice Update the reference to the fee strategy contract.
    // @param feeStrategy_ New strategy address.
    function updateFeeStrategy(IFeeStrategy feeStrategy_) public onlyOwner {
        if (address(feeStrategy_) == address(0)) {
            revert UnacceptableFeeStrategy();
        }
        feeStrategy = feeStrategy_;
        emit UpdatedFeeStrategy(feeStrategy_);
    }

    // @notice Update the reference to the pricing strategy contract.
    // @param pricingStrategy_ New strategy address.
    function updatePricingStrategy(IPricingStrategy pricingStrategy_) public onlyOwner {
        if (address(pricingStrategy_) == address(0)) {
            revert UnacceptablePricingStrategy();
        }
        if (pricingStrategy_.decimals() != PRICE_DECIMALS) {
            revert InvalidPricingStrategyDecimals();
        }
        pricingStrategy = pricingStrategy_;
        emit UpdatedPricingStrategy(pricingStrategy_);
    }

    // @notice Update the maturity tolerance parameters.
    // @param minTrancheMaturiySec_ New minimum maturity time.
    // @param maxTrancheMaturiySec_ New maximum maturity time.
    // @dev NOTE: Setting `minTrancheMaturiySec` to 0 will mean bonds will remain in the queue
    //      past maturity.
    function updateTolerableTrancheMaturiy(uint256 minTrancheMaturiySec_, uint256 maxTrancheMaturiySec_)
        external
        onlyOwner
    {
        if (minTrancheMaturiySec_ > maxTrancheMaturiySec_) {
            revert InvalidTrancheMaturityBounds(minTrancheMaturiySec_, maxTrancheMaturiySec_);
        }
        minTrancheMaturiySec = minTrancheMaturiySec_;
        maxTrancheMaturiySec = maxTrancheMaturiySec_;
        emit UpdatedTolerableTrancheMaturiy(minTrancheMaturiySec_, maxTrancheMaturiySec_);
    }

    // @notice Update parameters controlling the perp token mint limits.
    // @param maxSupply_ New max total supply.
    // @param maxMintAmtPerTranche_ New max total for per tranche in minting bond.
    function updateMintingLimits(uint256 maxSupply_, uint256 maxMintAmtPerTranche_) external onlyOwner {
        maxSupply = maxSupply_;
        maxMintAmtPerTranche = maxMintAmtPerTranche_;
        emit UpdatedMintingLimits(maxSupply_, maxMintAmtPerTranche_);
    }

    // @notice Updates the tranche class's yields.
    // @param classHash The tranche class (hash(collteralToken, trancheRatios, seniority)).
    // @param yields The yield factor.
    function updateDefinedYield(bytes32 classHash, uint256 yield) external onlyOwner {
        if (yield > 0) {
            _definedTrancheYields[classHash] = yield;
        } else {
            delete _definedTrancheYields[classHash];
        }
        emit UpdatedDefinedTrancheYields(classHash, yield);
    }

    // @notice Allows the owner to transfer non-reserve assets out of the system if required.
    // @param token The token address.
    // @param to The destination address.
    // @param amount The amount of tokens to be transferred.
    function transferERC20(
        IERC20Upgradeable token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (inReserve(token)) {
            revert UnauthorizedTransferOut(token);
        }
        token.safeTransfer(to, amount);
    }

    //--------------------------------------------------------------------------
    // External methods

    /// @inheritdoc IPerpetualTranche
    function deposit(ITranche trancheIn, uint256 trancheInAmt)
        external
        override
        afterQueueUpdate
        returns (uint256 mintAmt, int256 mintFee)
    {
        if (IBondController(trancheIn.bond()) != _depositBond) {
            revert UnacceptableDepositTranche(trancheIn, _depositBond);
        }

        // calculates the amount of perp tokens the `trancheInAmt` of tranche tokens are worth
        mintAmt = tranchesToPerps(trancheIn, trancheInAmt);
        if (trancheInAmt == 0 || mintAmt == 0) {
            revert UnacceptableMintAmt(trancheInAmt, mintAmt);
        }

        // calculates the fee to mint `mintAmt` of perp token
        mintFee = feeStrategy.computeMintFee(mintAmt);

        // transfers deposited tranches from the sender to the reserve
        _transferIntoReserve(_msgSender(), trancheIn, trancheInAmt);

        // NOTE: Enqueues tranche if this is the first time the tranche token
        // is entering the system
        _checkAndEnqueueTranche(trancheIn);

        // mints perp tokens to the sender
        _mint(_msgSender(), mintAmt);

        // settles fees
        _settleFee(_msgSender(), mintFee);

        // updates the total amount minted using the given tranche
        _totalMintAmtPerTranche[trancheIn] += mintAmt;

        // enforces supply cap and tranche mint cap
        _enforceMintingLimits(trancheIn);

        return (mintAmt, mintFee);
    }

    /// @inheritdoc IPerpetualTranche
    function redeem(ITranche trancheOut, uint256 perpAmountRequested)
        external
        override
        afterQueueUpdate
        returns (uint256 burnAmt, int256 burnFee)
    {
        ITranche redemptionTranche = _redemptionTranche();

        // The system only allows burning perp tokens for the current redemption tranche
        // i.e) the head of the tranche queue.
        // When the queue is empty, the redemption operation fails.
        if (trancheOut != redemptionTranche) {
            revert UnacceptableRedemptionTranche(trancheOut, redemptionTranche);
        }

        // calculates the amount of tranche tokens covered to burn
        // up to `perpAmountRequested` perp tokens
        (uint256 trancheOutAmt, uint256 perpRemainder) = perpsToCoveredTranches(
            trancheOut,
            perpAmountRequested,
            type(uint256).max
        );
        if (trancheOutAmt == 0 || perpAmountRequested == 0) {
            revert UnacceptableBurnAmt(trancheOutAmt, perpAmountRequested);
        }

        // calculates the covered burn amount
        burnAmt = perpAmountRequested - perpRemainder;

        // calculates the fee to burn `burnAmt` of perp token
        burnFee = feeStrategy.computeBurnFee(burnAmt);

        // burns perp tokens from the sender
        _burn(_msgSender(), burnAmt);

        // settles fees
        _settleFee(_msgSender(), burnFee);

        // transfers redeemed tranches from the reserve to the sender
        uint256 reserveBalance = _transferOutOfReserve(_msgSender(), trancheOut, trancheOutAmt);

        // NOTE: If the tranche balance was burnt fully, dequeuing the tranche.
        if (reserveBalance == 0) {
            _dequeueTranche();
        }

        return (burnAmt, burnFee);
    }

    /// @inheritdoc IPerpetualTranche
    // @dev This will revert if the trancheOutAmt isn't covered.
    function rollover(
        ITranche trancheIn,
        ITranche trancheOut,
        uint256 trancheInAmt
    ) external override afterQueueUpdate returns (uint256 trancheOutAmt, int256 rolloverFee) {
        if (!_isAcceptableRollover(trancheIn, trancheOut)) {
            revert UnacceptableRollover(trancheIn, trancheOut);
        }

        // calculates the perp denominated amount rolled over
        uint256 rolloverAmt = tranchesToPerps(trancheIn, trancheInAmt);

        // calculates the amount of tranche tokens rolled out
        trancheOutAmt = perpsToTranches(trancheOut, rolloverAmt);
        if (trancheInAmt == 0 || trancheOutAmt == 0 || rolloverAmt == 0) {
            revert UnacceptableRolloverAmt(trancheInAmt, trancheOutAmt, rolloverAmt);
        }

        // calculates the fee to rollover `rolloverAmt` of perp token
        rolloverFee = feeStrategy.computeRolloverFee(rolloverAmt);

        // transfers tranche tokens from the sender to the reserve
        _transferIntoReserve(_msgSender(), trancheIn, trancheInAmt);

        // NOTE: Enqueues tranche if this is the first time the tranche token
        // is entering the system
        _checkAndEnqueueTranche(trancheIn);

        // transfers tranche tokens from the reserve to the sender
        _transferOutOfReserve(_msgSender(), trancheOut, trancheOutAmt);

        // settles fees
        _settleFee(_msgSender(), rolloverFee);

        return (trancheOutAmt, rolloverFee);
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Used in case an altruistic party intends to increase the collaterlization ratio.
    function burn(uint256 amount) external override returns (bool) {
        _burn(_msgSender(), amount);
        return true;
    }

    /// @inheritdoc IPerpetualTranche
    function getDepositBond() external override afterQueueUpdate returns (IBondController) {
        return _depositBond;
    }

    /// @inheritdoc IPerpetualTranche
    function getRedemptionTranche() external override afterQueueUpdate returns (ITranche tranche) {
        return _redemptionTranche();
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Lazily updates the queue before fetching from storage.
    function getRedemptionQueueCount() external override afterQueueUpdate returns (uint256) {
        return _redemptionQueue.length();
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Lazily updates the queue before fetching from storage.
    function getRedemptionQueueAt(uint256 i) external override afterQueueUpdate returns (address) {
        return _redemptionQueue.at(i);
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Lazily updates the queue before verifying state.
    function isAcceptableRollover(ITranche trancheIn, ITranche trancheOut)
        external
        override
        afterQueueUpdate
        returns (bool)
    {
        return _isAcceptableRollover(trancheIn, trancheOut);
    }

    //--------------------------------------------------------------------------
    // Public methods

    /// @inheritdoc IPerpetualTranche
    // @dev Lazily updates time-dependent queue state.
    //      This function is to be invoked on all external function entry points which are
    //      read data from the queue. This function is intended to be idempotent.
    function updateQueue() public override {
        // Lazily queries the bond issuer to get the most recently issued bond
        // and updates with the new deposit bond if it's "acceptable".
        IBondController newBond = bondIssuer.getLatestBond();

        // If the new bond has been issued by the issuer and is "acceptable"
        if (_depositBond != newBond && _isAcceptableForRedemptionQueue(newBond)) {
            // Storage optimization: Zeroing out mint amounts
            // from the previous deposit bond
            if(address(_depositBond) != address(0)){
                TrancheData memory td = _depositBond.getTrancheData();
                for (uint8 i = 0; i < td.trancheCount; i++) {
                    delete _totalMintAmtPerTranche[td.tranches[i]];
                }
            }

            // updates `_depositBond` with the new bond
            _depositBond = newBond;
        }

        // Lazily dequeues tranches from the tranche queue till the head of the
        // queue is an "acceptable" tranche.
        ITranche redemptionTranche = _redemptionTranche();
        while (
            address(redemptionTranche) != address(0) &&
            !_isAcceptableForRedemptionQueue(IBondController(redemptionTranche.bond()))
        ) {
            _dequeueTranche();
            redemptionTranche = _redemptionTranche();
        }
    }

    //--------------------------------------------------------------------------
    // External view methods

    /// @inheritdoc IPerpetualTranche
    function reserveCount() external view override returns (uint256) {
        return _reserve.length();
    }

    /// @inheritdoc IPerpetualTranche
    function reserveAt(uint256 i) external view override returns (address) {
        return _reserve.at(i);
    }

    /// @inheritdoc IPerpetualTranche
    function reserve() external view override returns (address) {
        return _self();
    }

    /// @inheritdoc IPerpetualTranche
    function feeCollector() external view override returns (address) {
        return _self();
    }

    //--------------------------------------------------------------------------
    // Public view methods

    /// @inheritdoc IPerpetualTranche
    function feeToken() public view override returns (IERC20Upgradeable) {
        return feeStrategy.feeToken();
    }

    /// @inheritdoc IPerpetualTranche
    function inReserve(IERC20Upgradeable token) public view override returns (bool) {
        return _reserve.contains(address(token));
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Gets the applied yield for the given tranche if it's set set,
    //      if NOT gets the defined tranche yield
    function trancheYield(ITranche tranche) public view override returns (uint256) {
        uint256 yield = _appliedTrancheYields[tranche];
        return yield > 0 ? yield : _definedTrancheYields[trancheClass(tranche)];
    }

    /// @inheritdoc IPerpetualTranche
    // @dev A given tranche's computed class is the
    //      hash(collteralToken, trancheRatios, seniority).
    function trancheClass(ITranche tranche) public view override returns (bytes32) {
        IBondController bond = IBondController(tranche.bond());
        TrancheData memory td = bond.getTrancheData();
        return keccak256(abi.encode(bond.collateralToken(), td.trancheRatios, td.getTrancheIndex(tranche)));
    }

    /// @inheritdoc IPerpetualTranche
    function tranchePrice(ITranche tranche) public view override returns (uint256) {
        return pricingStrategy.computeTranchePrice(tranche);
    }

    /// @inheritdoc IPerpetualTranche
    function tranchesToPerps(ITranche tranche, uint256 trancheAmt) public view override returns (uint256) {
        return _tranchesToPerps(trancheAmt, trancheYield(tranche), tranchePrice(tranche));
    }

    /// @inheritdoc IPerpetualTranche
    function perpsToTranches(ITranche tranche, uint256 amount) public view override returns (uint256) {
        return _perpsToTranches(amount, trancheYield(tranche), tranchePrice(tranche));
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Set `maxTrancheAmtCovered` to max(uint256) to use the current reserve balance.
    function perpsToCoveredTranches(
        ITranche tranche,
        uint256 perpAmountRequested,
        uint256 maxTrancheAmtCovered
    ) public view override returns (uint256, uint256) {
        return
            _perpsToCoveredTranches(
                perpAmountRequested,
                MathUpgradeable.min(maxTrancheAmtCovered, tranche.balanceOf(_self())),
                trancheYield(tranche),
                tranchePrice(tranche)
            );
    }

    // @notice Returns the number of decimals used to get its user representation.
    // @dev For example, if `decimals` equals `2`, a balance of `505` tokens should
    //      be displayed to a user as `5.05` (`505 / 10 ** 2`).
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    //--------------------------------------------------------------------------
    // Private/Internal helper methods

    // @dev If the given tranche isn't already part of the tranche queue,
    //      it is added to the tail of the queue and its yield factor is set.
    //      This is invoked when the tranche enters the system for the first time on deposit.
    function _checkAndEnqueueTranche(ITranche t) internal {
        if (!_redemptionQueue.contains(address(t))) {
            // Inserts new tranche into tranche queue
            _redemptionQueue.enqueue(address(t));
            emit TrancheEnqueued(t);

            // Stores the yield for future usage.
            uint256 yield = trancheYield(t);
            _appliedTrancheYields[t] = yield;
            emit TrancheYieldApplied(t, yield);
        }
    }

    // @dev Removes the tranche from the head of the queue.
    function _dequeueTranche() internal {
        emit TrancheDequeued(ITranche(_redemptionQueue.dequeue()));
    }

    // @dev The head of the tranche queue which is up for redemption next.
    function _redemptionTranche() internal view returns (ITranche) {
        return ITranche(_redemptionQueue.head());
    }

    // @dev Checks if the given tranche pair is a valid rollover.
    function _isAcceptableRollover(ITranche trancheIn, ITranche trancheOut) internal view returns (bool) {
        IBondController bondIn = IBondController(trancheIn.bond());
        IBondController bondOut = IBondController(trancheOut.bond());
        return (bondIn == _depositBond && // Expected trancheIn to be of deposit bond
            bondOut != _depositBond && // Expected trancheOut to NOT be of deposit bond
            inReserve(trancheOut) && // Expected trancheOut to be part of the reserve
            !_redemptionQueue.contains(address(trancheOut))); // Expected trancheOut to not be part of the queue
    }

    // @dev Enforces the mint limits. To be invoked AFTER the mint operation.
    function _enforceMintingLimits(ITranche trancheIn) internal view {
        // checks if new total supply is within the max supply cap
        uint256 newSupply = totalSupply();
        if (newSupply > maxSupply) {
            revert ExceededMaxSupply(newSupply, maxSupply);
        }

        // checks if total amount minted using the given tranche is within the cap
        if (_totalMintAmtPerTranche[trancheIn] > maxMintAmtPerTranche) {
            revert ExceededMaxMintPerTranche(trancheIn, _totalMintAmtPerTranche[trancheIn], maxMintAmtPerTranche);
        }
    }

    // @dev If the fee is positive, fee is transferred from the payer to the self
    //      else it's transferred to the payer from the self.
    //      NOTE: fee is a not-reserve asset.
    // @return True if the fee token used for settlement is the perp token.
    function _settleFee(address payer, int256 fee) internal returns (bool isNativeFeeToken) {
        IERC20Upgradeable feeToken_ = feeToken();
        isNativeFeeToken = (address(feeToken_) == _self());

        if (fee == 0) {
            return isNativeFeeToken;
        }

        uint256 fee_ = fee.abs();
        if (fee > 0) {
            // Funds are coming in
            // Handling a special case, when the fee is to be charged as the perp token itself
            // In this case we don't need to make an external call to the token ERC-20 to "transferFrom"
            // the payer, since this is still an internal call {msg.sender} will still point to the payer
            // and we can just "transfer" from the payer's wallet.
            if (isNativeFeeToken) {
                transfer(_self(), fee_);
            } else {
                feeToken_.safeTransferFrom(payer, _self(), fee_);
            }
        } else {
            // Funds are going out
            feeToken_.safeTransfer(payer, fee_);
        }

        return isNativeFeeToken;
    }

    // @dev Transfers tokens from the given address to self and updates the reserve list.
    // @return Reserve balance after transfer in.
    function _transferIntoReserve(
        address from,
        IERC20Upgradeable token,
        uint256 amount
    ) internal returns (uint256) {
        token.safeTransferFrom(from, _self(), amount);
        return _syncReserve(token);
    }

    // @dev Transfers tokens from self into the given address and updates the reserve list.
    // @return Reserve balance after transfer out.
    function _transferOutOfReserve(
        address to,
        IERC20Upgradeable token,
        uint256 amount
    ) internal returns (uint256) {
        token.safeTransfer(to, amount);
        return _syncReserve(token);
    }

    // @dev Keeps the list of tokens held in the reserve up to date.
    //      Perp tokens are backed by tokens in this list.
    // @return The reserve's token balance
    function _syncReserve(IERC20Upgradeable t) internal returns (uint256) {
        uint256 balance = t.balanceOf(_self());
        bool inReserve_ = inReserve(t);
        if (balance > 0 && !inReserve_) {
            _reserve.add(address(t));
        } else if (balance == 0 && inReserve_) {
            _reserve.remove(address(t));
        }
        emit ReserveSynced(t, balance);
        return balance;
    }

    // @dev Checks if the bond's tranches can be accepted into the tranche queue.
    //      * Expects the bond's maturity to be within expected bounds.
    // @return True if the bond is "acceptable".
    function _isAcceptableForRedemptionQueue(IBondController bond) private view returns (bool) {
        // NOTE: `timeToMaturity` will be 0 if the bond is past maturity.
        uint256 timeToMaturity = bond.timeToMaturity();
        return (timeToMaturity >= minTrancheMaturiySec && timeToMaturity < maxTrancheMaturiySec);
    }

    // @dev Alias to self.
    function _self() private view returns (address) {
        return address(this);
    }

    // @dev Calculates the tranche token amount for requested perp amount.
    //      If the tranche balance doesn't cover the exchange, it returns the remainder.
    function _perpsToCoveredTranches(
        uint256 perpAmountRequested,
        uint256 trancheAmtCovered,
        uint256 yield,
        uint256 price
    ) private pure returns (uint256 trancheAmtUsed, uint256 perpRemainder) {
        uint256 trancheAmtForRequested = _perpsToTranches(perpAmountRequested, yield, price);
        trancheAmtUsed = MathUpgradeable.min(trancheAmtForRequested, trancheAmtCovered);
        perpRemainder = trancheAmtUsed > 0
            ? (perpAmountRequested * (trancheAmtForRequested - trancheAmtUsed)).ceilDiv(trancheAmtForRequested)
            : perpAmountRequested;
        return (trancheAmtUsed, perpRemainder);
    }

    // @dev Calculates perp token amount from tranche amount.
    //      perp = (tranche * yield) * price
    function _tranchesToPerps(
        uint256 trancheAmt,
        uint256 yield,
        uint256 price
    ) private pure returns (uint256) {
        return (((trancheAmt * yield) / (10**YIELD_DECIMALS)) * price) / (10**PRICE_DECIMALS);
    }

    // @dev Calculates tranche token amount from perp amount.
    //      tranche = perp / (price * yield)
    function _perpsToTranches(
        uint256 amount,
        uint256 yield,
        uint256 price
    ) private pure returns (uint256) {
        if (yield == 0 || price == 0) {
            return 0;
        }
        return (((amount * (10**PRICE_DECIMALS)) / price) * (10**YIELD_DECIMALS)) / yield;
    }
}
