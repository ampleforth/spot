// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import { BondHelpers, TrancheData, TrancheDataHelpers } from "../_utils/BondHelpers.sol";
import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";

contract BondHelpersTester {
    using BondHelpers for IBondController;
    using TrancheDataHelpers for TrancheData;

    function timeToMaturity(IBondController b) public view returns (uint256) {
        return b.timeToMaturity();
    }

    function duration(IBondController b) public view returns (uint256) {
        return b.duration();
    }

    function getTrancheData(IBondController b) public view returns (TrancheData memory td) {
        return b.getTrancheData();
    }

    function previewDeposit(IBondController b, uint256 collateralAmount)
        public
        view
        returns (
            TrancheData memory td,
            uint256[] memory trancheAmts,
            uint256[] memory fees
        )
    {
        return b.previewDeposit(collateralAmount);
    }

    function getTrancheCollateralBalances(IBondController b, address u)
        public
        view
        returns (TrancheData memory td, uint256[] memory balances)
    {
        return b.getTrancheCollateralBalances(u);
    }

    function getTrancheIndex(IBondController b, ITranche t) public view returns (uint256) {
        TrancheData memory td = b.getTrancheData();
        return td.getTrancheIndex(t);
    }
}
