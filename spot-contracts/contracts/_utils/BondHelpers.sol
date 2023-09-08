// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";

import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { BondTranches, BondTranchesHelpers } from "./BondTranchesHelpers.sol";

/**
 *  @title BondHelpers
 *
 *  @notice Library with helper functions for ButtonWood's Bond contract.
 *
 */
library BondHelpers {
    using SafeCastUpgradeable for uint256;
    using MathUpgradeable for uint256;

    // Replicating value used here:
    // https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 private constant TRANCHE_RATIO_GRANULARITY = 1000;
    uint256 private constant BPS = 10_000;

    /// @notice Given a bond, calculates the time remaining to maturity.
    /// @param b The address of the bond contract.
    /// @return The number of seconds before the bond reaches maturity.
    function secondsToMaturity(IBondController b) internal view returns (uint256) {
        uint256 maturityDate = b.maturityDate();
        return maturityDate > block.timestamp ? maturityDate - block.timestamp : 0;
    }

    /// @notice Given a bond, calculates the duration.
    /// @param b The address of the bond contract.
    /// @return The total number of seconds between creation and maturity.
    function duration(IBondController b) internal view returns (uint256) {
        return b.maturityDate() - b.creationDate();
    }

    /// @notice Given a bond, retrieves all of the bond's tranches.
    /// @param b The address of the bond contract.
    /// @return The tranche data.
    function getTranches(IBondController b) internal view returns (BondTranches memory) {
        BondTranches memory bt;
        uint8 trancheCount = b.trancheCount().toUint8();
        bt.tranches = new ITranche[](trancheCount);
        bt.trancheRatios = new uint256[](trancheCount);
        // Max tranches per bond < 2**8 - 1
        for (uint8 i = 0; i < trancheCount; i++) {
            (ITranche t, uint256 ratio) = b.tranches(i);
            bt.tranches[i] = t;
            bt.trancheRatios[i] = ratio;
        }
        return bt;
    }

    /// @notice Given a bond, returns the tranche at the specified index.
    /// @param b The address of the bond contract.
    /// @param i Index of the tranche.
    /// @return t The tranche address.
    function trancheAt(IBondController b, uint8 i) internal view returns (ITranche t) {
        (t, ) = b.tranches(i);
        return t;
    }

    /// @notice Helper function to estimate the amount of tranches minted when a given amount of collateral
    ///         is deposited into the bond.
    /// @dev This function is used off-chain services (using callStatic) to preview tranches minted after
    /// @param b The address of the bond contract.
    /// @return The tranche data, an array of tranche amounts and fees.
    function previewDeposit(IBondController b, uint256 collateralAmount)
        internal
        view
        returns (
            BondTranches memory,
            uint256[] memory,
            uint256[] memory
        )
    {
        BondTranches memory bt = getTranches(b);
        uint256[] memory trancheAmts = new uint256[](bt.tranches.length);
        uint256[] memory fees = new uint256[](bt.tranches.length);

        uint256 totalDebt = b.totalDebt();
        uint256 collateralBalance = IERC20Upgradeable(b.collateralToken()).balanceOf(address(b));
        uint256 feeBps = b.feeBps();

        for (uint8 i = 0; i < bt.tranches.length; i++) {
            trancheAmts[i] = collateralAmount.mulDiv(bt.trancheRatios[i], TRANCHE_RATIO_GRANULARITY);
            if (collateralBalance > 0) {
                trancheAmts[i] = trancheAmts[i].mulDiv(totalDebt, collateralBalance);
            }
        }

        if (feeBps > 0) {
            for (uint8 i = 0; i < bt.tranches.length; i++) {
                fees[i] = trancheAmts[i].mulDiv(feeBps, BPS);
                trancheAmts[i] -= fees[i];
            }
        }

        return (bt, trancheAmts, fees);
    }

    /// @notice Given a bond and its tranche data, for each tranche token,
    ///         retrieves the total collateral redeemable for the entire supply of the tranche token (aka debt issued).
    /// @dev The cdr can be computed for each tranche by dividing the
    ///      returned tranche's collateralBalance by the tranche's totalSupply.
    /// @param b The address of the bond contract.
    /// @param bt The bonds tranche data.
    /// @return The list of collateral balances and the total supplies for each tranche.
    function getTrancheCollateralizations(IBondController b, BondTranches memory bt)
        internal
        view
        returns (uint256[] memory, uint256[] memory)
    {
        if (!b.isMature()) {
            return getImmatureTrancheCollateralizations(b, bt);
        } else {
            return getMatureTrancheCollateralizations(b, bt);
        }
    }

    /// @notice Given a bond and its tranche data, for each tranche token,
    ///         retrieves the total collateral redeemable for the entire supply of the tranche token (aka debt issued).
    /// @dev This is a low-level method, which assumes the bond has not mature.
    ///      Before maturity, the collateral is held by the bond.
    /// @param b The address of the bond contract.
    /// @param bt The bonds tranche data.
    /// @return The list of collateral balances and the total supplies for each tranche.
    function getImmatureTrancheCollateralizations(IBondController b, BondTranches memory bt)
        internal
        view
        returns (uint256[] memory, uint256[] memory)
    {
        uint256[] memory collateralBalances = new uint256[](bt.tranches.length);
        uint256[] memory trancheSupplies = new uint256[](bt.tranches.length);

        // Before the bond is mature, all the collateral is held by the bond contract
        uint256 bondCollateralBalance = IERC20Upgradeable(b.collateralToken()).balanceOf(address(b));
        uint256 zTrancheIndex = bt.tranches.length - 1;
        for (uint8 i = 0; i < bt.tranches.length; i++) {
            trancheSupplies[i] = bt.tranches[i].totalSupply();

            // a to y tranches
            if (i != zTrancheIndex) {
                collateralBalances[i] = (trancheSupplies[i] <= bondCollateralBalance)
                    ? trancheSupplies[i]
                    : bondCollateralBalance;
                bondCollateralBalance -= collateralBalances[i];
            }
            // z tranche
            else {
                collateralBalances[i] = bondCollateralBalance;
            }
        }

        return (collateralBalances, trancheSupplies);
    }

    /// @notice Assuming that the given bond is mature: Given a bond and its tranche data, for each tranche token,
    ///         retrieves the total collateral redeemable for the entire supply of the tranche token (aka debt issued).
    /// @dev This is a low-level method, which assumes the bond is mature.
    ///      After maturity, the collateral is transferred into individual tranche token addresses.
    /// @param b The address of the bond contract.
    /// @param bt The bonds tranche data.
    /// @return The list of collateral balances and the total supplies for each tranche.
    function getMatureTrancheCollateralizations(IBondController b, BondTranches memory bt)
        internal
        view
        returns (uint256[] memory, uint256[] memory)
    {
        uint256[] memory collateralBalances = new uint256[](bt.tranches.length);
        uint256[] memory trancheSupplies = new uint256[](bt.tranches.length);

        for (uint8 i = 0; i < bt.tranches.length; i++) {
            trancheSupplies[i] = bt.tranches[i].totalSupply();
            collateralBalances[i] = IERC20Upgradeable(b.collateralToken()).balanceOf(address(bt.tranches[i]));
        }
        return (collateralBalances, trancheSupplies);
    }
}
