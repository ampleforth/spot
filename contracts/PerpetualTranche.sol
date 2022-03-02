// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { SignedMath } from "@openzeppelin/contracts/utils/math/SignedMath.sol";

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AddressQueue, AddressQueueHelpers } from "./_utils/AddressQueueHelpers.sol";
import { TrancheData, TrancheDataHelpers, BondHelpers } from "./_utils/BondHelpers.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ITranche } from "./_interfaces/button-wood/ITranche.sol";
import { IBondController } from "./_interfaces/button-wood/IBondController.sol";

import { MintData, BurnData, RolloverData, IPerpetualTranche } from "./_interfaces/IPerpetualTranche.sol";
import { IBondIssuer } from "./_interfaces/IBondIssuer.sol";
import { IFeeStrategy } from "./_interfaces/IFeeStrategy.sol";
import { IPricingStrategy } from "./_interfaces/IPricingStrategy.sol";

/*
 *  @title PerpetualTranche
 *
 *  @notice An opinionated implementation of a perpetual tranche ERC-20 token contract.
 *          Perp tokens are backed by tranche tokens. Users can mint perp tokens by depositing tranches.
 *          They can redeem tranches by burning their perp tokens.
 *
 *          The PerpetualTranche contract enforces tranche deposits/redemption through a FIFO bond queue.
 *          The queue is ordered by the bond's maturity date, the tail of the queue has the newest bond
 *          ie) the one that matures furthest out into the future.
 *          Incentivized parties can "rollover" tranches which are approaching maturity for
 *          tranches at tail of the bond queue.
 *
 */
