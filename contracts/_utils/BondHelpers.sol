// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IBondController } from "../_interfaces/button-wood/IBondController.sol";
import { ITranche } from "../_interfaces/button-wood/ITranche.sol";

struct TrancheData {
    address collateralToken;
    ITranche[] tranches;
    uint256[] trancheRatios;
    uint256 trancheCount;
}

/*
 *  @title BondHelpers
 *
 *  @notice Library with helper functions for ButtonWood's Bond contract.
 *
 */
library BondHelpers {
    // @notice Given a bond, retrieves all of the bond's tranche related data.
    // @param b The address of the bond contract.
    // @return The tranche data.
    function getTrancheData(IBondController b) internal view returns (TrancheData memory) {
        TrancheData memory td;
        td.collateralToken = b.collateralToken();
        td.trancheCount = b.trancheCount();
        for (uint256 i = 0; i < td.trancheCount; i++) {
            (ITranche t, uint256 ratio) = b.tranches(i);
            td.tranches[i] = t;
            td.trancheRatios[i] = ratio;
        }
        return td;
    }
}

/*
 *  @title TrancheDataHelpers
 *
 *  @notice Library with helper functions for the bond's retrieved tranche data.
 *
 */
library TrancheDataHelpers {
    // @notice Iterates through the tranche data to find the seniority index of the given tranche.
    // @param td The tranche data object.
    // @param t The address of the tranche to check.
    // @return the index of the tranche in the tranches array.
    function getTrancheIndex(TrancheData memory td, ITranche t) internal pure returns (uint256) {
        for (uint256 i = 0; i < td.trancheCount; i++) {
            if (td.tranches[i] == t) {
                return i;
            }
        }
        require(false, "TrancheDataHelpers: Expected tranche to be part of bond");
    }

    // @notice Generates the hash which uniquely identifies a bond class, ie: {collateralToken, trancheRatio}.
    // @param td The tranche data object.
    // @return unique hash for the bond class of the input.
    function getClass(TrancheData memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(t.collateralToken, t.trancheRatios));
    }
}
