//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import {IBondController} from "./interfaces/button-wood/IBondController.sol";
import {IYieldStrategy} from "./interfaces/IYieldStrategy.sol";
import {IBondMinter} from "./interfaces/IBondMinter.sol";

contract YieldStrategy is Ownable, IYieldStrategy {
	uint256 public constant PCT_DECIMALS = 6;
	uint256 public constant PRICE_DECIMALS = 18;

	// todo: add setters

	// tranche yield is specific to a bond minter (which mints a specific class of bonds)
	// a bond class is uniquely identified by {collateralToken, trancheRatios, duration}
	mapping(IBondMinter => uint256[]) private _trancheYields;

	function computeTrancheYield(IBondMinter minter, IBondController bond, uint256 seniorityIDX, uint256 trancheAmt) external view override returns (uint256) {
		return trancheAmt * computeTrancheYieldPerc(minter, bond, seniorityIDX) / (10 ** PCT_DECIMALS);
	}

	function computeTrancheYieldPerc(IBondMinter minter, IBondController bond, uint256 seniorityIDX) public view returns (uint256) {
		// assert(minter.isInstance(bond));
		return trancheYields(minter, bond, seniorityIDX) * computeTranchePrice(bond, seniorityIDX) / (10 ** PRICE_DECIMALS);
	}

	function trancheYields(IBondMinter minter, IBondController bond, uint256 seniorityIDX) public view returns (uint256) {
		return _trancheYields[minter][seniorityIDX];
	}

	// Tranche pricing function goes here:
	// based on => bond.collateralToken, bond.cdr, bond.maturityDate, tranche seniority
	function computeTranchePrice(IBondController bond, uint256 seniorityIDX) public override view returns (uint256) {
		return (10 ** PRICE_DECIMALS);
	}
}
