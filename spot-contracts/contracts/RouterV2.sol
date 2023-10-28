// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ITranche } from "./_interfaces/buttonwood/ITranche.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";
import { IPerpetualTranche } from "./_interfaces/IPerpetualTranche.sol";

import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { BondTranches, BondTranchesHelpers } from "./_utils/BondTranchesHelpers.sol";
import { BondHelpers } from "./_utils/BondHelpers.sol";

/**
 *  @title RouterV2
 *
 *  @notice Contract to dry-run and batch multiple operations.
 *
 */
contract RouterV2 {
    // math
    using SafeCastUpgradeable for uint256;

    // data handling
    using BondHelpers for IBondController;
    using BondTranchesHelpers for BondTranches;

    // ERC20 operations
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using SafeERC20Upgradeable for ITranche;
    using SafeERC20Upgradeable for IPerpetualTranche;

    modifier afterPerpStateUpdate(IPerpetualTranche perp) {
        perp.updateState();
        _;
    }

    /// @notice Calculates the amount of tranche tokens minted after depositing into the deposit bond.
    /// @dev Used by off-chain services to preview a tranche operation.
    /// @param perp Address of the perp contract.
    /// @param collateralAmount The amount of collateral the user wants to tranche.
    /// @return bond The address of the current deposit bond.
    /// @return trancheAmts The tranche token amounts minted.
    function previewTranche(IPerpetualTranche perp, uint256 collateralAmount)
        external
        afterPerpStateUpdate(perp)
        returns (
            IBondController,
            ITranche[] memory,
            uint256[] memory
        )
    {
        IBondController bond = perp.getDepositBond();

        BondTranches memory bt;
        uint256[] memory trancheAmts;
        (bt, trancheAmts, ) = bond.previewDeposit(collateralAmount);

        return (bond, bt.tranches, trancheAmts);
    }

    /// @notice Tranches the collateral using the current deposit bond and then deposits individual tranches
    ///         to mint perp tokens. It transfers the perp tokens back to the
    ///         transaction sender along with any unused tranches and fees.
    /// @param perp Address of the perp contract.
    /// @param bond Address of the deposit bond.
    /// @param collateralAmount The amount of collateral the user wants to tranche.
    function trancheAndDeposit(
        IPerpetualTranche perp,
        IBondController bond,
        uint256 collateralAmount
    ) external afterPerpStateUpdate(perp) {
        BondTranches memory bt = bond.getTranches();
        IERC20Upgradeable collateralToken = IERC20Upgradeable(bond.collateralToken());

        // transfers collateral & fees to router
        collateralToken.safeTransferFrom(msg.sender, address(this), collateralAmount);

        // approves collateral to be tranched
        _checkAndApproveMax(collateralToken, address(bond), collateralAmount);

        // tranches collateral
        bond.deposit(collateralAmount);

        // uses senior tranches to mint perps
        uint256 trancheAmt = bt.tranches[0].balanceOf(address(this));
        _checkAndApproveMax(bt.tranches[0], address(perp), trancheAmt);
        perp.deposit(bt.tranches[0], trancheAmt);

        // transfers remaining tranches back
        for (uint8 i = 1; i < bt.tranches.length; i++) {
            bt.tranches[i].safeTransfer(msg.sender, bt.tranches[i].balanceOf(address(this)));
        }

        // transfers any remaining collateral tokens back
        uint256 collateralBalance = collateralToken.balanceOf(address(this));
        if (collateralBalance > 0) {
            collateralToken.safeTransfer(msg.sender, collateralBalance);
        }

        // transfers perp tokens back
        perp.safeTransfer(msg.sender, perp.balanceOf(address(this)));
    }

    struct RolloverBatch {
        ITranche trancheIn;
        IERC20Upgradeable tokenOut;
        uint256 trancheInAmt;
    }

    /// @notice Tranches collateral and performs a batch rollover.
    /// @param perp Address of the perp contract.
    /// @param bond Address of the deposit bond.
    /// @param collateralAmount The amount of collateral the user wants to tranche.
    /// @param rollovers List of batch rollover operations pre-computed off-chain.
    function trancheAndRollover(
        IPerpetualTranche perp,
        IBondController bond,
        uint256 collateralAmount,
        RolloverBatch[] calldata rollovers
    ) external afterPerpStateUpdate(perp) {
        BondTranches memory bt = bond.getTranches();
        IERC20Upgradeable collateralToken = IERC20Upgradeable(bond.collateralToken());

        // transfers collateral & fees to router
        collateralToken.safeTransferFrom(msg.sender, address(this), collateralAmount);

        // approves collateral to be tranched
        _checkAndApproveMax(collateralToken, address(bond), collateralAmount);

        // tranches collateral
        bond.deposit(collateralAmount);

        for (uint256 i = 0; i < rollovers.length; i++) {
            // approve trancheIn to be spent by perp
            _checkAndApproveMax(rollovers[i].trancheIn, address(perp), rollovers[i].trancheInAmt);

            // perform rollover
            perp.rollover(rollovers[i].trancheIn, rollovers[i].tokenOut, rollovers[i].trancheInAmt);
        }

        for (uint256 i = 0; i < rollovers.length; i++) {
            // transfer remaining tokenOut tokens back
            uint256 tokenOutBalance = rollovers[i].tokenOut.balanceOf(address(this));
            if (tokenOutBalance > 0) {
                rollovers[i].tokenOut.safeTransfer(msg.sender, tokenOutBalance);
            }
        }

        // transfers unused tranches back
        for (uint8 i = 0; i < bt.tranches.length; i++) {
            uint256 trancheBalance = bt.tranches[i].balanceOf(address(this));
            if (trancheBalance > 0) {
                bt.tranches[i].safeTransfer(msg.sender, trancheBalance);
            }
        }

        // transfers any remaining collateral tokens back
        uint256 collateralBalance = collateralToken.balanceOf(address(this));
        if (collateralBalance > 0) {
            collateralToken.safeTransfer(msg.sender, collateralBalance);
        }
    }

    /// @dev Checks if the spender has sufficient allowance. If not, approves the maximum possible amount.
    function _checkAndApproveMax(
        IERC20Upgradeable token,
        address spender,
        uint256 amount
    ) private {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance < amount) {
            token.safeApprove(spender, 0);
            token.safeApprove(spender, type(uint256).max);
        }
    }
}
