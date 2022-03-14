// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { TrancheData, BondHelpers, TrancheDataHelpers } from "./_utils/BondHelpers.sol";

import { MintData, BurnData, RolloverData, IPerpetualTranche } from "./_interfaces/IPerpetualTranche.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "./_interfaces/buttonwood/ITranche.sol";

/*
 *  @title RouterV1
 *
 *  @notice Contract to batch multiple operations.
 *
 */
contract RouterV1 {
    using SafeERC20 for IERC20;
    using SafeERC20 for ITranche;
    using SafeERC20 for IPerpetualTranche;
    using BondHelpers for IBondController;
    using TrancheDataHelpers for TrancheData;

    // @notice Given collateral amount the function calculates the amount of perp tokens
    //  that can be minted and fees for the operation.
    // @dev Used by off-chain services to estimate a batch tranche, deposit operation.
    // @param b The address of the bond contract.
    // @return The amount minted and fee charged.
    function trancheAndDepositPreview(IPerpetualTranche perp, uint256 collateralAmount)
        external
        returns (MintData memory totalMintData)
    {
        IBondController bond = perp.getMintingBond();
        (TrancheData memory td, uint256[] memory trancheAmts, ) = bond.previewDeposit(collateralAmount);

        for (uint8 i = 0; i < td.trancheCount; i++) {
            ITranche t = td.tranches[i];
            MintData memory trancheMintData = perp.previewDeposit(t, trancheAmts[i]);
            totalMintData.amount += trancheMintData.amount;
            totalMintData.fee += trancheMintData.fee;
        }
        return totalMintData;
    }

    // @notice Given collateral and fees, the function tranches the collateral
    //         using the current minting bond and then deposits individual tranches
    //         to mint perp tokens. It transfers the perp tokens back to the
    //         transaction sender along with, any unused tranches and fees.
    // @param perp Address of the perpetual tranche contract.
    // @param collateralAmount The amount of collateral the user wants to tranche.
    // @param fee The fee paid to the perpetual tranche contract to mint perp.
    function trancheAndDeposit(
        IPerpetualTranche perp,
        uint256 collateralAmount,
        uint256 fee
    ) external {
        IBondController bond = perp.getMintingBond();
        TrancheData memory td = bond.getTrancheData();

        IERC20 collateralToken = IERC20(bond.collateralToken());
        IERC20 feeToken = perp.feeToken();

        // transfer collateral & fee to router
        collateralToken.safeTransferFrom(msg.sender, address(this), collateralAmount);
        if (fee > 0) {
            feeToken.safeTransferFrom(msg.sender, address(this), fee);
        }

        // NOTE: we use _checkAndApproveMax instead of _approveAll here as AMPL
        // does not support infinite approvals.
        _checkAndApproveMax(collateralToken, address(bond), collateralAmount);

        // tranche collateral
        bond.deposit(collateralAmount);

        // approve fee
        _approveAll(feeToken, address(perp));

        // use tranches to mint perp
        for (uint8 i = 0; i < td.trancheCount; i++) {
            ITranche t = td.tranches[i];
            uint256 mintedTranches = t.balanceOf(address(this));

            uint256 mintedSpot = perp.tranchesToPerps(t, mintedTranches);
            if (mintedSpot > 0) {
                // approve perp to use tranche tokens
                _approveAll(t, address(perp));

                // Mint perp tokens
                perp.deposit(t, mintedTranches);
            } else {
                // tranche unused for minting
                // transfer remaining tranches back to user
                t.safeTransfer(msg.sender, mintedTranches);
            }
        }

        // transfer remaining fee back if overpaid
        feeToken.safeTransfer(msg.sender, feeToken.balanceOf(address(this)));

        // transfer perp back
        perp.safeTransfer(msg.sender, perp.balanceOf(address(this)));
    }

    // @notice Given the perp amount, calculates the tranches that can be redeemed
    //         and fees for the operation.
    // @dev Used by off chain services to dry-run a redeem operation.
    // @param perp Address of the perpetual tranche contract.
    // @return The amount burnt, tranches redeemed and fee charged.
    function redeemTranchesPreview(IPerpetualTranche perp, uint256 amount) external returns (BurnData memory) {
        return perp.previewRedeem(amount);
    }

    // @notice Given perp tokens and fees, the function burns perp and redeems
    //         tranches. If the burn is incomplete, it transfers the remainder back.
    // @param perp Address of the perpetual tranche contract.
    // @param amount The amount of perp tokens the user wants to burn.
    // @param fee The fee paid to the perpetual tranche contract to burn perp tokens.
    function redeemTranches(
        IPerpetualTranche perp,
        uint256 amount,
        uint256 fee
    ) external {
        IERC20 feeToken = perp.feeToken();

        // transfer perp tokens & fee to router
        perp.safeTransferFrom(msg.sender, address(this), amount);
        if (fee > 0) {
            feeToken.safeTransferFrom(msg.sender, address(this), fee);
        }

        // approve perp tokens & fees
        _approveAll(perp, address(perp));
        _approveAll(feeToken, address(perp));

        // burn perp tokens
        BurnData memory b = perp.redeem(amount);
        for (uint256 i = 0; i < b.trancheCount; i++) {
            // transfer redeemed tranches back
            b.tranches[i].safeTransfer(msg.sender, b.trancheAmts[i]);
        }

        // transfer remaining fee back if overpaid
        feeToken.safeTransfer(msg.sender, feeToken.balanceOf(address(this)));

        // transfer remainder back
        perp.safeTransfer(msg.sender, b.remainder);
    }

    // @dev Approves the spender to spend an infinite tokens from the router's balance.
    function _approveAll(IERC20 token, address spender) private {
        _checkAndApproveMax(token, spender, type(uint256).max);
    }

    // @dev Checks if the spender has sufficient allowance if not approves the maximum possible amount.
    function _checkAndApproveMax(
        IERC20 token,
        address spender,
        uint256 amount
    ) private {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance < amount) {
            token.approve(spender, type(uint256).max);
        }
    }
}
