// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { IERC20Upgradeable, IBondController, ITranche } from "../_interfaces/IPerpetualTranche.sol";

import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { BondTranches, BondTranchesHelpers } from "./BondTranchesHelpers.sol";
import { TrancheHelpers } from "./TrancheHelpers.sol";
import { BondHelpers } from "./BondHelpers.sol";

/**
 *  @title TrancheManager
 *
 *  @notice Linked external library with helper functions for tranche management.
 *
 *  @dev Proxies which use external libraries are by default NOT upgrade safe.
 *       We guarantee that this linked external library will never trigger selfdestruct,
 *       and thus one is.
 *
 */
library TrancheManager {
    // data handling
    using BondHelpers for IBondController;
    using TrancheHelpers for ITranche;
    using BondTranchesHelpers for BondTranches;

    // ERC20 operations
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // math
    using MathUpgradeable for uint256;

    //--------------------------------------------------------------------------
    // Helper methods

    /// @notice Low level method which tranches underlying tokens into the provided bond contract.
    function execTranche(IBondController bond, IERC20Upgradeable underlying_, uint256 underlyingAmt) public {
        // amount is tranched
        checkAndApproveMax(underlying_, address(bond), underlyingAmt);
        bond.deposit(underlyingAmt);
    }

    /// @notice Low level method that redeems the given mature tranche for the underlying asset.
    ///         It interacts with the button-wood bond contract.
    function execMatureTrancheRedemption(IBondController bond, ITranche tranche, uint256 amount) public {
        if (!bond.isMature()) {
            bond.mature();
        }
        bond.redeemMature(address(tranche), amount);
    }

    /// @notice Low level method that redeems the given tranche for the underlying asset, before maturity.
    ///         If the contract holds sibling tranches with proportional balances, those will also get redeemed.
    ///         It interacts with the button-wood bond contract.
    function execImmatureTrancheRedemption(IBondController bond, BondTranches memory bt) public {
        uint256[] memory trancheAmts = bt.computeRedeemableTrancheAmounts(address(this));

        // NOTE: It is guaranteed that if one tranche amount is zero, all amounts are zeros.
        if (trancheAmts[0] > 0) {
            bond.redeem(trancheAmts);
        }
    }

    /// @notice Checks if the spender has sufficient allowance. If not, approves the maximum possible amount.
    function checkAndApproveMax(IERC20Upgradeable token, address spender, uint256 amount) public {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance < amount) {
            token.safeApprove(spender, type(uint256).max);
        }
    }

    /// @notice Computes the value of the given amount of tranche tokens, based on it's current CDR.
    ///         Value is denominated in the underlying collateral.
    function computeTrancheValue(
        address tranche,
        address collateralToken,
        uint256 trancheAmt
    ) public view returns (uint256) {
        (uint256 trancheClaim, uint256 trancheSupply) = ITranche(tranche).getTrancheCollateralization(
            IERC20Upgradeable(collateralToken)
        );
        return trancheClaim.mulDiv(trancheAmt, trancheSupply, MathUpgradeable.Rounding.Up);
    }
}
