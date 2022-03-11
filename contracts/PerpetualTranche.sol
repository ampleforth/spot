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
import { ITranche } from "./_interfaces/buttonwood/ITranche.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";

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

    // @dev Number of ERC-20 decimal places to get the perp token amount user representation.
    uint8 private immutable _decimals;

    //-------------------------------------------------------------------------
    // Data

    // @notice Issuer stores a pre-defined bond config and frequency and issues new bonds when poked
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

    // @notice A FIFO queue of bonds, each of which have an associated number of seniority-based tranches.
    // @dev The system only accepts tranches from bond at the tail of the queue to mint perpetual tokens.
    //      The system burns perpetual tokens for tranches from bonds at the head of the queue.
    AddressQueue public bondQueue;

    // @notice A record of all tokens currently being held by the reserve.
    // @dev Used by off-chain services for indexing tokens and their balances held by the reserve.
    mapping(IERC20 => bool) public reserveAssets;

    // @notice The minimum maturity time in seconds for a bond below which can get removed from the bond queue.
    uint256 public minMaturiySec;

    // @notice The maximum maturity time in seconds for a bond above which it can't get added into the bond queue.
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
        require(address(bondIssuer_) != address(0), "Expected new bond minter to be set");
        require(address(pricingStrategy_) != address(0), "Expected new pricing strategy to be set");
        require(address(feeStrategy_) != address(0), "Expected new fee strategy to be set");

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
        require(address(bondIssuer_) != address(0), "Expected new bond minter to be set");
        bondIssuer = bondIssuer_;
        emit BondIssuerUpdated(bondIssuer_);
    }

    // @notice Update the reference to the fee strategy contract.
    // @param feeStrategy_ New strategy address.
    function updateFeeStrategy(IFeeStrategy feeStrategy_) external onlyOwner {
        require(address(feeStrategy_) != address(0), "Expected new fee strategy to be set");
        feeStrategy = feeStrategy_;
        emit FeeStrategyUpdated(feeStrategy_);
    }

    // @notice Update the reference to the pricing strategy contract.
    // @param pricingStrategy_ New strategy address.
    function updatePricingStrategy(IPricingStrategy pricingStrategy_) external onlyOwner {
        require(address(pricingStrategy_) != address(0), "Expected new pricing strategy to be set");
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
    function deposit(ITranche trancheIn, uint256 trancheInAmt) external override returns (MintData memory m) {
        // assert(bondIssuer != address(0)); // bond minter not set

        m = depositPreview(trancheIn, trancheInAmt);

        trancheIn.safeTransferFrom(_msgSender(), address(this), trancheInAmt);
        syncReserve(trancheIn);

        // NOTE: user approves fee in advance, in case the fee is paid in the native token
        _mint(_msgSender(), m.amount);
        _settleFee(_msgSender(), m.fee);

        return m;
    }

    /// @inheritdoc IPerpetualTranche
    function depositPreview(ITranche trancheIn, uint256 trancheInAmt) public override returns (MintData memory m) {
        IBondController mintingBond = getMintingBond();
        require(address(mintingBond) != address(0), "Expected minting bond to be set");

        TrancheData memory mintingBondTrancheData = mintingBond.getTrancheData();

        // NOTE: `getTrancheIndex` reverts if trancheIn is NOT part of the minting bond
        uint256 yield = _trancheYields[mintingBondTrancheData.computeClassHash()][
            mintingBondTrancheData.getTrancheIndex(trancheIn)
        ];
        if (yield == 0) {
            return m;
        }

        m.amount = _tranchesToPerps(trancheInAmt, yield, pricingStrategy.computeTranchePrice(trancheIn));
        m.fee = feeStrategy.computeMintFee(m.amount);

        return m;
    }

    /// @inheritdoc IPerpetualTranche
    function redeem(uint256 requestedAmount) external override returns (BurnData memory b) {
        b = redeemPreview(requestedAmount);

        for (uint8 i = 0; i < b.trancheCount; i++) {
            b.tranches[i].safeTransfer(_msgSender(), b.trancheAmts[i]);
            syncReserve(b.tranches[i]);
        }

        // NOTE: user approves burn amount + fee in case the fee is paid in the native token
        _burn(_msgSender(), b.amount);
        _settleFee(_msgSender(), b.fee);

        return b;
    }

    /// @inheritdoc IPerpetualTranche
    function redeemPreview(uint256 requestedAmount) public override returns (BurnData memory b) {
        b.remainder = requestedAmount;

        IBondController burningBond = getBurningBond();
        TrancheData memory burningBondTrancheData = burningBond.getTrancheData();

        while (address(burningBond) != address(0) && b.remainder > 0) {
            for (uint8 i = 0; i < burningBondTrancheData.trancheCount; i++) {
                ITranche t = burningBondTrancheData.tranches[i];
                uint256 yield = _trancheYields[burningBondTrancheData.computeClassHash()][i];
                if (yield == 0) {
                    continue;
                }

                uint256 trancheBalance = t.balanceOf(reserve());
                if (trancheBalance == 0) {
                    continue;
                }

                uint256 trancheAmtForRemainder = _perpsToTranches(
                    b.remainder,
                    yield,
                    pricingStrategy.computeTranchePrice(t)
                );

                // If tranche balance doesn't cover the tranche amount required
                // burn the entire tranche balance and continue to the next tranche.
                uint256 trancheAmtUsed = (trancheAmtForRemainder < trancheBalance)
                    ? trancheAmtForRemainder
                    : trancheBalance;

                b.tranches[b.trancheCount] = t;
                b.trancheAmts[b.trancheCount] = trancheAmtUsed;
                // NOTE: we assume that tranche to burnAmt back to tranche will be lossless
                b.remainder = (b.remainder * (trancheAmtForRemainder - trancheAmtUsed)) / trancheAmtForRemainder;
                b.trancheCount++;
            }

            if (b.remainder == 0) {
                break;
            }

            // we've burned through all the bond tranches and now can move to the next one
            bondQueue.dequeue();
            burningBond = getBurningBond();
            burningBondTrancheData = burningBond.getTrancheData();
        }

        b.amount = requestedAmount - b.remainder;
        b.fee = feeStrategy.computeBurnFee(b.amount);
        // asset(requestedAmount == (b.amount + b.remainder));

        return b;
    }

    function redeemIcebox(ITranche trancheOut, uint256 trancheOutAmt) external override returns (BurnData memory b) {
        b = redeemIceboxPreview(requestedAmount);

        b.tranches[0].safeTransfer(_msgSender(), b.trancheAmts[0]);
        syncReserve(b.tranches[0]);

        _burn(_msgSender(), b.amount);
        _settleFee(_msgSender(), b.fee);

        return b;
    }

    function redeemIceboxPreview(ITranche trancheOut, uint256 trancheOutAmt) public override returns (BurnData memory b) {

        require(bondQueue.length() == 0, "Expected bond queue to be empty");

        IBondController bondOut = IBondController(trancheOut.bond());
        TrancheData memory bondOutTrancheData = bondOut.getTrancheData();
        uint256 yield = _trancheYields[bondOutTrancheData.computeClassHash()][
            bondOutTrancheData.getTrancheIndex(trancheOut)
        ];

        b.amount = _tranchesToPerps(trancheOut, yield, pricingStrategy.computeTranchePrice(trancheOut));
        b.fee = feeStrategy.computeMintFee(b.amount);
        b.tranches[0] = trancheOut;
        b.trancheAmts[0] = trancheOutAmt;
        b.remainder = 0;
        b.trancheCount=1;

        return b;
    }

    /// @inheritdoc IPerpetualTranche
    function rollover(
        ITranche trancheIn,
        ITranche trancheOut,
        uint256 trancheInAmt
    ) external override returns (RolloverData memory r) {
        r = rolloverPreview(trancheIn, trancheOut, trancheInAmt);

        trancheIn.safeTransferFrom(_msgSender(), reserve(), trancheInAmt);
        syncReserve(trancheIn);

        trancheOut.safeTransfer(_msgSender(), r.trancheAmt);
        syncReserve(trancheOut);

        _settleReward(_msgSender(), r.reward);

        return r;
    }

    /// @inheritdoc IPerpetualTranche
    function rolloverPreview(
        ITranche trancheIn,
        ITranche trancheOut,
        uint256 trancheInAmt
    ) public override returns (RolloverData memory r) {
        IBondController bondIn = IBondController(trancheIn.bond());
        IBondController bondOut = IBondController(trancheOut.bond());

        require(bondIn == getMintingBond(), "Expected trancheIn bond to be minting bond");
        require(!bondQueue.contains(address(bondOut)), "Expected trancheOut bond NOT to be in the queue");

        TrancheData memory bondInTrancheData = bondIn.getTrancheData();
        TrancheData memory bondOutTrancheData = bondOut.getTrancheData();

        uint256 trancheInYield = _trancheYields[bondInTrancheData.computeClassHash()][
            bondInTrancheData.getTrancheIndex(trancheIn)
        ];
        uint256 trancheOutYield = _trancheYields[bondOutTrancheData.computeClassHash()][
            bondOutTrancheData.getTrancheIndex(trancheOut)
        ];

        r.amount = _tranchesToPerps(trancheInAmt, trancheInYield, pricingStrategy.computeTranchePrice(trancheIn));
        r.trancheAmt = _perpsToTranches(r.amount, trancheOutYield, pricingStrategy.computeTranchePrice(trancheOut));
        r.reward = feeStrategy.computeRolloverReward(r.amount);
        return r;
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Used incase an altruistic party intends to increase the collaterlization ratio.
    function burn(uint256 amount) external override returns (bool) {
        _burn(_msgSender(), amount);
        return true;
    }

    //--------------------------------------------------------------------------
    // Public methods

    /// @inheritdoc IPerpetualTranche
    // @dev Newest bond in the queue (ie the one with the furthest out maturity)
    //      will be at the tail of the queue.
    //      Lazily pushes a new acceptable bond into the queue so that the tail is up to date.
    function getMintingBond() public override returns (IBondController mintingBond) {
        mintingBond = IBondController(bondQueue.tail());
        IBondController newBond = bondIssuer.getLastBond();
        if (mintingBond == newBond) {
            return mintingBond;
        }

        require(bondIssuer.isInstance(mintingBond), "Expected new bond be issued by issuer");
        require(!bondQueue.contains(address(mintingBond)), "Expected new bond to be in the queue");
        require(_isAcceptableBond(mintingBond), "Expected new bond to be acceptable");

        // NOTE: The new bond is pushed to the tail of the queue.
        bondQueue.enqueue(address(mintingBond));
        emit BondEnqueued(mintingBond);

        // assert(mintingBond == IBondController(bondQueue.tail()));
        return mintingBond;
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Oldest bond in the queue (ie the one with the most immediate maturity)
    //      will be at the head of the queue.
    //      Lazily dequeues bonds till the head of the queue has an acceptable bond.
    function getBurningBond() public override returns (IBondController burningBond) {
        burningBond = IBondController(bondQueue.head());

        while (address(burningBond) != address(0) && !_isAcceptableBond(burningBond)) {
            // NOTE: The oldest bond is removed from the head of the queue.
            bondQueue.dequeue();
            emit BondDequeued(burningBond);

            burningBond = IBondController(bondQueue.head());
        }

        // assert(burningBond == IBondController(bondQueue.head()));
        return burningBond;
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
    // External view methods

    /// @inheritdoc IPerpetualTranche
    function feeToken() external view override returns (IERC20) {
        return feeStrategy.feeToken();
    }

    /// @inheritdoc IPerpetualTranche
    function rewardToken() external view override returns (IERC20) {
        return feeStrategy.rewardToken();
    }

    /// @inheritdoc IPerpetualTranche
    function trancheYield(bytes32 hash, uint256 index) external view override returns (uint256) {
        return _trancheYields[hash][index];
    }

    /// @inheritdoc IPerpetualTranche
    function tranchePrice(ITranche t) external view override returns (uint256) {
        return pricingStrategy.computeTranchePrice(t);
    }

    /// @inheritdoc IPerpetualTranche
    function tranchesToPerps(ITranche t, uint256 trancheAmt) external view override returns (uint256) {
        IBondController b = IBondController(t.bond());
        TrancheData memory td = b.getTrancheData();
        return
            _tranchesToPerps(
                trancheAmt,
                _trancheYields[td.computeClassHash()][td.getTrancheIndex(t)],
                pricingStrategy.computeTranchePrice(t)
            );
    }

    /// @inheritdoc IPerpetualTranche
    function perpsToTranches(ITranche t, uint256 amount) external view override returns (uint256) {
        IBondController b = IBondController(t.bond());
        TrancheData memory td = b.getTrancheData();
        return
            _perpsToTranches(
                amount,
                _trancheYields[td.computeClassHash()][td.getTrancheIndex(t)],
                pricingStrategy.computeTranchePrice(t)
            );
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

    //--------------------------------------------------------------------------
    // Private/Internal helper methods

    // @dev If the fee is positive, fee is transferred to the reserve from payer
    //      else it's transferred to the payer from the reserve.
    function _settleFee(address payer, int256 fee) internal {
        IERC20 feeToken_ = feeStrategy.feeToken();
        uint256 fee_ = fee.abs();

        if (fee >= 0) {
            feeToken_.safeTransferFrom(payer, reserve(), fee_);
        } else {
            feeToken_.safeTransfer(payer, fee_);
        }
        syncReserve(feeToken_);
    }

    // @dev If the reward is positive, reward is transferred from the reserve to the payer
    //      else it's transferred from the payer to the reserve.
    function _settleReward(address payer, int256 reward) internal {
        IERC20 rewardToken_ = feeStrategy.rewardToken();
        uint256 reward_ = reward.abs();

        if (reward >= 0) {
            rewardToken_.safeTransfer(payer, reward_);
        } else {
            rewardToken_.safeTransferFrom(payer, reserve(), reward_);
        }
        syncReserve(rewardToken_);
    }

    // @notice Checks if the bond's maturity is within acceptable bounds.
    // @dev Only "acceptable" bonds can be added to the queue.
    //      If a bond becomes "unacceptable" it can get removed from the queue.
    // @param The address of the bond to check.
    // @return True if the bond is "acceptable".
    function _isAcceptableBond(IBondController bond) internal view returns (bool) {
        return (bond.maturityDate() >= block.timestamp + minMaturiySec &&
            bond.maturityDate() < block.timestamp + maxMaturiySec);
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
        return (((amount * (10**PRICE_DECIMALS)) / price) * (10**YIELD_DECIMALS)) / yield;
    }
}
