// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { TrancheData, BondHelpers, TrancheDataHelpers } from "./_utils/BondHelpers.sol";

import { MintData, BurnData, RolloverData, IPerpetualTranche } from "./_interfaces/IPerpetualTranche.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "./_interfaces/buttonwood/ITranche.sol";

/*
 *  @title SpotRouterV1
 *
 *  @notice Router contract which batches multiple operations.
 *
 */
contract SpotRouterV1 {
    using SafeERC20 for IERC20;
    using SafeERC20 for ITranche;
    using SafeERC20 for IPerpetualTranche;
    using BondHelpers for IBondController;
    using TrancheDataHelpers for TrancheData;

    // @notice Given collateral amount the function calculates the amount of SPOT
    //  that can be minted and fees for the operation.
    // @dev Used by offchain services to estimate a batch tranche, deposit operation.
    // @param b The address of the bond contract.
    // @return The amount minted and fee charged.
    function trancheAndDepositPreview(IPerpetualTranche spot, uint256 collateralAmount)
        external
        returns (MintData memory totalMintData)
    {
        IBondController bond = spot.getMintingBond();
        (TrancheData memory td, uint256[] memory trancheAmts, ) = bond.tranchePreview(collateralAmount);

        for (uint8 i = 0; i < td.trancheCount; i++) {
            ITranche t = td.tranches[i];
            MintData memory trancheMintData = spot.depositPreview(t, trancheAmts[i]);
            totalMintData.amount += trancheMintData.amount;
            totalMintData.fee += trancheMintData.fee;
        }
        return totalMintData;
    }

    // @notice Given collateral and fees, the function tranches the collateral
    //         using the current minting bond and then deposits individual tranches
    //         to mint SPOT. It transfers the SPOT back to the
    //         transaction sender along with, any unused tranches and fees.
    // @param spot Address of the SPOT (perpetual tranche) contract.
    // @param collateralAmount The amount of collateral the user wants to tranche.
    // @param fee The fee paid to the pereptual tranche contract to mint spot.
    function trancheAndDeposit(
        IPerpetualTranche spot,
        uint256 collateralAmount,
        uint256 fee
    ) external {
        IBondController bond = spot.getMintingBond();
        TrancheData memory td = bond.getTrancheData();
        bytes32 bondHash = td.computeClassHash();

        IERC20 collateralToken = IERC20(bond.collateralToken());
        IERC20 feeToken = spot.feeToken();

        // transfer colltaeral & fee to router
        collateralToken.safeTransferFrom(msg.sender, address(this), collateralAmount);
        if (fee > 0) {
            feeToken.safeTransferFrom(msg.sender, address(this), fee);
        }

        // tranche collateral
        bond.deposit(collateralAmount);

        // approve fee
        if (fee > 0) {
            feeToken.approve(address(spot), fee);
        }

        // use tranches to mint spot
        for (uint8 i = 0; i < td.trancheCount; i++) {
            ITranche t = td.tranches[i];
            uint256 mintedTranches = t.balanceOf(address(this));

            // approve tranches to deposit into spot
            uint256 yield = spot.trancheYield(bondHash, td.getTrancheIndex(t));
            uint256 price = spot.tranchePrice(t);

            if (yield == 0 || price == 0) {
                // tranche unused for minting
                // transfer remaining tranches back to user
                t.safeTransfer(msg.sender, t.balanceOf(address(this)));
                continue;
            }

            // approve spot to use tranche tokens
            t.approve(address(spot), mintedTranches);

            // Mint spot
            spot.deposit(t, mintedTranches);
        }

        // transfer remaning fee back if overpaid
        feeToken.safeTransfer(msg.sender, feeToken.balanceOf(address(this)));

        // transfer spot back
        spot.safeTransfer(msg.sender, spot.balanceOf(address(this)));
    }

    // @notice Given the spot amount, calculates the tranches that can be redeemed
    //         and fees for the operation.
    // @dev Used by offchain services to dry-run a redeem operation.
    // @param spot Address of the SPOT (perpetual tranche) contract.
    // @return The amount burnt, tranches redeemed and fee charged.
    function redeemTranchesPreview(IPerpetualTranche spot, uint256 amount) external returns (BurnData memory) {
        return spot.redeemPreview(amount);
    }

    // @notice Given spot tokens and fees, the function burns spot and redeems
    //         tranches. If the burn is incomplete, it transfers the remainder back.
    // @param spot Address of the SPOT (perpetual tranche) contract.
    // @param amount The amount of SPOT tokens the user wants to burn.
    // @param fee The fee paid to the pereptual tranche contract to burn spot.
    function redeemTranches(
        IPerpetualTranche spot,
        uint256 amount,
        uint256 fee
    ) external {
        IERC20 feeToken = spot.feeToken();

        // transfer spot & fee to router
        spot.safeTransferFrom(msg.sender, address(this), amount);
        if (fee > 0) {
            feeToken.safeTransferFrom(msg.sender, address(this), fee);
        }

        // approve spot & fees
        spot.approve(address(spot), amount);
        if (fee > 0) {
            feeToken.approve(address(spot), fee);
        }

        // burn spot
        BurnData memory b = spot.redeem(amount);
        for (uint256 i = 0; i < b.trancheCount; i++) {
            // transfer redeemed tranches back
            b.tranches[i].safeTransfer(msg.sender, b.trancheAmts[i]);
        }

        // transfer remaning fee back if overpaid
        feeToken.safeTransfer(msg.sender, feeToken.balanceOf(address(this)));

        // transfer remainder back
        spot.safeTransfer(msg.sender, b.remainder);
    }
}
