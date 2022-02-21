//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IBondController } from "./interfaces/button-wood/IBondController.sol";
import { ITranche } from "./interfaces/button-wood/ITranche.sol";
import { IPricingStrategy } from "./interfaces/IPricingStrategy.sol";
import { IBondIssuer } from "./interfaces/IBondIssuer.sol";

contract PricingStrategy is Ownable, IPricingStrategy {
    uint256 public constant PRICE_DECIMALS = 18;

    struct TrancheConfig {
        IBondController bond;
        uint256[] trancheRatios;
        uint256 seniorityIDX;
    }

    // tranche_price => price_fn(tranche) * tranche_amount
    function getTranchePrice(ITranche t, uint256 trancheAmt) external view override returns (uint256) {
        return (computeTranchePrice(t) * trancheAmt) / (10**PRICE_DECIMALS);
    }

    // Tranche pricing function goes here:
    function computeTranchePrice(ITranche t) private view returns (uint256) {
        // TrancheConfig c = getTrancheConfig(t);
        // based on => c.bond.collateralToken(), c.bond.cdr(), c.bond.maturityDate(), c.seniorityIDX
        return (10**PRICE_DECIMALS);
    }

    // NOTE: this is very gas intensive
    // rebuilding the tranche's pricing parameters though the parent bond
    // Alternatively the bond issuer can map the tranche to these parameters for efficient recovery
    function getTrancheConfig(ITranche t) private view returns (TrancheConfig memory) {
        TrancheConfig memory c;
        // TODO: this is still to be merged
        // https://github.com/buttonwood-protocol/tranche/pull/30
        c.bond = IBondController(t.bondController());
        uint256 trancheCount = c.bond.trancheCount();
        for (uint256 i = 0; i < trancheCount; i++) {
            (ITranche u, uint256 ratio) = c.bond.tranches(i);
            c.trancheRatios[i] = ratio;
            if (t == u) {
                c.seniorityIDX = i;
            }
        }
        return c;
    }
}
