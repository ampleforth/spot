// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IPerpetualTranche, IBondController } from "../_interfaces/IPerpetualTranche.sol";

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { BondHelpers } from "./BondHelpers.sol";
import { BondTranches } from "./BondTranchesHelpers.sol";

library PerpHelpers {
    using MathUpgradeable for uint256;

    // Replicating value used in PerpetualTranche:
    uint8 public constant DISCOUNT_DECIMALS = 18;
    uint256 public constant UNIT_DISCOUNT = (10**DISCOUNT_DECIMALS);

    // Replicating value used in buttonwood's BondController:
    // https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 private constant TRANCHE_RATIO_GRANULARITY = 1000;

    /// @notice Computes the effective discounted adjusted tranche ratio
    ///         of classes accepted into the system, wrt the remainder of tranches
    ///         which exist outside the system.
    ///
    /// @dev Here we approxiamte assume there exists just one class of bonds in the perp system with the same tranche ratios and durations.
    ///      In practice this is true at almost all times, until when the BondIssuer's configuration
    ///      is changed and thus for a period of time tranches from mutiple bond classes exist in perp.
    ///      Eventually the tranches with the old configuration will get rolled out but
    ///      in the interm the "effective ratio" computed using the depositBond will deviate
    ///      from the true ratio which will a blended value.
    ///
    function computeEffectiveTrancheRatio(IPerpetualTranche perp, IBondController referenceBond)
        internal
        view
        returns (uint256, uint256)
    {
        //
        // The effective tranche ratio is the:
        // Discount adjusted ratio of tranche classess accepted by the perp system
        // to tranche classes which are not accepted.
        //
        // Put simply, if the deposit bond has a ratio of 25/75, and perps accept only As
        // the effective tranche ratio is 25 / 75.
        //
        // Alternatively for 100 A tranches in the perp system, there exist 300 Z tranches
        // outside the system.
        //
        // However in practice, perp might accept multiple tranche classes each with
        // its associated discount factor.
        //
        // For example, for a 20A, 30B, 50Z bond and if perp accepts
        //   - As at a discount of 1,
        //   - Bs as a discount of 0.5, and
        //   - Zs at a discount of 0. (ie, not accepted by perp)
        //
        // In which case we compute the effective tranche ratio as follows:
        // perpTR => (1 * 20 + 0.5 * 30 + 0 * 50) => 35
        // remainderTR => 100 - 35 => 65
        // effectiveTrancheRatio => 35 / 65
        //
        BondTranches memory bt = BondHelpers.getTranches(referenceBond);

        uint256 perpTR = 0;
        for (uint8 i = 0; i < bt.tranches.length; i++) {
            perpTR += bt.trancheRatios[i].mulDiv(perp.computeDiscount(bt.tranches[i]), UNIT_DISCOUNT);
        }

        uint256 remainderTR = TRANCHE_RATIO_GRANULARITY - perpTR;
        return (perpTR, remainderTR);
    }
}
