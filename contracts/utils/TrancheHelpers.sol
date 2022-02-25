pragma solidity ^0.8.0;

import { IBondController } from "../interfaces/button-wood/IBondController.sol";
import { ITranche } from "../interfaces/button-wood/ITranche.sol";

struct TrancheInfo {
    IBondController bond;
    uint256[] trancheRatios;
    uint256 seniorityIDX;
}

library TrancheHelpers {
    // NOTE: this is very gas intensive
    // rebuilding the tranche's pricing parameters though the parent bond
    // Alternatively the bond issuer can map the tranche to these parameters for efficient recovery
    function getInfo(ITranche t) internal returns (TrancheInfo memory) {
        TrancheInfo memory c;
        // TODO: this is still to be merged
        // https://github.com/buttonwood-protocol/tranche/pull/30
        c.bond = IBondController(t.bondController());
        uint256 trancheCount = c.bond.trancheCount();
        for (uint8 i = 0; i < trancheCount; i++) {
            (ITranche u, uint256 ratio) = c.bond.tranches(i);
            c.trancheRatios[i] = ratio;
            if (t == u) {
                c.seniorityIDX = i;
            }
        }
        return c;
    }
}
