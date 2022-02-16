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

	// tranche yield is specific a bond class (which is indexed by its config hash)
	// a bond class is uniquely identified by {collateralToken, trancheRatios, duration}
	// the minter returns the config hash for each bond its creates
	mapping(bytes32 => uint256[]) private _trancheYields;

	function computeTrancheYield(IBondMinter minter, IBondController bond, uint256 seniorityIDX, uint256 trancheAmt) external view override returns (uint256) {
		return trancheAmt * computeTrancheYieldPerc(minter, bond, seniorityIDX) / (10 ** PCT_DECIMALS);
	}

	function computeTrancheYieldPerc(IBondMinter minter, IBondController bond, uint256 seniorityIDX) public view returns (uint256) {
		return trancheYields(minter, bond, seniorityIDX) * computeTranchePrice(bond, seniorityIDX) / (10 ** PRICE_DECIMALS);
	}

	function trancheYields(IBondMinter minter, IBondController bond, uint256 seniorityIDX) public view returns (uint256) {
		// if the bond was not minted by the minter, this will return 0x00..
		// and thus yeilds will be [0,0...] 
		return _trancheYields[minter.getConfigHash(address(bond))][seniorityIDX];
	}

	// Tranche pricing function goes here:
	// based on => bond.collateralToken, bond.cdr, bond.maturityDate, tranche seniority
	function computeTranchePrice(IBondController bond, uint256 seniorityIDX) public override view returns (uint256) {
		return (10 ** PRICE_DECIMALS);
	}
}
