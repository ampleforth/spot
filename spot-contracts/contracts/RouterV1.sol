// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";

import { TrancheData, TrancheDataHelpers, BondHelpers } from "./_utils/BondHelpers.sol";

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ITranche } from "./_interfaces/buttonwood/ITranche.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";
import { IPerpetualTranche } from "./_interfaces/IPerpetualTranche.sol";

/*
 *  @title RouterV1
 *
 *  @notice Contract to dry-run and batch multiple operations.
 *
 */
contract RouterV1 {
    // math
    using MathUpgradeable for uint256;
    using SafeCastUpgradeable for uint256;
    using SignedMathUpgradeable for int256;

    // data handling
    using BondHelpers for IBondController;
    using TrancheDataHelpers for TrancheData;

    // ERC20 operations
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using SafeERC20Upgradeable for ITranche;
    using SafeERC20Upgradeable for IPerpetualTranche;

    modifier afterPerpStateUpdate(IPerpetualTranche perp) {
        perp.updateQueue();
        _;
    }

    // @notice Calculates the amount of tranche tokens minted after depositing into the deposit bond.
    // @dev Used by off-chain services to preview a tranche operation.
    // @param perp Address of the perpetual tranche contract.
    // @param collateralAmount The amount of collateral the user wants to tranche.
    // @return bond The address of the current deposit bond.
    // @return trancheAmts The tranche token amounts minted.
    function previewTranche(IPerpetualTranche perp, uint256 collateralAmount)
        external
        afterPerpStateUpdate(perp)
        returns (
            IBondController bond,
            ITranche[] memory tranches,
            uint256[] memory trancheAmts
        )
    {
        bond = perp.getDepositBond();

        TrancheData memory td;
        (td, trancheAmts, ) = bond.previewDeposit(collateralAmount);

        return (bond, td.tranches, trancheAmts);
    }

    // @notice Calculates the amount of perp tokens minted and fees for the operation.
    // @dev Used by off-chain services to preview a deposit operation.
    // @param perp Address of the perpetual tranche contract.
    // @param trancheIn The address of the tranche token to be deposited.
    // @param trancheInAmt The amount of tranche tokens deposited.
    // @return mintAmt The amount of perp tokens minted.
    // @return feeToken The address of the fee token.
    // @return mintFee The fee charged for minting.
    function previewDeposit(
        IPerpetualTranche perp,
        ITranche trancheIn,
        uint256 trancheInAmt
    )
        external
        afterPerpStateUpdate(perp)
        returns (
            uint256 mintAmt,
            IERC20Upgradeable feeToken,
            int256 mintFee
        )
    {
        mintAmt = perp.tranchesToPerps(trancheIn, trancheInAmt);
        feeToken = perp.feeToken();
        mintFee = perp.feeStrategy().computeMintFee(mintAmt);
        return (mintAmt, feeToken, mintFee);
    }

    // @notice Tranches the collateral using the current deposit bond and then deposits individual tranches
    //         to mint perp tokens. It transfers the perp tokens back to the
    //         transaction sender along with any unused tranches and fees.
    // @param perp Address of the perpetual tranche contract.
    // @param bond Address of the deposit bond.
    // @param collateralAmount The amount of collateral the user wants to tranche.
    // @param feePaid The fee paid to the perpetual tranche contract to mint perp.
    // @dev Fee to be paid should be pre-computed off-chain using the preview function.
    function trancheAndDeposit(
        IPerpetualTranche perp,
        IBondController bond,
        uint256 collateralAmount,
        uint256 feePaid
    ) external afterPerpStateUpdate(perp) {
        TrancheData memory td = bond.getTrancheData();
        IERC20Upgradeable collateralToken = IERC20Upgradeable(bond.collateralToken());
        IERC20Upgradeable feeToken = perp.feeToken();

        // transfers collateral & fees to router
        collateralToken.safeTransferFrom(msg.sender, address(this), collateralAmount);
        if (feePaid > 0) {
            feeToken.safeTransferFrom(msg.sender, address(this), feePaid);
        }

        // approves collateral to be tranched
        _checkAndApproveMax(collateralToken, address(bond), collateralAmount);

        // tranches collateral
        bond.deposit(collateralAmount);

        // approves fee to be spent to mint perp tokens
        _checkAndApproveMax(feeToken, address(perp), feePaid);

        for (uint8 i = 0; i < td.trancheCount; i++) {
            uint256 trancheAmt = td.tranches[i].balanceOf(address(this));
            if (perp.tranchesToPerps(td.tranches[i], trancheAmt) > 0) {
                // approves tranches to be spent
                _checkAndApproveMax(td.tranches[i], address(perp), trancheAmt);

                // mints perp tokens using tranches
                perp.deposit(td.tranches[i], trancheAmt);
            } else {
                // transfers unused tranches back
                td.tranches[i].safeTransfer(msg.sender, trancheAmt);
            }
        }

        // transfers any remaining collateral tokens back
        uint256 collateralBalance = collateralToken.balanceOf(address(this));
        if (collateralBalance > 0) {
            collateralToken.safeTransfer(msg.sender, collateralBalance);
        }

        // transfers remaining fee back if overpaid or reward
        uint256 feeBalance = feeToken.balanceOf(address(this));
        if (feeBalance > 0) {
            feeToken.safeTransfer(msg.sender, feeBalance);
        }

        // transfers perp tokens back
        perp.safeTransfer(msg.sender, perp.balanceOf(address(this)));
    }

    // @notice Calculates the tranche tokens that can be redeemed from the queue
    //         for burning up to the requested amount of perp tokens.
    // @dev Used by off-chain services to preview a redeem operation.
    // @dev Set maxTranches to max(uint256) to try to redeem the entire queue.
    // @param perp Address of the perpetual tranche contract.
    // @param perpAmountRequested The amount of perp tokens requested to be burnt.
    // @param maxTranches The maximum amount of tranches to be redeemed.
    // @return burnAmt The amount of perp tokens burnt.
    // @return feeToken The address of the fee token.
    // @return burnFee The fee charged for burning.
    // @return tranches The list of tranches redeemed.
    function previewRedeem(
        IPerpetualTranche perp,
        uint256 perpAmountRequested,
        uint256 maxTranches
    )
        external
        afterPerpStateUpdate(perp)
        returns (
            uint256 burnAmt,
            IERC20Upgradeable feeToken,
            int256 burnFee,
            ITranche[] memory tranches
        )
    {
        uint256 remainder = perpAmountRequested;
        maxTranches = MathUpgradeable.min(perp.getRedemptionQueueCount(), maxTranches);
        tranches = new ITranche[](maxTranches);
        for (uint256 i = 0; remainder > 0 && i < maxTranches; i++) {
            // NOTE: loops through queue from head to tail, i.e) in redemption order
            ITranche tranche = ITranche(perp.getRedemptionQueueAt(i));
            (, remainder) = perp.perpsToCoveredTranches(tranche, remainder, type(uint256).max);
            tranches[i] = tranche;
        }

        burnAmt = perpAmountRequested - remainder;
        feeToken = perp.feeToken();
        burnFee = perp.feeStrategy().computeBurnFee(burnAmt);

        return (burnAmt, feeToken, burnFee, tranches);
    }

    // @notice Redeems perp tokens for tranche tokens until the tranche balance covers it.
    // @param perp Address of the perpetual tranche contract.
    // @param perpAmountRequested The amount of perp tokens requested to be burnt.
    // @param feePaid The fee paid for burning.
    // @param requestedTranches The tranches in order to be redeemed.
    // @dev Fee and requestedTranches list are to be pre-computed off-chain using the preview function.
    function redeem(
        IPerpetualTranche perp,
        uint256 perpAmountRequested,
        uint256 feePaid,
        ITranche[] memory requestedTranches
    ) external afterPerpStateUpdate(perp) {
        IERC20Upgradeable feeToken = perp.feeToken();
        uint256 remainder = perpAmountRequested;

        // transfer collateral & fee to router
        perp.safeTransferFrom(msg.sender, address(this), remainder);
        if (feePaid > 0) {
            feeToken.safeTransferFrom(msg.sender, address(this), feePaid);
        }

        // Approve fees to be spent from router
        _checkAndApproveMax(feeToken, address(perp), feePaid);

        uint256 trancheCount;
        while (remainder > 0) {
            ITranche tranche = requestedTranches[trancheCount++];

            // When the tranche queue is non empty redeem expects
            //     - tranche == perp.getRedemptionTranche()
            // When the tranche queue is empty redeem can happen in any order
            (uint256 burnAmt, ) = perp.redeem(tranche, remainder);
            remainder -= burnAmt;

            // Transfer redeemed tranches back
            tranche.safeTransfer(msg.sender, tranche.balanceOf(address(this)));
        }

        // transfers remaining fee back if overpaid or reward
        uint256 feeBalance = feeToken.balanceOf(address(this));
        if (feeBalance > 0) {
            feeToken.safeTransfer(msg.sender, feeBalance);
        }

        // Transfer remainder perp tokens
        perp.safeTransfer(msg.sender, perp.balanceOf(address(this)));
    }

    struct RolloverPreview {
        // Rollover amounts are perp denominated. Useful for deriving fee amount for users.
        uint256 rolloverPerpAmt;
        uint256 requestedRolloverPerpAmt;
        uint256 trancheOutAmt;
        uint256 remainingTrancheInAmt;
    }

    // @notice Calculates the amount tranche tokens that can be rolled out, remainders and fees,
    //         with a given tranche token rolled in and amount.
    // @dev Used by off-chain services to preview a rollover operation.
    // @param perp Address of the perpetual tranche contract.
    // @param trancheIn The tranche token deposited.
    // @param trancheOut The tranche token requested to be withdrawn.
    // @param trancheInAmt The amount of trancheIn tokens available to deposit.
    // @param maxTrancheOutAmtUsed The tranche balance to be used for rollover.
    // @dev Set maxTrancheOutAmtUsed to max(uint256) to use the entire balance.
    // @return r The amounts rolled over and remaining.
    // @return feeToken The address of the fee token.
    // @return rolloverFee The fee paid by the caller.
    function previewRollover(
        IPerpetualTranche perp,
        ITranche trancheIn,
        ITranche trancheOut,
        uint256 trancheInAmt,
        uint256 maxTrancheOutAmtUsed
    )
        external
        afterPerpStateUpdate(perp)
        returns (
            RolloverPreview memory r,
            IERC20 feeToken,
            int256 rolloverFee
        )
    {
        feeToken = perp.feeToken();
        uint256 rolloverPerpAmtRemainder = 0;
        if (perp.isAcceptableRollover(trancheIn, trancheOut)) {
            r.requestedRolloverPerpAmt = perp.tranchesToPerps(trancheIn, trancheInAmt);
            (r.trancheOutAmt, rolloverPerpAmtRemainder) = perp.perpsToCoveredTranches(
                trancheOut,
                r.requestedRolloverPerpAmt,
                maxTrancheOutAmtUsed
            );
            r.rolloverPerpAmt = r.requestedRolloverPerpAmt - rolloverPerpAmtRemainder;
            r.remainingTrancheInAmt = perp.perpsToTranches(trancheIn, rolloverPerpAmtRemainder);
            rolloverFee = perp.feeStrategy().computeRolloverFee(r.rolloverPerpAmt);
        } else {
            r.remainingTrancheInAmt = trancheInAmt;
        }
        return (r, feeToken, rolloverFee);
    }

    struct RolloverBatch {
        ITranche trancheIn;
        ITranche trancheOut;
        uint256 trancheInAmt;
    }

    // @notice Tranches collateral and performs a batch rollover.
    // @param perp Address of the perpetual tranche contract.
    // @param bond Address of the deposit bond.
    // @param collateralAmount The amount of collateral the user wants to tranche.
    // @param rollovers List of batch rollover operations pre-computed off-chain.
    // @param feePaid The fee paid by the user performing rollover (fee could be negative).
    function trancheAndRollover(
        IPerpetualTranche perp,
        IBondController bond,
        uint256 collateralAmount,
        RolloverBatch[] memory rollovers,
        uint256 feePaid
    ) external afterPerpStateUpdate(perp) {
        TrancheData memory td = bond.getTrancheData();
        IERC20Upgradeable collateralToken = IERC20Upgradeable(bond.collateralToken());
        IERC20Upgradeable feeToken = perp.feeToken();

        // transfers collateral & fees to router
        collateralToken.safeTransferFrom(msg.sender, address(this), collateralAmount);
        if (feePaid > 0) {
            feeToken.safeTransferFrom(msg.sender, address(this), feePaid);
        }

        // approves collateral to be tranched
        _checkAndApproveMax(collateralToken, address(bond), collateralAmount);

        // tranches collateral
        bond.deposit(collateralAmount);

        // approves fee to be spent to rollover
        if (feePaid > 0) {
            _checkAndApproveMax(feeToken, address(perp), feePaid);
        }

        for (uint256 i = 0; i < rollovers.length; i++) {
            // approve trancheIn to be spent by perp
            _checkAndApproveMax(rollovers[i].trancheIn, address(perp), rollovers[i].trancheInAmt);

            // perform rollover
            perp.rollover(rollovers[i].trancheIn, rollovers[i].trancheOut, rollovers[i].trancheInAmt);
        }

        for (uint256 i = 0; i < rollovers.length; i++) {
            // transfer remaining trancheOut tokens back
            uint256 trancheOutBalance = rollovers[i].trancheOut.balanceOf(address(this));
            if (trancheOutBalance > 0) {
                rollovers[i].trancheOut.safeTransfer(msg.sender, trancheOutBalance);
            }
        }

        // transfers unused tranches back
        for (uint8 i = 0; i < td.trancheCount; i++) {
            uint256 trancheBalance = td.tranches[i].balanceOf(address(this));
            if (trancheBalance > 0) {
                td.tranches[i].safeTransfer(msg.sender, trancheBalance);
            }
        }

        // transfers any remaining collateral tokens back
        uint256 collateralBalance = collateralToken.balanceOf(address(this));
        if (collateralBalance > 0) {
            collateralToken.safeTransfer(msg.sender, collateralBalance);
        }

        // transfers remaining fee back if overpaid or reward
        uint256 feeBalance = feeToken.balanceOf(address(this));
        if (feeBalance > 0) {
            feeToken.safeTransfer(msg.sender, feeBalance);
        }
    }

    // @dev Checks if the spender has sufficient allowance. If not, approves the maximum possible amount.
    function _checkAndApproveMax(
        IERC20Upgradeable token,
        address spender,
        uint256 amount
    ) private {
        uint256 allowance = token.allowance(address(this), spender);
        if (allowance < amount) {
            token.approve(spender, type(uint256).max);
        }
    }
}
