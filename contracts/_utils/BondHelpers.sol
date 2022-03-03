// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";

struct TrancheData {
    address collateralToken;
    ITranche[] tranches;
    uint256[] trancheRatios;
    uint256 trancheCount;
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

    // @notice Given a bond, retrives all of the bond's tranche related data.
    // @param b The address of the bond contract.
    // @return The tranche data.
    function getTrancheData(IBondController b) internal view returns (TrancheData memory td) {
        td.collateralToken = b.collateralToken();
        td.trancheCount = b.trancheCount();
        // Max tranches per bond < 2**8 - 1
        for (uint8 i = 0; i < td.trancheCount; i++) {
            (ITranche t, uint256 ratio) = b.tranches(i);
            td.tranches[i] = t;
            td.trancheRatios[i] = ratio;
        }
        return td;
    }

    // @notice Given a bond, retrives the total collateral held by the bond at a given point in time.
    // @param b The address of the bond contract.
    // @return The number of collateral tokens.
    function collateralBalance(IBondController b) internal view returns (uint256) {
        return IERC20(b.collateralToken()).balanceOf(address(b));
    }

    // @notice Helper function to estimate the amount of tranches minted when a given amount of collateral
    //         is deposited into the bond.
    // @dev This function is used offchain services (using callStatic) to preview tranches minted after
    // @param b The address of the bond contract.
    // @return The tranche data and an array of tranche amounts.
    function tranchePreview(IBondController b, uint256 collateralAmount)
        internal
        view
        returns (
            TrancheData memory td,
            uint256[] memory trancheAmts,
            uint256 fee
        )
    {
        uint256 totalDebt = b.totalDebt();
        uint256 collateralBalance_ = collateralBalance(b);
        uint256 feeBps = b.feeBps();

        for (uint256 i = 0; i < td.trancheCount; i++) {
            uint256 trancheValue = (collateralAmount * td.trancheRatios[i]) / TRANCHE_RATIO_GRANULARITY;
            if (collateralBalance_ > 0) {
                trancheValue = (trancheValue * totalDebt) / collateralBalance_;
            }
            fee = (trancheValue * feeBps) / BPS;
            if (fee > 0) {
                trancheValue -= fee;
            }
            trancheAmts[i] = trancheValue;
        }

        return (td, trancheAmts, fee);
    }
}

/*
 *  @title TrancheDataHelpers
 *
 *  @notice Library with helper functions the bond's retrived tranche data.
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
        require(false, "TrancheDataHelpers: Expected tranche to be part of bond");
        return type(uint256).max;
    }

    // @notice Generates the hash which uniquely identifies bonds with the same class ie) {collateralToken, trancheRatio}.
    // @param td The tranche data object.
    // @return unique hash for each bond class.
    function computeClassHash(TrancheData memory t) internal pure returns (bytes32) {
        return keccak256(abi.encode(t.collateralToken, t.trancheRatios));
    }
}
