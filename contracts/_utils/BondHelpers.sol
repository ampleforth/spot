// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IBondController } from "../_interfaces/button-wood/IBondController.sol";
import { ITranche } from "../_interfaces/button-wood/ITranche.sol";

struct BondInfo {
    address collateralToken;
    ITranche[] tranches;
    uint256[] trancheRatios;
    uint256 trancheCount;
    bytes32 configHash;
}

library BondHelpers {
    // NOTE: this is very gas intensive
    // Optimize calls?
    function getInfo(IBondController b) internal returns (BondInfo memory) {
        BondInfo memory bInfo;
        bInfo.collateralToken = b.collateralToken();
        bInfo.trancheCount = b.trancheCount();
        for (uint256 i = 0; i < bInfo.trancheCount; i++) {
            (ITranche t, uint256 ratio) = b.tranches(i);
            bInfo.tranches[i] = t;
            bInfo.trancheRatios[i] = ratio;
        }
        bInfo.configHash = keccak256(abi.encode(bInfo.collateralToken, bInfo.trancheRatios));
        return bInfo;
    }
}

library BondInfoHelpers {
    function getTrancheIndex(BondInfo memory bInfo, ITranche t) internal returns (uint256) {
        for (uint256 i = 0; i < bInfo.trancheCount; i++) {
            if (bInfo.tranches[i] == t) {
                return i;
            }
        }
        require(false, "BondInfoHelpers: Expected tranche to be part of bond");
    }
}
