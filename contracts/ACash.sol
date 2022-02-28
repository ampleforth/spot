//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Initializable } from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AddressQueue } from "./utils/AddressQueue.sol";
import { BondInfo, BondInfoHelpers, BondHelpers } from "./utils/BondHelpers.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ITranche } from "./interfaces/button-wood/ITranche.sol";
import { IBondController } from "./interfaces/button-wood/IBondController.sol";
import { IBondIssuer } from "./interfaces/IBondIssuer.sol";
import { IFeeStrategy } from "./interfaces/IFeeStrategy.sol";
import { IPricingStrategy } from "./interfaces/IPricingStrategy.sol";

// TODO:
// 1) log events
contract PerpetualTranche is ERC20, Initializable, Ownable {
    using AddressQueue for AddressQueue.Queue;
    using SafeERC20 for IERC20;
    using SafeERC20 for ITranche;
    using BondHelpers for IBondController;
    using BondInfoHelpers for BondInfo;

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
    // yield is applied on the tranche amounts
    mapping(bytes32 => uint256[]) private _trancheYields;

    // bondQueue is a queue of Bonds, which have an associated number of seniority-based tranches.
    AddressQueue.Queue public bondQueue;

    // the minimum maturity time in seconds for a bond below which it gets removed from the bond queue
    uint256 public minMaturiySec;

    // the maximum maturity time in seconds for a bond above which it can't get added into the bond queue
    uint256 public maxMaturiySec;

    //---- ERC-20 parameters
    uint8 private immutable _decimals;

    // record of all tranches currently being held by the system
    // used by off-chain services for indexing
    mapping(ITranche => bool) public tranches;

    // constants
    uint8 public constant YIELD_DECIMALS = 6;
    uint8 public constant PRICE_DECIMALS = 18;

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

        BondInfo memory mintingBondInfo = mintingBond.getInfo();
        require(trancheAmts.length == mintingBondInfo.trancheCount, "Must specify amounts for every bond tranche");

        uint256 mintAmt = 0;
        for (uint256 i = 0; i < mintingBondInfo.trancheCount; i++) {
            uint256 trancheYield = _trancheYields[mintingBondInfo.configHash][i];
            if (trancheYield == 0) {
                continue;
            }

            ITranche t = mintingBondInfo.tranches[i];
            t.safeTransferFrom(_msgSender(), address(this), trancheAmts[i]);
            syncTranche(t);

            mintAmt +=
                (((trancheAmts[i] * trancheYield) / (10**YIELD_DECIMALS)) * pricingStrategy.computeTranchePrice(t)) /
                (10**PRICE_DECIMALS);
        }

        int256 fee = feeStrategy.computeMintFee(mintAmt);
        address feeToken = feeStrategy.feeToken();

        // fee in native token and positive, withold mint partly as fee
        if (feeToken == address(this) && fee >= 0) {
            mintAmt -= uint256(fee);
            _mint(address(this), uint256(fee));
        } else {
            _settleFee(feeToken, _msgSender(), fee);
        }

        _mint(_msgSender(), mintAmt);
        return (mintAmt, fee);
    }

    // in case an altruistic party wants to increase the collateralization ratio
    function burn(uint256 amount) external {
        _burn(_msgSender(), amount);
    }

    function rollover(
        ITranche trancheIn,
        ITranche trancheOut,
        uint256 trancheInAmt
    ) external returns (uint256) {
        IBondController bondIn = IBondController(trancheIn.bond());
        IBondController bondOut = IBondController(trancheOut.bond());

        require(address(bondIn) == bondQueue.tail(), "Tranche in should be of minting bond");
        require(
            address(bondOut) == bondQueue.head() || !bondQueue.contains(address(bondOut)),
            "Expected tranche out to be of bond from the head of the queue or icebox"
        );

        BondInfo memory bondInInfo = bondIn.getInfo();
        BondInfo memory bondOutInfo = bondOut.getInfo();

        uint256 trancheInYield = _trancheYields[bondInInfo.configHash][bondInInfo.getTrancheIndex(trancheIn)];
        uint256 trancheOutYield = _trancheYields[bondOutInfo.configHash][bondOutInfo.getTrancheIndex(trancheOut)];
        uint256 trancheOutAmt = (((trancheInAmt * trancheInYield) / trancheOutYield) *
            pricingStrategy.computeTranchePrice(trancheIn)) / pricingStrategy.computeTranchePrice(trancheOut);

        trancheIn.safeTransferFrom(_msgSender(), address(this), trancheInAmt);
        syncTranche(trancheIn);

        trancheOut.safeTransfer(_msgSender(), trancheOutAmt);
        syncTranche(trancheOut);

        // reward is -ve fee
        int256 reward = feeStrategy.computeRolloverReward(trancheIn, trancheOut, trancheInAmt, trancheOutAmt);
        _settleFee(feeStrategy.feeToken(), _msgSender(), -reward);

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
    // internally called when tranche balances held by this contract change
    // used by off-chain indexers to query tranches currently held by the system
    function syncTranche(ITranche t) public {
        // log events
        uint256 trancheBalance = t.balanceOf(address(this));
        if (trancheBalance > 0 && !tranches[t]) {
            tranches[t] = true;
        } else if (trancheBalance == 0) {
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
        require(pricingStrategy_.decimals() == PRICE_DECIMALS, "Expected new pricing stragey to use same decimals");
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

    // if the fee is +ve, fee is transfered to self from payer
    // if the fee is -ve, it's transfered to the payer from self
    function _settleFee(
        address feeToken,
        address payer,
        int256 fee
    ) internal {
        if (fee >= 0) {
            IERC20(feeToken).safeTransferFrom(payer, address(this), uint256(fee));
        } else {
            // Dev note: This is a very dangerous operation
            IERC20(feeToken).safeTransfer(payer, uint256(-fee));
        }
    }

    /*
        function redeem(uint256 spotAmt) public returns () {

        }
    */
}
