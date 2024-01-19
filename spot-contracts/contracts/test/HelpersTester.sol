// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";
import { IPerpetualTranche } from "../_interfaces/IPerpetualTranche.sol";

import { BondTranches, BondTranchesHelpers } from "../_utils/BondTranchesHelpers.sol";
import { BondHelpers } from "../_utils/BondHelpers.sol";
import { TrancheHelpers } from "../_utils/TrancheHelpers.sol";
import { PerpHelpers } from "../_utils/PerpHelpers.sol";

contract HelpersTester {
    using BondHelpers for IBondController;
    using BondTranchesHelpers for BondTranches;
    using TrancheHelpers for ITranche;

    function secondsToMaturity(IBondController b) public view returns (uint256) {
        return b.secondsToMaturity();
    }

    function getTranches(IBondController b) public view returns (BondTranches memory bt) {
        return b.getTranches();
    }

    function trancheAt(IBondController b, uint8 index) public view returns (ITranche t) {
        return b.trancheAt(index);
    }

    function getSeniorTranche(IBondController b) public view returns (ITranche t) {
        return b.getSeniorTranche();
    }

    function getSeniorTrancheRatio(IBondController b) public view returns (uint256) {
        return b.getSeniorTrancheRatio();
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

    function getTrancheCollateralizations(ITranche t) public view returns (uint256, uint256) {
        IBondController bond = IBondController(t.bond());
        return t.getTrancheCollateralization(IERC20Upgradeable(bond.collateralToken()));
    }

    function getImmatureSeniorTrancheCollateralization(ITranche t) public view returns (uint256, uint256) {
        IBondController bond = IBondController(t.bond());
        IERC20Upgradeable collateralToken = IERC20Upgradeable(bond.collateralToken());
        return t.getImmatureSeniorTrancheCollateralization(collateralToken.balanceOf(address(bond)));
    }

    function estimateUnderlyingAmtToTranche(
        IPerpetualTranche perp,
        uint256 perpTVL,
        uint256 perpAmtToMint
    ) public returns (uint256, uint256) {
        IBondController depositBond = perp.getDepositBond();
        IERC20Upgradeable collateralToken = IERC20Upgradeable(depositBond.collateralToken());
        ITranche tranche = depositBond.getSeniorTranche();
        uint256 seniorTR = depositBond.getSeniorTrancheRatio();
        return
            PerpHelpers.estimateUnderlyingAmtToTranche(
                perpTVL,
                perp.totalSupply(),
                collateralToken.balanceOf(address(depositBond)),
                depositBond.totalDebt(),
                tranche.totalSupply(),
                seniorTR,
                perpAmtToMint
            );
    }
}
