// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @notice Expected tranche to be part of bond.
/// @param tranche Address of the tranche token.
error UnacceptableTrancheIndex(ITranche tranche);

struct TrancheData {
    ITranche[] tranches;
    uint256[] trancheRatios;
    uint8 trancheCount;
}

/*
 *  @title BondHelpers
 *
 *  @notice Library with helper functions for ButtonWood's Bond contract.
 *
 */
library BondHelpers {
    // Replicating value used here:
    // https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 private constant TRANCHE_RATIO_GRANULARITY = 1000;
    uint256 private constant BPS = 10_000;

    // @notice Given a bond, calculates the time remaining to maturity.
    // @param b The address of the bond contract.
    // @return The number of seconds before the bond reaches maturity.
    function timeToMaturity(IBondController b) internal view returns (uint256) {
        uint256 maturityDate = b.maturityDate();
        return maturityDate > block.timestamp ? maturityDate - block.timestamp : 0;
    }

    // @notice Given a bond, calculates the bond duration i.e)
    //         difference between creation time and maturity time.
    // @param b The address of the bond contract.
    // @return The duration in seconds.
    function duration(IBondController b) internal view returns (uint256) {
        return b.maturityDate() - b.creationDate();
    }

    // @notice Given a bond, retrieves all of the bond's tranche related data.
    // @param b The address of the bond contract.
    // @return The tranche data.
    function getTrancheData(IBondController b) internal view returns (TrancheData memory td) {
        // Max tranches per bond < 2**8 - 1
        td.trancheCount = SafeCast.toUint8(b.trancheCount());
        td.tranches = new ITranche[](td.trancheCount);
        td.trancheRatios = new uint256[](td.trancheCount);
        for (uint8 i = 0; i < td.trancheCount; i++) {
            (ITranche t, uint256 ratio) = b.tranches(i);
            td.tranches[i] = t;
            td.trancheRatios[i] = ratio;
        }
        return td;
    }

    // TODO: move off-chain helpers to a different file?
    // @notice Helper function to estimate the amount of tranches minted when a given amount of collateral
    //         is deposited into the bond.
    // @dev This function is used off-chain services (using callStatic) to preview tranches minted after
    // @param b The address of the bond contract.
    // @return The tranche data, an array of tranche amounts and fees.
    function previewDeposit(IBondController b, uint256 collateralAmount)
        internal
        view
        returns (
            TrancheData memory td,
            uint256[] memory trancheAmts,
            uint256[] memory fees
        )
    {
        td = getTrancheData(b);

        uint256 totalDebt = b.totalDebt();
        uint256 collateralBalance = IERC20(b.collateralToken()).balanceOf(address(b));
        uint256 feeBps = b.feeBps();

        trancheAmts = new uint256[](td.trancheCount);
        fees = new uint256[](td.trancheCount);
        for (uint256 i = 0; i < td.trancheCount; i++) {
            uint256 trancheValue = (collateralAmount * td.trancheRatios[i]) / TRANCHE_RATIO_GRANULARITY;
            if (collateralBalance > 0) {
                trancheValue = (trancheValue * totalDebt) / collateralBalance;
            }
            fees[i] = (trancheValue * feeBps) / BPS;
            if (fees[i] > 0) {
                trancheValue -= fees[i];
            }
            trancheAmts[i] = trancheValue;
        }

        return (td, trancheAmts, fees);
    }

    // @notice Given a bond, retrieves the collateral currently redeemable for
    //         each tranche held by the given address.
    // @param b The address of the bond contract.
    // @param u The address to check balance for.
    // @return The tranche data and an array of collateral amounts.
    function getTrancheCollateralBalances(IBondController b, address u)
        internal
        view
        returns (TrancheData memory td, uint256[] memory balances)
    {
        td = getTrancheData(b);

        balances = new uint256[](td.trancheCount);

        if (b.isMature()) {
            for (uint8 i = 0; i < td.trancheCount; i++) {
                uint256 trancheCollaterBalance = IERC20(b.collateralToken()).balanceOf(address(td.tranches[i]));
                balances[i] = (td.tranches[i].balanceOf(u) * trancheCollaterBalance) / td.tranches[i].totalSupply();
            }
            return (td, balances);
        }

        uint256 bondCollateralBalance = IERC20(b.collateralToken()).balanceOf(address(b));
        for (uint8 i = 0; i < td.trancheCount - 1; i++) {
            uint256 trancheSupply = td.tranches[i].totalSupply();
            uint256 trancheCollaterBalance = trancheSupply <= bondCollateralBalance
                ? trancheSupply
                : bondCollateralBalance;
            balances[i] = (td.tranches[i].balanceOf(u) * trancheCollaterBalance) / trancheSupply;
            bondCollateralBalance -= trancheCollaterBalance;
        }
        balances[td.trancheCount - 1] = (bondCollateralBalance > 0) ? bondCollateralBalance : 0;
        return (td, balances);
    }
}

/*
 *  @title TrancheDataHelpers
 *
 *  @notice Library with helper functions the bond's retrieved tranche data.
 *
 */
library TrancheDataHelpers {
    // @notice Iterates through the tranche data to find the seniority index of the given tranche.
    // @param td The tranche data object.
    // @param t The address of the tranche to check.
    // @return the index of the tranche in the tranches array.
    function getTrancheIndex(TrancheData memory td, ITranche t) internal pure returns (uint256) {
        for (uint8 i = 0; i < td.trancheCount; i++) {
            if (td.tranches[i] == t) {
                return i;
            }
        }
        revert UnacceptableTrancheIndex(t);
    }
}
