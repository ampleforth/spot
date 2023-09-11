// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";
import { IPerpetualTranche } from "../_interfaces/IPerpetualTranche.sol";

import { PerpHelpers } from "../_utils/PerpHelpers.sol";

contract PerpHelpersTester {
    function computeEffectiveTrancheRatio(IPerpetualTranche perp, IBondController referenceBond)
        public
        view
        returns (uint256, uint256)
    {
        return PerpHelpers.computeEffectiveTrancheRatio(perp, referenceBond);
    }
}
