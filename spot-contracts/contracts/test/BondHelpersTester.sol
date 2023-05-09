// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { BondHelpers, BondTranches, BondTranchesHelpers } from "../_utils/BondHelpers.sol";
import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";

contract BondHelpersTester {
    using BondHelpers for IBondController;
    using BondTranchesHelpers for BondTranches;

    function timeToMaturity(IBondController b) public view returns (uint256) {
        return b.timeToMaturity();
    }

    function duration(IBondController b) public view returns (uint256) {
        return b.duration();
    }

    function getTranches(IBondController b) public view returns (BondTranches memory td) {
        return b.getTranches();
    }

    function previewDeposit(IBondController b, uint256 collateralAmount)
        public
        view
        returns (
            BondTranches memory,
            uint256[] memory,
            uint256[] memory
        )
    {
        return b.previewDeposit(collateralAmount);
    }

    function getTrancheCollateralizations(IBondController b)
        public
        view
        returns (
            BondTranches memory td,
            uint256[] memory,
            uint256[] memory
        )
    {
        return b.getTrancheCollateralizations();
    }

    function indexOf(IBondController b, ITranche t) public view returns (uint256) {
        BondTranches memory td = b.getTranches();
        return td.indexOf(t);
    }

    function computeRedeemableTrancheAmounts(IBondController b, address u)
        public
        view
        returns (BondTranches memory td, uint256[] memory)
    {
        return b.computeRedeemableTrancheAmounts(u);
    }
}
