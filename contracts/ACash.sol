//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AddressQueue } from "./utils/AddressQueue.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ITranche } from "./interfaces/button-wood/ITranche.sol";
import { IBondController } from "./interfaces/button-wood/IBondController.sol";
import { IBondIssuer } from "./interfaces/IBondIssuer.sol";
import { IFeeStrategy } from "./interfaces/IFeeStrategy.sol";
import { IPricingStrategy } from "./interfaces/IPricingStrategy.sol";

// TODO:
// 1) log events
contract ACash is ERC20, Initializable, Ownable {
    using AddressQueue for AddressQueue.Queue;
    using SafeERC20 for IERC20;
    using SafeERC20 for ITranche;

    // events
    event TrancheSynced(ITranche t, uint256 balance);

    // parameters

    // minter stores a preset bond config and frequency and mints new bonds when poked
    IBondIssuer public bondIssuer;

    // calculates fees
    IFeeStrategy public feeStrategy;

    // calculates bond price
    IPricingStrategy public pricingStrategy;

    // Yield applied on each tranche
    // tranche yields is specific to the parent bond's class identified by its config hash
    // a bond's class is the combination of the {collateralToken, trancheRatios}
    // specified as a fixed point number with YIELD_DECIMALS
    mapping(bytes32 => uint256[]) private _trancheYields;

    // bondQueue is a queue of Bonds, which have an associated number of seniority-based tranches.
    AddressQueue.Queue public bondQueue;

    // the minimum maturity time in seconds for a bond below which it gets removed from the bond queue
    uint256 public minMaturiySec;

    // the maximum maturity time in seconds for a bond above which it can't get added into the bond queue
    uint256 public maxMaturiySec;

    //---- ERC-20 parameters
    uint8 private immutable _decimals;

    // list of all tranches currently being held by the system
    // used by off-chain services for indexing
    mapping(ITranche => bool) public tranches;

    // constants
    uint256 public constant YIELD_DECIMALS = 6;

    constructor(
        string memory name,
        string memory symbol,
        uint8 decimals_
    ) ERC20(name, symbol) {
        _decimals = decimals_;
    }

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

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(uint256[] calldata trancheAmts) external returns (uint256, int256) {
        // "System Error: bond minter not set."
        // assert(bondIssuer != address(0));

        IBondController mintingBond = IBondController(bondQueue.tail());
        require(address(mintingBond) != address(0), "No active minting bond");
        bytes32 configHash = bondIssuer.configHash(mintingBond);

        uint256 trancheCount = mintingBond.trancheCount();
        require(trancheAmts.length == trancheCount, "Must specify amounts for every bond tranche");

        uint256 mintAmt = 0;
        for (uint256 i = 0; i < trancheCount; i++) {
            uint256 trancheYield = _trancheYields[configHash][i];
            if (trancheYield == 0) {
                continue;
            }

            (ITranche t, ) = mintingBond.tranches(i);
            t.safeTransferFrom(_msgSender(), address(this), trancheAmts[i]);
            syncTranche(t);

            // get bond price, ie amount of SPOT for trancheAmts[i] amount of t tranches
            mintAmt += (pricingStrategy.getBuyPrice(t, trancheAmts[i]) * trancheYield) / (10**YIELD_DECIMALS);
        }

        // fee in native token, withold mint partly as fee
        int256 fee = feeStrategy.computeMintFee(mintAmt);
        address feeToken = feeStrategy.feeToken();
        if (feeToken == address(this)) {
            mintAmt = (fee >= 0) ? mintAmt - uint256(fee) : mintAmt;
        }

        _mint(_msgSender(), mintAmt);
        _pullFee(feeToken, _msgSender(), fee);

        return (mintAmt, fee);
    }

    function rollover(
        ITranche trancheIn,
        ITranche trancheOut,
        uint256 trancheInAmt
    ) external returns (uint256) {
        require(bondQueue.has(trancheIn.bondController()), "New tranche should of bonds in bond queue");
        require(!bondQueue.has(trancheOut.bondController()), "Old tranche should NOT of bonds in bond queue");

        trancheIn.safeTransferFrom(_msgSender(), address(this), trancheInAmt);
        syncTranche(trancheIn);

        uint256 trancheOutAmt = pricingStrategy.getRolloverPrice(trancheIn, trancheOut, trancheInAmt);
        trancheOut.safeTransfer(_msgSender(), trancheOutAmt);
        syncTranche(trancheOut);

        // reward is -ve fee
        int256 reward = feeStrategy.computeRolloverReward(trancheIn, trancheOut, trancheInAmt, trancheOutAmt);
        _pullFee(feeStrategy.feeToken(), _msgSender(), -reward);

        return trancheOutAmt;
    }

    // push new bond into the queue
    function advanceMintBond(IBondController newBond) external {
        require(address(newBond) != bondQueue.head(), "New bond already in queue");
        require(bondIssuer.isInstance(newBond), "Expect new bond to be minted by the minter");
        require(isActiveBond(newBond), "New bond not active");

        bondQueue.enqueue(address(newBond));
    }

    // continue dequeue till the tail of the queue
    // has a bond which expires sufficiently out into the future
    function advanceBurnBond() external {
        while (true) {
            IBondController latestBond = IBondController(bondQueue.tail());

            if (address(latestBond) == address(0) || isActiveBond(latestBond)) {
                break;
            }

            // pop from queue
            bondQueue.dequeue();
        }
    }

    // can be externally called to register tranches transferred into the system out of turn
    // internally called when tranche balances held by aCASH change
    // used by off-chain indexers to query tranches currently held by the system
    function syncTranche(ITranche t) public {
        // log events
        uint256 trancheBalance = t.balanceOf(address(this));
        if (trancheBalance > 0) {
            tranches[t] = true;
        } else {
            delete tranches[t];
        }
        emit TrancheSynced(t, trancheBalance);
    }

    function setBondIssuer(IBondIssuer bondIssuer_) external onlyOwner {
        require(address(bondIssuer_) != address(0), "Expected new bond minter to be valid");
        bondIssuer = bondIssuer_;
    }

    function setPricingStrategy(IPricingStrategy pricingStrategy_) external onlyOwner {
        require(address(pricingStrategy_) != address(0), "Expected new pricing strategy to be valid");
        pricingStrategy = pricingStrategy_;
    }

    function setFeeStrategy(IFeeStrategy feeStrategy_) external onlyOwner {
        require(address(feeStrategy_) != address(0), "Expected new fee strategy to be valid");
        feeStrategy = feeStrategy_;
    }

    function setTolerableBondMaturiy(uint256 minMaturiySec_, uint256 maxMaturiySec_) external onlyOwner {
        minMaturiySec = minMaturiySec_;
        maxMaturiySec = maxMaturiySec_;
    }

    function setTrancheYields(bytes32 configHash, uint256[] memory yields) external onlyOwner {
        _trancheYields[configHash] = yields;
    }

    // bond's maturity is within bounds
    // only active bonds can be added to the queue. If a bond is inactive it gets kicked from the queue ..
    function isActiveBond(IBondController bond) public view returns (bool) {
        return (bond.maturityDate() >= block.timestamp + minMaturiySec &&
            bond.maturityDate() < block.timestamp + maxMaturiySec);
    }

    // if the fee is +ve, fee is minted or transfered to self from payer
    // if the fee is -ve, it's transfered to the payer
    function _pullFee(
        address feeToken,
        address payer,
        int256 fee
    ) internal {
        if (fee >= 0) {
            if (feeToken == address(this)) {
                _mint(feeToken, uint256(fee));
            } else {
                IERC20(feeToken).safeTransferFrom(payer, address(this), uint256(fee));
            }
        } else {
            // NOTE: we choose not to mint spot and alter the exchange rate in the case
            // the fee token is spot
            // This is very scary!
            IERC20(feeToken).safeTransfer(payer, uint256(-fee));
        }
    }

    /*
        function redeem(uint256 spotAmt) public returns () {

        }
    */
}
