// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { SignedMath } from "@openzeppelin/contracts/utils/math/SignedMath.sol";

import { TrancheData, BondHelpers, TrancheDataHelpers } from "./_utils/BondHelpers.sol";

import { IPerpetualTranche } from "./_interfaces/IPerpetualTranche.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "./_interfaces/buttonwood/ITranche.sol";

/*
 *  @title RouterV1
 *
 *  @notice Contract to dry-run and batch multiple operations.
 *
 */
contract RouterV1 {
    using Math for uint256;
    using SafeCast for uint256;
    using SignedMath for int256;
    using SafeERC20 for IERC20;
    using SafeERC20 for ITranche;
    using SafeERC20 for IPerpetualTranche;
    using BondHelpers for IBondController;
    using TrancheDataHelpers for TrancheData;

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

    // @notice Calculates the amount of perp tokens are minted and fees for the operation.
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
            IERC20 feeToken,
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
    //         transaction sender along with, any unused tranches and fees.
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
        require(perp.getDepositBond() == bond, "Expected to tranche deposit bond");

        TrancheData memory td = bond.getTrancheData();
        IERC20 collateralToken = IERC20(bond.collateralToken());
        IERC20 feeToken = perp.feeToken();

        // transfers collateral & fees to router
        collateralToken.safeTransferFrom(msg.sender, address(this), collateralAmount);
        if (feePaid > 0) {
            feeToken.safeTransferFrom(msg.sender, address(this), feePaid);
        }

        // approves collateral to be tranched tranched
        _checkAndApproveMax(collateralToken, address(bond), collateralAmount);

        // tranches collateral
        bond.deposit(collateralToken.balanceOf(address(this)));

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
    function previewRedeemFromQueue(
        IPerpetualTranche perp,
        uint256 perpAmountRequested,
        uint256 maxTranches
    )
        external
        afterPerpStateUpdate(perp)
        returns (
            uint256 burnAmt,
            IERC20 feeToken,
            int256 burnFee,
            ITranche[] memory tranches
        )
    {
        uint256 remainder = perpAmountRequested;
        maxTranches = Math.min(perp.getRedemptionQueueCount(), maxTranches);
        tranches = new ITranche[](maxTranches);
        for (uint256 i = 0; remainder > 0 && i < maxTranches; i++) {
            // NOTE: loops through queue from head to tail, i.e) in redemption order
            ITranche t = ITranche(perp.getRedemptionQueueAt(i));
            (, remainder) = perp.perpsToCoveredTranches(t, remainder, type(uint256).max);
            tranches[i] = t;
        }

        burnAmt = perpAmountRequested - remainder;
        feeToken = perp.feeToken();
        burnFee = perp.feeStrategy().computeBurnFee(burnAmt);

        return (burnAmt, feeToken, burnFee, tranches);
    }

    // @notice Calculates the tranche tokens that can be redeemed from the icebox
    //         for burning up to the requested amount of perp tokens.
    // @dev Used by off-chain services to preview a redeem operation.
    // @param perp Address of the perpetual tranche contract.
    // @param perpAmountRequested The amount of perp tokens requested to be burnt.
    // @param requestedTranches The list of requested tranches the user wants to redeem.
    // @return burnAmt The amount of perp tokens burnt.
    // @return feeToken The address of the fee token.
    // @return burnFee The fee charged for burning.
    // @return numTranchesRedeemed The number of tranches from the requested list redeemed.
    function previewRedeemFromIcebox(
        IPerpetualTranche perp,
        uint256 perpAmountRequested,
        ITranche[] memory requestedTranches
    )
        external
        afterPerpStateUpdate(perp)
        returns (
            uint256 burnAmt,
            IERC20 feeToken,
            int256 burnFee,
            uint256 numTranchesRedeemed
        )
    {
        require(perp.getRedemptionQueueCount() == 0, "Expected redemption queue to be empty");

        uint256 remainder = perpAmountRequested;

        uint256 i;
        for (i = 0; remainder > 0 && i < requestedTranches.length; i++) {
            // NOTE: loops through requested list
            (, remainder) = perp.perpsToCoveredTranches(requestedTranches[i], remainder, type(uint256).max);
        }

        burnAmt = perpAmountRequested - remainder;
        feeToken = perp.feeToken();
        burnFee = perp.feeStrategy().computeBurnFee(burnAmt);
        numTranchesRedeemed = i;

        return (burnAmt, feeToken, burnFee, numTranchesRedeemed);
    }

    // @notice Redeems perp tokens for tranche tokens until the tranche balance covers it.
    // @param perp Address of the perpetual tranche contract.
    // @param perpAmountRequested The amount of perp tokens requested to be burnt.
    // @param fee The fee paid for burning.
    // @param requestedTranches The tranches in order to be redeemed.
    // @dev Fee and requestedTranches list are to be pre-computed off-chain using the preview function.
    function redeem(
        IPerpetualTranche perp,
        uint256 perpAmountRequested,
        uint256 fee,
        ITranche[] memory requestedTranches
    ) external afterPerpStateUpdate(perp) {
        IERC20 feeToken = perp.feeToken();
        uint256 remainder = perpAmountRequested;

        // transfer collateral & fee to router
        perp.safeTransferFrom(msg.sender, address(this), remainder);
        if (fee > 0) {
            feeToken.safeTransferFrom(msg.sender, address(this), fee);
        }

        // Approve fees to be spent from router
        _checkAndApproveMax(feeToken, address(perp), fee);

        uint256 trancheCount;
        while (remainder > 0) {
            ITranche t = requestedTranches[trancheCount++];

            // When the tranche queue is non empty redeem expects
            //     - t == perp.getRedemptionTranche()
            // When the tranche queue is empty redeem can happen in any order
            (uint256 burnAmt, ) = perp.redeem(t, remainder);
            remainder -= burnAmt;

            // Transfer redeemed tranches back
            t.safeTransfer(msg.sender, t.balanceOf(address(this)));
        }

        // transfers remaining fee back if overpaid or reward
        uint256 feeBalance = feeToken.balanceOf(address(this));
        if (feeBalance > 0) {
            feeToken.safeTransfer(msg.sender, feeBalance);
        }

        // Transfer remainder perp tokens
        perp.safeTransfer(msg.sender, perp.balanceOf(address(this)));
    }

    struct RolloverPreivew {
        uint256 rolloverAmt;
        uint256 requestedRolloverAmt;
        uint256 trancheOutAmt;
        uint256 remainingTrancheInAmt;
    }

    // @notice Calculates the amount tranche tokens that can be rolled out, remainders and fees,
    //         with a given the tranche token rolled in and amount.
    // @dev Used by off-chain services to preview a rollover operation.
    // @param perp Address of the perpetual tranche contract.
    // @param trancheIn The tranche token deposited.
    // @param trancheOut The tranche token requested to be redeemed.
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
            RolloverPreivew memory r,
            IERC20 feeToken,
            int256 rolloverFee
        )
    {
        require(perp.isAcceptableRollover(trancheIn, trancheOut), "Expected rollover to be acceptable");

        r.requestedRolloverAmt = perp.tranchesToPerps(trancheIn, trancheInAmt);

        uint256 rolloverAmtRemainder;
        (r.trancheOutAmt, rolloverAmtRemainder) = perp.perpsToCoveredTranches(
            trancheOut,
            r.requestedRolloverAmt,
            maxTrancheOutAmtUsed
        );
        r.rolloverAmt = r.requestedRolloverAmt - rolloverAmtRemainder;

        r.remainingTrancheInAmt = perp.perpsToTranches(trancheIn, rolloverAmtRemainder);

        feeToken = perp.feeToken();
        rolloverFee = perp.feeStrategy().computeRolloverFee(r.rolloverAmt);

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
    // @param feePaid The fee paid to the perpetual tranche contract to mint perp.
    function trancheAndRollover(
        IPerpetualTranche perp,
        IBondController bond,
        uint256 collateralAmount,
        RolloverBatch[] memory rollovers,
        uint256 feePaid
    ) external afterPerpStateUpdate(perp) {
        require(rollovers.length > 0, "Expected atleast one rollover in batch");
        require(perp.getDepositBond() == bond, "Expected to tranche deposit bond");

        TrancheData memory td = bond.getTrancheData();
        IERC20 collateralToken = IERC20(bond.collateralToken());
        IERC20 feeToken = perp.feeToken();

        // transfers collateral & fees to router
        collateralToken.safeTransferFrom(msg.sender, address(this), collateralAmount);
        if (feePaid > 0) {
            feeToken.safeTransferFrom(msg.sender, address(this), feePaid);
        }

        // approves collateral to be tranched tranched
        _checkAndApproveMax(collateralToken, address(bond), collateralAmount);

        // tranches collateral
        bond.deposit(collateralToken.balanceOf(address(this)));

        // approves fee to be spent to rollover
        _checkAndApproveMax(feeToken, address(perp), feePaid);

        for (uint256 i = 0; i < rollovers.length; i++) {
            // approve trancheIn to be spent by perp
            _checkAndApproveMax(rollovers[i].trancheIn, address(perp), rollovers[i].trancheInAmt);

            // perform rollover
            perp.rollover(rollovers[i].trancheIn, rollovers[i].trancheOut, rollovers[i].trancheInAmt);

            // transfer trancheOut tokens back
            rollovers[i].trancheOut.safeTransfer(msg.sender, rollovers[i].trancheOut.balanceOf(address(this)));
        }

        // transfers unused tranches back
        for (uint8 i = 0; i < td.trancheCount; i++) {
            uint256 trancheBalance = td.tranches[i].balanceOf(address(this));
            if (trancheBalance > 0) {
                td.tranches[i].safeTransfer(msg.sender, trancheBalance);
            }
        }

        // transfers remaining fee back if overpaid or reward
        uint256 feeBalance = feeToken.balanceOf(address(this));
        if (feeBalance > 0) {
            feeToken.safeTransfer(msg.sender, feeBalance);
        }
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
