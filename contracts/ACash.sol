//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "hardhat/console.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "./interfaces/IBondController.sol";

import "./utils/AddressQueue.sol";

// TODO:
// 1) Factor fee params and math into external strategy pattern to enable more complex logic in future
// 2) Implement replaceable fee strategies
contract ACash is ERC20 {
    using AddressQueue for AddressQueue.Queue;

    // todo: add setter
    address public feeToken;

    // Used for fee and yield values
    uint256 public constant PCT_DECIMALS = 6;

    // Special note: If mint or burn fee is negative, the other must overcompensate in the positive direction.
    // Otherwise, user could extract from fee reserve by constant mint/burn transactions.
    int256 public mintFeePct;
    int256 public burnFeePct;
    int256 public rolloverRewardPct;

    address public bondFactory;
    // bondFactory -> ordered array of tranche yields for SPOT
    mapping (address => uint256[]) trancheYields;

    uint8 private immutable _decimals;

    // bondQueue is a queue of Bonds, which have an associated number of seniority-based tranches.
    AddressQueue.Queue public bondQueue;

    // bondIcebox is a holding area for tranches that are underwater.
    // These are skipped in the general burn/redeem case, but may be manually burned redeemed by address
    mapping(address => bool) bondIcebox;
    
    constructor(string memory name, string memory symbol, uint8 decimals_) ERC20(name, symbol) {
        _decimals = decimals_;
        bondQueue.init();
        console.log("Deploying ACash");
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(uint256[] calldata trancheAmts) external returns (uint256, int256) {
        require(bondFactory != address(0), "Error: No bond factory set.");
        
        address mintingBond = bondQueue.tail();
        require (mintingBond != address(0), "Error: No active minting bond");
        
        // Ignore the Z-tranche
        uint256 usableTrancheCount = IBondController(mintingBond).trancheCount() - 1;

        require(trancheAmts.length == usableTrancheCount, "Must specify amounts for every Bond Tranche.");

        uint256[] storage yields = trancheYields[bondFactory];
        // "System Error: trancheYields size doesn't match bond tranche count."
        assert(yields.length == usableTrancheCount);

        uint256 mintAmt = 0;
        for (uint256 i = 0; i < usableTrancheCount; i++) {
            mintAmt += yields[i] * trancheAmts[i] / (10 ** PCT_DECIMALS);
            (ITranche t, ) = IBondController(mintingBond).tranches(i);
            IERC20(t).transferFrom(msg.sender, address(this), trancheAmts[i]); // assert or use safe transfer
        }

        // transfer in fee
        int256 fee = mintFeePct * int256(mintAmt) / int256(10 ** PCT_DECIMALS);
        if (fee >= 0) {
            IERC20(feeToken).transferFrom(msg.sender, address(this), uint256(fee));// todo: safe versions
        } else {
            // This is very scary!
            IERC20(feeToken).transfer(msg.sender, uint256(-fee));
        }
        
        // mint spot for user
        _mint(msg.sender, mintAmt);

        return (mintAmt, fee);
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

    function advanceBond(address bond) public onlyOwner {
        // enqueue empty bond
    }
    */
    
}
