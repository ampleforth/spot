pragma solidity ^0.8.0;

import {IBondMinter} from "../interfaces/IBondMinter.sol";
import {IBondController} from "../interfaces/IBondController.sol";

library BondMinterHelpers {
  // checks if bond as the same config as the minter config
  function isConfigMatch(IBondMinter minter, uint256 configIDX, IBondController bond) internal returns (bool) {

    IBondMinter.BondConfig memory config = minter.bondConfigAt(configIDX);

    // collateral token mismatch
    if(bond.collateralToken() != config.collateralToken){
      return false;
    }

    // tranche ratios mismatch
    uint256 trancheCount = bond.trancheCount();
    if(trancheCount != config.trancheRatios.length) {
      return false;
    }

    for(uint256 i = 0; i < trancheCount; i++) {
      (, uint256 ratio) = bond.tranches(i);
      if(ratio != config.trancheRatios[i]) {
        return false;
      }
    }

    return true;
  }

  function trancheCount(IBondMinter minter, uint256 configIDX) internal returns(uint256){
    IBondMinter.BondConfig memory config = minter.bondConfigAt(configIDX);
    return config.trancheRatios.length;
  }
}
