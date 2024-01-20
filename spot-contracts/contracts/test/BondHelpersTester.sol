// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";

import { BondTranches, BondTranchesHelpers } from "../_utils/BondTranchesHelpers.sol";
import { BondHelpers } from "../_utils/BondHelpers.sol";

contract BondHelpersTester {
    using BondHelpers for IBondController;
    using BondTranchesHelpers for BondTranches;

    function secondsToMaturity(IBondController b) public view returns (uint256) {
        return b.secondsToMaturity();
    }

    function getTranches(IBondController b) public view returns (BondTranches memory bt) {
        return b.getTranches();
    }

    function previewDeposit(IBondController b, uint256 collateralAmount)
        public
        view
        returns (BondTranches memory, uint256[] memory)
    {
        return b.previewDeposit(collateralAmount);
    }

    function computeRedeemableTrancheAmounts(IBondController b, address u)
        public
        view
        returns (BondTranches memory, uint256[] memory)
    {
        BondTranches memory bt = b.getTranches();
        return (bt, bt.computeRedeemableTrancheAmounts(u));
    }

    function computeRedeemableTrancheAmounts(IBondController b, uint256[] memory trancheBalsAvailable)
        public
        view
        returns (BondTranches memory, uint256[] memory)
    {
        BondTranches memory bt = b.getTranches();
        return (bt, bt.computeRedeemableTrancheAmounts(trancheBalsAvailable));
    }
}
