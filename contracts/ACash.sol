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

    // minter stores a preset bond config and frequency and mints new bonds when poked
    IBondIssuer public bondIssuer;

    // calculates fees
    IFeeStrategy public feeStrategy;

    // calculates bond price
    IPricingStrategy public pricingStrategy;

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

        uint256 trancheCount = mintingBond.trancheCount();
        require(trancheAmts.length == trancheCount, "Must specify amounts for every bond tranche");

        uint256 mintAmt = 0;
        for (uint256 i = 0; i < trancheCount; i++) {
            // get bond price, ie amount of SPOT for trancheAmts[i] bonds
            mintAmt += pricingStrategy.getTranchePrice(bondIssuer, mintingBond, i, trancheAmts[i]);

            (ITranche t, ) = mintingBond.tranches(i);
            t.safeTransferFrom(_msgSender(), address(this), trancheAmts[i]);
        }

        int256 fee = feeStrategy.computeMintFee(mintAmt);
        mintAmt = (fee >= 0) ? mintAmt - uint256(fee) : mintAmt;
        _mint(_msgSender(), mintAmt);
        _transferFee(_msgSender(), fee);

        return (mintAmt, fee);
    }

    // push new bond into the queue
    function advanceMintBond(IBondController newBond) public {
        require(address(newBond) != bondQueue.head(), "New bond already in queue");
        require(bondIssuer.isInstance(address(newBond)), "Expect new bond to be minted by the minter");
        require(newBond.maturityDate() > tolarableBondMaturiyDate(), "New bond matures too soon");

        bondQueue.enqueue(address(newBond));
    }

    // continue dequeue till the tail of the queue
    // has a bond which expires sufficiently out into the future
    function advanceBurnBond() public {
        while (true) {
            IBondController latestBond = IBondController(bondQueue.tail());

            if (address(latestBond) == address(0) || latestBond.maturityDate() > tolarableBondMaturiyDate()) {
                break;
            }

            // pop from queue
            bondQueue.dequeue();

            // push individual tranches into icebox if they have a balance
            for (uint256 i = 0; i < latestBond.trancheCount(); i++) {
                (ITranche t, ) = latestBond.tranches(i);
                if (t.balanceOf(address(this)) > 0) {
                    trancheIcebox[t] = true;
                }
            }
        }
    }

    function _transferFee(address payer, int256 fee) internal {
        // todo: pick either implementation

        // using SPOT as the fee token
        if (fee >= 0) {
            _mint(address(this), uint256(fee));
        } else {
            // This is very scary!
            IERC20(address(this)).safeTransfer(payer, uint256(-fee));
        }

        // transfer in fee in non native fee token token
        // IERC20 feeToken = feeStrategy.feeToken();
        // if (fee >= 0) {
        //     feeToken.safeTransferFrom(payer, address(this), uint256(fee));
        // } else {
        //     // This is very scary!
        //     feeToken.safeTransfer(payer, uint256(-fee));
        // }
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

    function setTolarableBondMaturiy(uint256 tolarableBondMaturiy) external onlyOwner {
        _tolarableBondMaturiy = tolarableBondMaturiy;
    }

    function tolarableBondMaturiyDate() public view returns (uint256) {
        return block.timestamp + _tolarableBondMaturiy;
    }

    /*
        function redeem(uint256 spotAmt) public returns () {

        }

        function redeemIcebox(address bond, uint256 trancheAmts) returns () {

        }

        function rollover() public returns () {

        }
    */
}
