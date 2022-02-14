//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AddressQueue} from "./utils/AddressQueue.sol";
import {BondMinterHelpers} from "./utils/BondMinterHelpers.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITranche} from "./interfaces/ITranche.sol";
import {IBondMinter} from "./interfaces/IBondMinter.sol";
import {IBondController} from "./interfaces/IBondController.sol";

// TODO:
// 1) Factor fee params and math into external strategy pattern to enable more complex logic in future
// 2) Implement replaceable fee strategies
// 3) log events
contract ACash is ERC20, Ownable {
    using AddressQueue for AddressQueue.Queue;
    using BondMinterHelpers for IBondMinter;
    using SafeERC20 for IERC20;

    // Used for fee and yield values
    uint256 public constant PCT_DECIMALS = 6;

    //--- fee strategy parameters
    // todo: add setter
    // todo: rethink AMPL fee token, it can rebase up and down, alternatively SPOT as fee?
    address public feeToken;
    // Special note: If mint or burn fee is negative, the other must overcompensate in the positive direction.
    // Otherwise, user could extract from fee reserve by constant mint/burn transactions.
    int256 public mintFeePct;
    int256 public burnFeePct;
    int256 public rolloverRewardPct;

    //---- bond minter parameters
    IBondMinter public bondMinter;
    uint256 public bondMinterConfigIDX;
    mapping (IBondMinter => uint256[]) trancheYields;


    //---- bond queue parameters
    // bondQueue is a queue of Bonds, which have an associated number of seniority-based tranches.
    AddressQueue.Queue public bondQueue;

    // system only keeps bonds which further than the `tolarableBondMaturiy` in the queue
    uint256 private _tolarableBondMaturiy;

    //---- ERC-20 parameters
    uint8 private immutable _decimals;


    // trancheIcebox is a holding area for tranches that are underwater or tranches which are about to mature.
    // They can only be rolled over and not burnt
    mapping(ITranche => bool) trancheIcebox;

    constructor(
        string memory name,
        string memory symbol,
        uint8 decimals_,
        IBondMinter bondMinter_,
        uint256 bondMinterConfigIDX_,
        uint256[] memory bondTrancheYields) ERC20(name, symbol) {
        _decimals = decimals_;
        setBondMinter(bondMinter_, bondMinterConfigIDX_, bondTrancheYields);

        bondQueue.init();
    }


    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(uint256[] calldata trancheAmts) external returns (uint256, int256) {
        // assert(bondMinter != address(0));

        IBondController mintingBond = IBondController(bondQueue.tail());
        require (address(mintingBond) != address(0), "No active minting bond");

        uint256 trancheCount = mintingBond.trancheCount();

        require(trancheAmts.length == trancheCount, "Must specify amounts for every bond tranche");

        uint256[] storage yields = trancheYields[bondMinter];
        // "System Error: trancheYields size doesn't match bond tranche count."
        assert(yields.length == trancheCount);

        uint256 mintAmt = 0;
        for (uint256 i = 0; i < trancheCount; i++) {
            mintAmt += yields[i] * trancheAmts[i] / (10 ** PCT_DECIMALS);
            (ITranche t, ) = mintingBond.tranches(i);
            IERC20(address(t)).safeTransferFrom(msg.sender, address(this), trancheAmts[i]); // assert or use safe transfer
        }

        // transfer in fee
        int256 fee = mintFeePct * int256(mintAmt) / int256(10 ** PCT_DECIMALS);
        if (fee >= 0) {
            IERC20(feeToken).safeTransferFrom(msg.sender, address(this), uint256(fee)); // todo: safe versions
        } else {
            // This is very scary!
            IERC20(feeToken).safeTransfer(msg.sender, uint256(-fee));
        }

        // mint spot for user
        _mint(msg.sender, mintAmt);

        return (mintAmt, fee);
    }


    // push new bond into the queue
    function advanceMintBond(IBondController newBond) public onlyOwner {
        // checks
        require(bondMinter.isConfigMatch(bondMinterConfigIDX, newBond), "Expect new bond config to match minter config");
        require(newBond.maturityDate() > tolarableBondMaturiyDate(), "New bond matures too soon");

        // enqueue empty bond, now minters can use this bond to mint!
        bondQueue.enqueue(address(newBond));
    }

    // todo: make this iterative to continue dequeue till the tail of the queue
    // has a bond which expires sufficiently out into the future
    function advanceBurnBond() public onlyOwner {
        IBondController latestBond = IBondController(bondQueue.tail());
        if(address(latestBond) != address(0) && latestBond.maturityDate() <= tolarableBondMaturiyDate()) {
            // pop from queue
            bondQueue.dequeue();

            // push individual tranches into icebox if they have a balance
            for(uint256 i = 0; i < latestBond.trancheCount(); i++){
                (ITranche t,) = latestBond.tranches(i);
                if(ITranche.balanceOf(address(this)) > 0){
                    trancheIcebox[t] = true;
                }
            }
        }
    }

    function setBondMinter(IBondMinter bondMinter_, uint256 bondMinterConfigIDX_, uint256[] memory bondTrancheYields) public onlyOwner {
        // TODO: consider using custom minter rather than button's
        // the current version does not have a instance check function
        require(address(bondMinter_) != address(0), "Expected bond minter to be set");

        require(bondMinter_.numConfigs() > bondMinterConfigIDX_, "Expected bond minter to be configured");

        bondMinter = bondMinter_;
        bondMinterConfigIDX = bondMinterConfigIDX_;

        require(bondTrancheYields.length == bondMinter_.trancheCount(bondMinterConfigIDX_), "Must specify yields for every bond tranche");
        trancheYields[bondMinter_] = bondTrancheYields;
    }

    function tolarableBondMaturiyDate() public view returns (uint256) {
        return block.timestamp + _tolarableBondMaturiy;
    }

    /*


    function calcMintFee(uint256[] calldata trancheAmts) view returns (uint256) {

    }


    function redeem(uint256 spotAmt) public returns () {

    }

    function redeemIcebox(address bond, uint256 trancheAmts) returns () {

    }

    function rollover() public returns () {

    }


    */
    
}
