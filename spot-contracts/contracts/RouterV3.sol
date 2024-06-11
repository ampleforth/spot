// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ITranche } from "./_interfaces/buttonwood/ITranche.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";
import { IBalancer } from "./_interfaces/IBalancer.sol";
import { IPerpetualTranche } from "./_interfaces/IPerpetualTranche.sol";
import { IRolloverVault } from "./_interfaces/IRolloverVault.sol";
import { TokenAmount } from "./_interfaces/CommonTypes.sol";

import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { BondTranches, BondTranchesHelpers } from "./_utils/BondTranchesHelpers.sol";
import { BondHelpers } from "./_utils/BondHelpers.sol";

/**
 *  @title RouterV3
 *
 *  @notice Contract to dry-run and batch multiple operations.
 *
 */
contract RouterV3 {
    // Math
    using MathUpgradeable for uint256;
    using SafeCastUpgradeable for uint256;

    // data handling
    using BondHelpers for IBondController;
    using BondTranchesHelpers for BondTranches;

    // ERC20 operations
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using SafeERC20Upgradeable for ITranche;
    using SafeERC20Upgradeable for IPerpetualTranche;
    using SafeERC20Upgradeable for IRolloverVault;

    /// @notice Calculates the amount of tranche tokens minted after depositing into the deposit bond.
    /// @dev Used by off-chain services to preview a tranche operation.
    /// @param perp Address of the perp contract.
    /// @param collateralAmount The amount of collateral the user wants to tranche.
    /// @return bond The address of the current deposit bond.
    /// @return trancheAmts The tranche tokens and amounts minted.
    function previewTranche(
        IPerpetualTranche perp,
        uint256 collateralAmount
    ) external returns (IBondController, TokenAmount[] memory) {
        IBondController bond = perp.updateDepositBond();
        return (bond, bond.previewDeposit(collateralAmount));
    }

    /// @notice Tranches the underlying using the perp's deposit bond and
    ///         then deposits seniors to mint perp tokens.
    ///         It transfers the perp tokens back to the transaction sender along with
    ///         the unused junior tranches.
    /// @param balancer Address of the balancer contract.
    /// @param bond Address of the deposit bond.
    /// @param underlyingAmt The amount of underlying tokens the user wants to tranche.
    /// @return perpAmtMint The amount of perp tokens minted.
    /// @return juniorAmt The address of the junior tranche and the amount minted.
    function trancheAndMintPerps(
        IBalancer balancer,
        IBondController bond,
        uint256 underlyingAmt
    ) external returns (uint256, TokenAmount memory) {
        IERC20Upgradeable underlying = balancer.underlying();
        IPerpetualTranche perp = balancer.perp();

        // If deposit bond does not exist, we first issue it.
        if (address(bond).code.length <= 0) {
            perp.updateDepositBond();
        }

        // transfer underlying to router
        underlying.safeTransferFrom(msg.sender, address(this), underlyingAmt);

        // tranche underlying
        _checkAndApproveMax(underlying, address(bond), underlyingAmt);
        bond.deposit(underlyingAmt);

        // uses senior tranches to mint perps
        BondTranches memory bt = bond.getTranches();
        uint256 seniorAmt = bt.tranches[0].balanceOf(address(this));
        _checkAndApproveMax(bt.tranches[0], address(balancer), seniorAmt);
        balancer.mintPerps(bt.tranches[0], seniorAmt);

        // transfers perp tokens and remaining junior tranches back
        return (
            _transferAll(perp, msg.sender),
            TokenAmount({ token: bt.tranches[1], amount: _transferAll(bt.tranches[1], msg.sender) })
        );
    }

    //-------------------------------------------------------------------------
    // Private methods

    /// @dev Checks if the spender has sufficient allowance. If not, approves the maximum possible amount.
    function _checkAndApproveMax(IERC20Upgradeable token, address spender, uint256 amount) private {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance < amount) {
            token.safeApprove(spender, type(uint256).max);
        }
    }

    /// @dev Transfers the entire balance of a given token to the provided recipient.
    function _transferAll(IERC20Upgradeable token, address to) private returns (uint256) {
        uint256 bal = token.balanceOf(address(this));
        if (bal > 0) {
            token.safeTransfer(to, bal);
        }
        return bal;
    }
}
