// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { SignedMath } from "@openzeppelin/contracts/utils/math/SignedMath.sol";

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { AddressQueue, AddressQueueHelpers } from "./_utils/AddressQueueHelpers.sol";
import { TrancheData, TrancheDataHelpers, BondHelpers } from "./_utils/BondHelpers.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ITranche } from "./_interfaces/buttonwood/ITranche.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";

import { IPerpetualTranche } from "./_interfaces/IPerpetualTranche.sol";
import { IBondIssuer } from "./_interfaces/IBondIssuer.sol";
import { IFeeStrategy } from "./_interfaces/IFeeStrategy.sol";
import { IPricingStrategy } from "./_interfaces/IPricingStrategy.sol";

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
 *
 *          Once tranches are removed from the queue, they entire a holding area called the "icebox".
 *          Tranches in the icebox can only be redeemed when the tranche queue is empty.
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
 *
 */
contract PerpetualTranche is ERC20, Initializable, Ownable, IPerpetualTranche {
    using Math for uint256;
    using SafeCast for uint256;
    using SignedMath for int256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ITranche;
    using EnumerableSet for EnumerableSet.AddressSet;
    using AddressQueueHelpers for AddressQueue;
    using BondHelpers for IBondController;
    using TrancheDataHelpers for TrancheData;

    //-------------------------------------------------------------------------
    // Constants & Immutables
    uint8 public constant YIELD_DECIMALS = 18;
    uint8 public constant PRICE_DECIMALS = 8;

    // @dev Number of ERC-20 decimal places to get the perp token amount for user representation.
    uint8 private immutable _decimals;

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
    AddressQueue private _redemptionQueue;

    // @notice A record of all tranches with a balance held in the reserve which backs perp token supply.
    EnumerableSet.AddressSet private _reserves;

    // TODO: allow multiple deposit bonds
    // @notice The active deposit bond of whose tranches are currently being accepted as deposits
    //         to mint perp tokens.
    IBondController private _depositBond;

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

    // @notice The minimum maturity time in seconds for a tranche below which
    //         it can get removed from the tranche queue.
    uint256 public minTrancheMaturiySec;

    // @notice The maximum maturity time in seconds for a tranche above which
    //         it can NOT get added into the tranche queue.
    uint256 public maxTrancheMaturiySec;

    //--------------------------------------------------------------------------
    // Construction & Initialization

    // @notice Constructor to create the contract.
    // @param name ERC-20 Name of the Perp token.
    // @param symbol ERC-20 Symbol of the Perp token.
    // @param decimals_ Number of ERC-20 decimal places.
    constructor(
        string memory name,
        string memory symbol,
        uint8 decimals_
    ) ERC20(name, symbol) {
        _decimals = decimals_;
    }

    // @notice Contract state initialization.
    // @param bondIssuer_ Address of the bond issuer contract.
    // @param feeStrategy_ Address of the fee strategy contract.
    // @param pricingStrategy_ Address of the pricing strategy contract.
    function init(
        IBondIssuer bondIssuer_,
        IFeeStrategy feeStrategy_,
        IPricingStrategy pricingStrategy_
    ) public initializer {
        updateBondIssuer(bondIssuer_);
        updateFeeStrategy(feeStrategy_);
        updatePricingStrategy(pricingStrategy_);

        minTrancheMaturiySec = 1;
        maxTrancheMaturiySec = type(uint256).max;

        _redemptionQueue.init();
    }

    //--------------------------------------------------------------------------
    // ADMIN only methods

    // @notice Update the reference to the bond issuer contract.
    // @param bondIssuer_ New bond issuer address.
    // @dev CAUTION: While updating the issuer, immediately set the defined
    //      yields for the new issuer's tranche config.
    function updateBondIssuer(IBondIssuer bondIssuer_) public onlyOwner {
        require(address(bondIssuer_) != address(0), "Expected new bond issuer to be set");
        bondIssuer = bondIssuer_;
        emit UpdatedBondIssuer(bondIssuer_);
    }

    // @notice Update the reference to the fee strategy contract.
    // @param feeStrategy_ New strategy address.
    function updateFeeStrategy(IFeeStrategy feeStrategy_) public onlyOwner {
        require(address(feeStrategy_) != address(0), "Expected new fee strategy to be set");
        feeStrategy = feeStrategy_;
        emit UpdatedFeeStrategy(feeStrategy_);
    }

    // @notice Update the reference to the pricing strategy contract.
    // @param pricingStrategy_ New strategy address.
    function updatePricingStrategy(IPricingStrategy pricingStrategy_) public onlyOwner {
        require(address(pricingStrategy_) != address(0), "Expected new pricing strategy to be set");
        require(pricingStrategy_.decimals() == PRICE_DECIMALS, "Expected new pricing strategy to use same decimals");
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
        require(minTrancheMaturiySec_ <= maxTrancheMaturiySec_, "Expected max to be greater than min");
        minTrancheMaturiySec = minTrancheMaturiySec_;
        maxTrancheMaturiySec = maxTrancheMaturiySec_;
        emit UpdatedTolerableTrancheMaturiy(minTrancheMaturiySec_, maxTrancheMaturiySec_);
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
        IERC20 token,
        address to,
        uint256 amount
    ) external onlyOwner {
        require(!inReserve(token), "Expected token to NOT be reserve asset");
        token.safeTransfer(to, amount);
    }

    //--------------------------------------------------------------------------
    // External methods

    /// @inheritdoc IPerpetualTranche
    function deposit(ITranche trancheIn, uint256 trancheInAmt)
        external
        override
        returns (uint256 mintAmt, int256 mintFee)
    {
        IBondController bondIn = IBondController(trancheIn.bond());
        require(bondIn == getDepositBond(), "Expected tranche to be of deposit bond");

        // calculates the amount of perp tokens the `trancheInAmt` of tranche tokens are worth
        mintAmt = tranchesToPerps(trancheIn, trancheInAmt);
        require(mintAmt > 0 && trancheInAmt > 0, "Expected to mint a non-zero amount of tokens");

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

        return (mintAmt, mintFee);
    }

    /// @inheritdoc IPerpetualTranche
    function redeem(ITranche trancheOut, uint256 requestedAmount)
        external
        override
        returns (uint256 burnAmt, int256 burnFee)
    {
        ITranche burningTranche = getRedemptionTranche();

        // When tranche queue is NOT empty, redemption ordering is enforced.
        bool inOrderRedemption = address(burningTranche) != address(0);

        // The system only allows redemption of the burning tranche for perp tokens
        // i.e) the tranche at the head of the tranche queue.
        // When the queue is empty, any tranche held in the reserve can be redeemed.
        require(
            trancheOut == burningTranche || !inOrderRedemption,
            "Expected to redeem burning tranche or queue to be empty"
        );

        // calculates the amount of tranche tokens covered to burn `perpRemainder` perp tokens
        (uint256 trancheOutAmt, uint256 perpRemainder) = perpsToCoveredTranches(trancheOut, requestedAmount);
        require(requestedAmount > 0 && trancheOutAmt > 0, "Expected to burn a non-zero amount of tokens");

        // calculates the covered burn amount
        burnAmt = requestedAmount - perpRemainder;

        // calculates the fee to burn `burnAmt` of perp token
        burnFee = feeStrategy.computeBurnFee(burnAmt);

        // burns perp tokens from the sender
        _burn(_msgSender(), burnAmt);

        // settles fees
        _settleFee(_msgSender(), burnFee);

        // transfers redeemed tranches from the reserve to the sender
        uint256 reserveBalance = _transferOutOfReserve(_msgSender(), trancheOut, trancheOutAmt);

        // NOTE: When redeeming in order and if the tranche balance was burnt fully,
        //       Dequeuing the tranche.
        if (inOrderRedemption && reserveBalance == 0) {
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
    ) external override returns (uint256 trancheOutAmt, int256 rolloverFee) {
        IBondController depositBond = getDepositBond();
        IBondController bondIn = IBondController(trancheIn.bond());
        IBondController bondOut = IBondController(trancheOut.bond());

        require(bondIn == depositBond, "Expected trancheIn to be of deposit bond");
        require(bondOut != depositBond, "Expected trancheOut to NOT be of deposit bond");
        require(!_redemptionQueue.contains(address(trancheOut)), "Expected trancheOut to NOT be in the queue");

        // calculates the perp denominated amount rolled over
        uint256 rolloverAmt = tranchesToPerps(trancheIn, trancheInAmt);

        // calculates the amount of tranche tokens rolled out
        trancheOutAmt = perpsToTranches(trancheOut, rolloverAmt);
        require(
            rolloverAmt > 0 && trancheInAmt > 0 && trancheOutAmt > 0,
            "Expected to rollover a non-zero amount of tokens"
        );

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

    //--------------------------------------------------------------------------
    // Public methods

    /// @inheritdoc IPerpetualTranche
    // @dev Lazily queries the bond issuer to get the most recently issued bond
    //      and updates with the new deposit bond if it's "acceptable".
    function getDepositBond() public override returns (IBondController) {
        IBondController latestBond = bondIssuer.getLatestBond();

        // new bond has been issued by the issuer and is "acceptable"
        // update `_depositBond`
        if (_depositBond != latestBond && _isAcceptableForRedemptionQueue(latestBond)) {
            _depositBond = latestBond;
            return latestBond;
        }

        // use the deposit bond in storage
        return _depositBond;
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Lazily dequeues tranches from the tranche queue till the head of the
    //      queue is an "acceptable" tranche.
    // @return The updated head of the tranche queue which is up for redemption next.
    function getRedemptionTranche() public override returns (ITranche tranche) {
        ITranche tranche = ITranche(_redemptionQueue.head());

        while (address(tranche) != address(0) && !_isAcceptableForRedemptionQueue(IBondController(tranche.bond()))) {
            _dequeueTranche();
            tranche = ITranche(_redemptionQueue.head());
        }

        return tranche;
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Lazily updates the queue before fetching from storage.
    function getRedemptionQueueCount() public override returns (uint256) {
        getRedemptionTranche();
        return _redemptionQueue.length();
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Lazily updates the queue before fetching from storage.
    function getRedemptionQueueAt(uint256 i) public override returns (address) {
        getRedemptionTranche();
        return _redemptionQueue.at(i);
    }

    //--------------------------------------------------------------------------
    // External view methods

    /// @inheritdoc IPerpetualTranche
    function reserveCount() external view override returns (uint256) {
        return _reserves.length();
    }

    /// @inheritdoc IPerpetualTranche
    function reserveAt(uint256 i) external view override returns (address) {
        return _reserves.at(i);
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
    function feeToken() public view override returns (IERC20) {
        return feeStrategy.feeToken();
    }

    /// @inheritdoc IPerpetualTranche
    function inReserve(IERC20 token) public view override returns (bool) {
        return _reserves.contains(address(token));
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Gets the applied yield for the given tranche if it's set,
    //      if NOT gets the defined tranche yield based on tranche's computed class,
    //      i.e) hash(collteralToken, trancheRatios, seniority).
    function trancheYield(ITranche t) public view override returns (uint256) {
        uint256 yield = _appliedTrancheYields[t];
        return yield > 0 ? yield : _definedTrancheYields[trancheClass(t)];
    }

    /// @inheritdoc IPerpetualTranche
    // @dev A given tranche's computed class is the
    //      hash(collteralToken, trancheRatios, seniority).
    function trancheClass(ITranche t) public view override returns (bytes32) {
        IBondController bond = IBondController(t.bond());
        TrancheData memory td = bond.getTrancheData();
        return keccak256(abi.encode(bond.collateralToken(), td.trancheRatios, td.getTrancheIndex(t)));
    }

    /// @inheritdoc IPerpetualTranche
    function tranchePrice(ITranche t) public view override returns (uint256) {
        return pricingStrategy.computeTranchePrice(t);
    }

    /// @inheritdoc IPerpetualTranche
    function tranchesToPerps(ITranche t, uint256 trancheAmt) public view override returns (uint256) {
        return _tranchesToPerps(trancheAmt, trancheYield(t), tranchePrice(t));
    }

    /// @inheritdoc IPerpetualTranche
    function perpsToTranches(ITranche t, uint256 amount) public view override returns (uint256) {
        return _perpsToTranches(amount, trancheYield(t), tranchePrice(t));
    }

    /// @inheritdoc IPerpetualTranche
    function perpsToCoveredTranches(ITranche t, uint256 requestedAmount)
        public
        view
        override
        returns (uint256, uint256)
    {
        return _perpsToCoveredTranches(t, requestedAmount, trancheYield(t), tranchePrice(t));
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

    // @dev If the fee is positive, fee is transferred from the payer to the self
    //      else it's transferred to the payer from the self.
    //      NOTE: fee is a not-reserve asset.
    // @return True if the fee token used for settlement is the perp token.
    function _settleFee(address payer, int256 fee) internal returns (bool isNativeFeeToken) {
        IERC20 feeToken_ = feeToken();
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
        IERC20 token,
        uint256 amount
    ) internal returns (uint256) {
        token.safeTransferFrom(from, _self(), amount);
        return _syncReserves(token);
    }

    // @dev Transfers tokens from self into the given address and updates the reserve list.
    // @return Reserve balance after transfer out.
    function _transferOutOfReserve(
        address to,
        IERC20 token,
        uint256 amount
    ) internal returns (uint256) {
        token.safeTransfer(to, amount);
        return _syncReserves(token);
    }

    // @dev Keeps the list of tokens held in the reserve up to date.
    //      Perp tokens are backed by tokens in this list.
    // @return The reserve's token balance
    function _syncReserves(IERC20 t) internal returns (uint256) {
        uint256 balance = t.balanceOf(_self());
        bool inReserve_ = inReserve(t);
        if (balance > 0 && !inReserve_) {
            _reserves.add(address(t));
        } else if (balance == 0 && inReserve_) {
            _reserves.remove(address(t));
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

    // @dev Calculates the tranche token amount for requested perp amount.
    //      If the tranche balance doesn't cover the exchange, it returns the remainder.
    function _perpsToCoveredTranches(
        ITranche t,
        uint256 requestedAmount,
        uint256 yield,
        uint256 price
    ) private view returns (uint256 trancheAmtUsed, uint256 perpRemainder) {
        uint256 trancheBalance = t.balanceOf(_self());
        uint256 trancheAmtForRequested = _perpsToTranches(requestedAmount, yield, price);
        trancheAmtUsed = Math.min(trancheAmtForRequested, trancheBalance);
        perpRemainder = trancheAmtUsed > 0
            ? (requestedAmount * (trancheAmtForRequested - trancheAmtUsed)).ceilDiv(trancheAmtForRequested)
            : requestedAmount;
        return (trancheAmtUsed, perpRemainder);
    }

    // @dev Alias to self.
    function _self() private view returns (address) {
        return address(this);
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
