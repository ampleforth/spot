//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ITranche } from "./interfaces/button-wood/ITranche.sol";
import { IPricingStrategy } from "./interfaces/IPricingStrategy.sol";

contract PricingStrategy is Ownable, IPricingStrategy {
    uint8 private constant _decimals = 18;

    // Tranche pricing function goes here:
    // ie number of tranches of type t for 1 collateral token
    function computeTranchePrice(ITranche t) public view override returns (uint256) {
        // TrancheConfig c = getTrancheConfig(t);
        // based on => c.bond.collateralToken(), c.bond.cdr(), c.bond.maturityDate(), c.seniorityIDX
        return (10**_decimals);
    }

    function decimals() external view override returns (uint8) {
        return _decimals;
    }
}