contract PerpetualTranche is ERC20, Initializable, Ownable, IPerpetualTranche {
    using SignedMath for int256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ITranche;
    using AddressQueueHelpers for AddressQueue;
    using BondHelpers for IBondController;
    using TrancheDataHelpers for TrancheData;

    //-------------------------------------------------------------------------
    // Constants & Immutables
    uint8 public constant YIELD_DECIMALS = 6;
    uint8 public constant PRICE_DECIMALS = 18;

    // @dev Number of ERC-20 decimal places to get the perp token amount for user representation.
    uint8 private immutable _decimals;

    //-------------------------------------------------------------------------
    // Data

    // @notice Issuer stores a pre-defined bond config and frequency, then issues new bonds when poked
    // @dev Only tranches of bonds issued by the whitelisted issuer are accepted by the system.
    IBondIssuer public bondIssuer;

    // @notice External contract points to the fee token and computes mint, burn fees and rollover rewards.
    IFeeStrategy public feeStrategy;

    // @notice External contract that computes a given tranche's price.
    // @dev The computed price is expected to be a fixed point unsigned integer with {PRICE_DECIMALS} decimals.
    IPricingStrategy public pricingStrategy;

    // @notice Yield factor applied on tranches transferred into or out of the system.
    // @dev A given tranche's yield is specific to it's parent bond's class
    //      ie) the unique combination of the bond's {collateralToken, trancheRatios}.
    //      The yield is specified as a fixed point unsigned integer with {YIELD_DECIMALS} decimals.
    mapping(bytes32 => uint256[]) private _trancheYields;

    // @notice A FIFO queue of bonds, each of which has an associated number of seniority-based tranches.
    // @dev The system only accepts tranches from bond at the tail of the queue to mint perpetual tokens.
    //      The system burns perpetual tokens for tranches from bonds at the head of the queue.
    AddressQueue public bondQueue;

    // @notice A record of all tokens currently being held by the reserve.
    // @dev Used by off-chain services for indexing tokens and their balances held by the reserve.
    mapping(IERC20 => bool) public reserveAssets;

    // @notice Bonds maturing less than this many seconds in the future are removed from the bond queue.
    uint256 public minMaturiySec;

    // @notice Bonds maturing more than this many seconds in the future can't get added into the bond queue.
    uint256 public maxMaturiySec;

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
    // @param pricingStrategy_ Address of the pricing strategy contract.
    // @param feeStrategy_ Address of the fee strategy contract.
    function init(
        IBondIssuer bondIssuer_,
        IPricingStrategy pricingStrategy_,
        IFeeStrategy feeStrategy_
    ) public initializer {
        require(address(bondIssuer_) != address(0), "Expected new bond minter to be valid");
        require(address(pricingStrategy_) != address(0), "Expected new pricing strategy to be valid");
        require(address(feeStrategy_) != address(0), "Expected new fee strategy to be valid");

        bondIssuer = bondIssuer_;
        pricingStrategy = pricingStrategy_;
        feeStrategy = feeStrategy_;

        bondQueue.init();
    }

    //--------------------------------------------------------------------------
    // ADMIN only methods

    // @notice Update the reference to the bond issuer contract.
    // @param bondIssuer_ New bond issuer address.
    function updateBondIssuer(IBondIssuer bondIssuer_) external onlyOwner {
        require(address(bondIssuer_) != address(0), "Expected new bond minter to be valid");
        bondIssuer = bondIssuer_;
        emit BondIssuerUpdated(bondIssuer_);
    }

    // @notice Update the reference to the fee strategy contract.
    // @param feeStrategy_ New strategy address.
    function updateFeeStrategy(IFeeStrategy feeStrategy_) external onlyOwner {
        require(address(feeStrategy_) != address(0), "Expected new fee strategy to be valid");
        feeStrategy = feeStrategy_;
        emit FeeStrategyUpdated(feeStrategy_);
    }

    // @notice Update the reference to the pricing strategy contract.
    // @param pricingStrategy_ New strategy address.
    function updatePricingStrategy(IPricingStrategy pricingStrategy_) external onlyOwner {
        require(address(pricingStrategy_) != address(0), "Expected new pricing strategy to be valid");
        require(pricingStrategy_.decimals() == PRICE_DECIMALS, "Expected new pricing stragey to use same decimals");
        pricingStrategy = pricingStrategy_;
        emit PricingStrategyUpdated(pricingStrategy_);
    }

    // @notice Update the maturity tolerance parameters.
    // @param minMaturiySec_ New minimum maturity time.
    // @param maxMaturiySec_ New maximum maturity time.
    function updateTolerableBondMaturiy(uint256 minMaturiySec_, uint256 maxMaturiySec_) external onlyOwner {
        minMaturiySec = minMaturiySec_;
        maxMaturiySec = maxMaturiySec_;
        emit TolerableBondMaturiyUpdated(minMaturiySec_, maxMaturiySec_);
    }

    // @notice Update the tranche yield parameter.
    // @param hash The bond class.
    // @param yields The yield for each tranche.
    function updateTrancheYields(bytes32 hash, uint256[] memory yields) external onlyOwner {
        _trancheYields[hash] = yields;
        emit TrancheYieldsUpdated(hash, yields);
    }

    //--------------------------------------------------------------------------
    // External methods

    /// @inheritdoc IPerpetualTranche
    function deposit(ITranche trancheIn, uint256 trancheInAmt) external override returns (MintData memory) {
        // assert(bondIssuer != address(0)); "System Error: bond minter not set."

        MintData memory m;

        IBondController mintingBond = _mintingBond();
        require(address(mintingBond) != address(0), "No active minting bond");

        TrancheData memory mintingBondTrancheData = mintingBond.getTrancheData();

        // NOTE: `getTrancheIndex` reverts if trancheIn is NOT part of the minting bond
        uint256 trancheIDX = mintingBondTrancheData.getTrancheIndex(trancheIn);
        uint256 trancheYield = getTrancheYield(mintingBondTrancheData.getClass(), trancheIDX);
        if (trancheYield == 0) {
            return m;
        }

        trancheIn.safeTransferFrom(_msgSender(), address(this), trancheInAmt);
        syncReserve(trancheIn);

        m.amount = _fromUnderlying(trancheInAmt, trancheYield, pricingStrategy.computeTranchePrice(trancheIn));
        m.fee = feeStrategy.computeMintFee(m.amount);

        _mint(_msgSender(), m.amount);
        _settleFee(feeToken(), _msgSender(), m.fee);

        return m;
    }

    /// @inheritdoc IPerpetualTranche
    function redeem(uint256 requestedAmount) external override returns (BurnData memory) {
        BurnData memory r;
        r.remainder = requestedAmount;

        IBondController burningBond = _burningBond();
        TrancheData memory burningBondTrancheData = burningBond.getTrancheData();

        while (address(burningBond) != address(0) && r.remainder > 0) {
            for (uint256 i = 0; i < burningBondTrancheData.trancheCount; i++) {
                ITranche t = burningBondTrancheData.tranches[i];
                uint256 trancheYield = getTrancheYield(burningBondTrancheData.getClass(), i);
                if (trancheYield == 0) {
                    continue;
                }

                uint256 trancheBalance = t.balanceOf(reserve());
                if (trancheBalance == 0) {
                    continue;
                }

                uint256 tranchePrice = pricingStrategy.computeTranchePrice(t);
                uint256 trancheAmtForRemainder = _toUnderlying(r.remainder, trancheYield, tranchePrice);

                // If tranche balance doesn't cover the tranche amount required
                // burn the entire tranche balance and continue to the next tranche.
                uint256 trancheAmtUsed = (trancheAmtForRemainder < trancheBalance)
                    ? trancheAmtForRemainder
                    : trancheBalance;
                t.safeTransferFrom(address(this), _msgSender(), trancheAmtUsed);
                syncReserve(t);

                r.tranches[r.burntTrancheCount] = t;
                r.trancheAmts[r.burntTrancheCount] = trancheAmtUsed;
                // NOTE: we assume that tranche to burnAmt back to tranche will be lossless
                r.remainder = (r.remainder * (trancheAmtForRemainder - trancheAmtUsed)) / trancheAmtForRemainder;
                r.burntTrancheCount++;
            }

            if (r.remainder == 0) {
                break;
            }

            // we've burned through all the bond tranches and now can move to the next one
            bondQueue.dequeue();
            burningBond = _burningBond();
            burningBondTrancheData = burningBond.getTrancheData();
        }

        r.amount = requestedAmount - r.remainder;
        r.fee = feeStrategy.computeBurnFee(r.amount);

        _settleFee(feeToken(), _msgSender(), r.fee);
        _burn(_msgSender(), r.amount);

        return r;
    }

    /// @inheritdoc IPerpetualTranche
    function rollover(
        ITranche trancheIn,
        ITranche trancheOut,
        uint256 trancheInAmt
    ) external override returns (RolloverData memory) {
        RolloverData memory r;

        IBondController bondIn = IBondController(trancheIn.bond());
        IBondController bondOut = IBondController(trancheOut.bond());

        require(bondIn == _mintingBond(), "Tranche in should be of minting bond");
        require(!bondQueue.contains(address(bondOut)), "Expected tranche out to NOT be of bond in the queue");

        TrancheData memory bondInTrancheData = bondIn.getTrancheData();
        TrancheData memory bondOutTrancheData = bondOut.getTrancheData();

        uint256 trancheInYield = getTrancheYield(
            bondInTrancheData.getClass(),
            bondInTrancheData.getTrancheIndex(trancheIn)
        );
        uint256 trancheOutYield = getTrancheYield(
            bondOutTrancheData.getClass(),
            bondOutTrancheData.getTrancheIndex(trancheOut)
        );

        r.amount = _fromUnderlying(trancheInAmt, trancheInYield, pricingStrategy.computeTranchePrice(trancheIn));
        r.trancheAmt = _toUnderlying(r.amount, trancheOutYield, pricingStrategy.computeTranchePrice(trancheOut));

        trancheIn.safeTransferFrom(_msgSender(), reserve(), trancheInAmt);
        syncReserve(trancheIn);

        trancheOut.safeTransfer(_msgSender(), r.trancheAmt);
        syncReserve(trancheOut);

        r.reward = feeStrategy.computeRolloverReward(r.amount);
        _settleReward(rewardToken(), _msgSender(), r.reward);

        return r;
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Used in case an altruistic party intends to increase the collaterlization ratio
    function burn(uint256 amount) external override returns (bool) {
        _burn(_msgSender(), amount);
        return true;
    }

    /// @inheritdoc IPerpetualTranche
    function advanceMintBond(IBondController newBond) external override returns (bool) {
        require(bondIssuer.isInstance(newBond), "Expect new bond to be minted by the minter");
        require(isActiveBond(newBond), "New bond not active");
        require(!bondQueue.contains(address(newBond)), "New bond already in queue");

        // NOTE: The new bond is pushed to the tail of the queue.
        bondQueue.enqueue(address(newBond));
        emit BondEnqueued(newBond);
        // assert(newBond == _mintingBond());

        return true;
    }

    /// @inheritdoc IPerpetualTranche
    // TODO: run this lazily
    function advanceBurnBond() external override returns (bool) {
        while (true) {
            IBondController oldestBond = _burningBond();
            if (address(oldestBond) == address(0) || isActiveBond(oldestBond)) {
                break;
            }

            // NOTE: The oldest bond is removed from the head of the queue.
            bondQueue.dequeue();
            emit BondDequeued(oldestBond);
            // assert(oldestBond != _burningBond());
        }

        return true;
    }

    // @notice Emits the reserve balance of the given token so that it can be picked up by off-chain indexers.
    // @dev Can be called externally to register tranches transferred into the reserve out of turn.
    // @param t The address of the token held by the reserve.
    function syncReserve(IERC20 t) public {
        // log events
        uint256 balance = t.balanceOf(reserve());
        if (balance > 0 && !reserveAssets[t]) {
            reserveAssets[t] = true;
        } else if (balance == 0) {
            delete reserveAssets[t];
        }
        emit ReserveSynced(t, balance);
    }

    //--------------------------------------------------------------------------
    // Public view methods

    /**
     * @dev Returns the number of decimals used to get its user representation.
     *      For example, if `decimals` equals `2`, a balance of `505` tokens should
     *      be displayed to a user as `5.05` (`505 / 10 ** 2`).
     */
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @inheritdoc IPerpetualTranche
    function reserve() public view override returns (address) {
        return address(this);
    }

    /// @inheritdoc IPerpetualTranche
    function feeToken() public view override returns (IERC20) {
        return feeStrategy.feeToken();
    }

    /// @inheritdoc IPerpetualTranche
    function rewardToken() public view override returns (IERC20) {
        return feeStrategy.rewardToken();
    }

    /// @inheritdoc IPerpetualTranche
    function getTrancheYield(bytes32 hash, uint256 index) public view override returns (uint256) {
        return _trancheYields[hash][index];
    }

    //--------------------------------------------------------------------------
    // Private/Internal helper methods

    // @dev If the fee is positive, fee is transferred to the reserve from payer
    //      else it's transferred to the payer from the reserve.
    function _settleFee(
        IERC20 feeToken_,
        address payer,
        int256 fee
    ) internal {
        uint256 fee_ = fee.abs();

        if (fee >= 0) {
            if (address(feeToken_) == address(this)) {
                // NOTE: {msg.sender} here should be address which triggered 
                //       the smart contract call.
                transfer(reserve(), fee_);
            } else {
                feeToken_.safeTransferFrom(payer, reserve(), fee_);
            }
        } else {
            feeToken_.safeTransfer(payer, fee_);
        }
        syncReserve(feeToken_);
    }

    // @dev If the reward is positive, reward is transferred from the reserve to the payer
    //      else it's transferred from the payer to the reserve.
    function _settleReward(
        IERC20 rewardToken_,
        address payer,
        int256 reward
    ) internal {
        // NOTE: reward is essentially negative fee
        _settleFee(rewardToken_, payer, -reward);
    }

    // @notice Checks if the bond's maturity is within acceptable bounds.
    // @dev Only "active" bonds can be added to the queue.
    //      If a bond becomes "inactive" it can get removed from the queue.
    // @param The address of the bond to check.
    // @return True if the bond is "active".
    function isActiveBond(IBondController bond) internal view returns (bool) {
        return (bond.maturityDate() >= block.timestamp + minMaturiySec &&
            bond.maturityDate() < block.timestamp + maxMaturiySec);
    }

    // @dev Address of the mintingBond
    //      Newest bond in the queue (ie the one with the furthest out maturity)
    //      will be at the tail of the queue.
    function _mintingBond() internal view returns (IBondController) {
        return IBondController(bondQueue.tail());
    }

    // @dev Address of the burningBond
    //      Oldest bond in the queue (ie the one with the most immediate maturity)
    //      will be at the head of the queue.
    function _burningBond() internal view returns (IBondController) {
        return IBondController(bondQueue.head());
    }

    // @dev Calculates perp token amount from tranche amount.
    //      perp = (tranche * yield) * price
    function _fromUnderlying(
        uint256 trancheAmt,
        uint256 yield,
        uint256 price
    ) private pure returns (uint256) {
        return (((trancheAmt * yield) / (10**YIELD_DECIMALS)) * price) / (10**PRICE_DECIMALS);
    }

    // @dev Calculates tranche token amount from perp amount.
    //      tranche = perp / (price * yield)
    function _toUnderlying(
        uint256 amount,
        uint256 yield,
        uint256 price
    ) private pure returns (uint256) {
        return (((amount * (10**PRICE_DECIMALS)) / price) * (10**YIELD_DECIMALS)) / yield;
    }
}
