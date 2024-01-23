// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IERC20MetadataUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";
import { ITranche } from "./_interfaces/buttonwood/ITranche.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";
import { IPerpetualTranche } from "./_interfaces/IPerpetualTranche.sol";
import { IRolloverVault } from "./_interfaces/IRolloverVault.sol";
import { IFeePolicy } from "./_interfaces/IFeePolicy.sol";
import { TokenAmount, SubscriptionParams } from "./_interfaces/CommonTypes.sol";
import { UnacceptableRedemption } from "./_interfaces/ProtocolErrors.sol";

import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { BondTranches, BondTranchesHelpers } from "./_utils/BondTranchesHelpers.sol";
import { BondHelpers } from "./_utils/BondHelpers.sol";

/**
 *  @title Balancer
 *
 *  @notice A router contract to interact with both perp and rollover vault tokens in unison.
 *
 *          The role of fees in this system is to balance TVL in the perp and vault systems
 *          (i.e) push the `deviationRatio` toward 1.0.
 *
 *          All Balancer operations, by construction push the system toward the target deviation ratio.
 *          If a user interacts with the system through the Balancer, they pay no fee.
 *
 *          1) When the user mints/burns both perps and vault notes together in the magic ratio.
 *             Both operations always push the system toward a `deviationRatio` of 1.0.
 *
 *          2) When the system is under-subscribed, and the user burns perp and mints vault notes.
 *             This operation strictly increases the system's `deviationRatio` toward 1.0.
 *
 *          3) When the system is over-subscribed, and the user burns vault notes and mints perps.
 *             This operation strictly decrease the system's `deviationRatio` toward 1.0.
 *
 *
 */
contract Balancer {
    // math
    using MathUpgradeable for uint256;

    // data handling
    using BondHelpers for IBondController;
    using BondTranchesHelpers for BondTranches;

    // ERC20 operations
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using SafeERC20Upgradeable for ITranche;
    using SafeERC20Upgradeable for IPerpetualTranche;
    using SafeERC20Upgradeable for IRolloverVault;

    //-------------------------------------------------------------------------
    // Constants & Immutables

    /// @dev Immature redemption may result in some dust tranches when balances are not perfectly divisible by the tranche ratio.
    ///      Based on current the implementation of `computeRedeemableTrancheAmounts`,
    ///      the dust balances which remain after immature redemption will be at most {TRANCHE_RATIO_GRANULARITY} or 1000.
    ///      We exclude dust tranche balances from recurrent immature redemption.
    uint256 public constant TRANCHE_DUST_AMT = 1000;

    uint8 public constant FEE_POLICY_DECIMALS = 8;
    uint256 public constant FEE_ONE_PERC = (10**FEE_POLICY_DECIMALS);

    //-------------------------------------------------------------------------
    // External methods

    /// @notice Mints perp tokens and vault notes, in the magic ratio using underlying tokens.
    /// @dev This operation should always move the `deviationRatio` toward 1.0.
    /// @param perp Address of the perp contract.
    /// @param underlyingAmtIn The amount of underlying tokens sent in.
    /// @return perpAmtMinted The amount of perp tokens minted.
    /// @return vaultAmtMinted The amount of vault notes minted.
    function deposit2(IPerpetualTranche perp, uint256 underlyingAmtIn) external returns (uint256, uint256) {
        IRolloverVault vault = perp.vault();
        IERC20Upgradeable underlying = perp.underlying();

        // Transfer underlying tokens from user
        underlying.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // approve underlying to be spent
        _checkAndApproveMax(underlying, address(vault), underlyingAmtIn);

        // Figure out the accepted perp/vault collateral split
        (uint256 perpPerc, uint256 vaultPerc) = perp.feePolicy().computeNeutralPerpVaultSplit(
            perp.getDepositTrancheRatio()
        );

        // mint notes based on the vault ratio
        uint256 underlyingAmtIntoVault = underlyingAmtIn.mulDiv(
            vaultPerc,
            (perpPerc + vaultPerc),
            MathUpgradeable.Rounding.Up
        );
        vault.deposit(underlyingAmtIntoVault);

        // use the remaining collateral create perps
        vault.swapUnderlyingForPerps(underlyingAmtIn - underlyingAmtIntoVault);

        // Transfer perps and notes back to user
        return (_transferAll(perp, msg.sender), _transferAll(vault, msg.sender));
    }

    struct PairAmounts {
        // NOTE `perpAmt` and `noteAmt` have different base denominations.

        // @notice Amount of perp tokens.
        uint256 perpAmt;
        // @notice Amount of vault notes.
        uint256 noteAmt;
    }

    /// @notice Burns perp tokens and vault notes, in the magic ratio and redeems underlying tokens and tranches.
    /// @dev This operation should always move the `deviationRatio` toward 1.0.
    /// @param perp Address of the perp contract.
    /// @param availableAmts The spendable amount of perp tokens and vault notes in the sender's balance.
    /// @return burntAmts The amount of perp tokens and vault notes burnt.
    /// @return tokensOut The list of redeemed tokens and amounts returned to the user.
    function redeem2(IPerpetualTranche perp, PairAmounts memory availableAmts)
        external
        returns (PairAmounts memory, TokenAmount[] memory)
    {
        IRolloverVault vault = perp.vault();

        // Compute the user's available balances
        availableAmts.perpAmt = MathUpgradeable.min(availableAmts.perpAmt, perp.balanceOf(msg.sender));
        availableAmts.noteAmt = MathUpgradeable.min(availableAmts.noteAmt, vault.balanceOf(msg.sender));

        // Compute redemption amounts
        PairAmounts memory burnAmts = _computeNeutralBurnAmts(perp, vault, availableAmts);

        // Transfer perps and vault notes from the user
        perp.safeTransferFrom(msg.sender, address(this), burnAmts.perpAmt);
        vault.safeTransferFrom(msg.sender, address(this), burnAmts.noteAmt);

        // Redeem both perps and vault notes for tranches and underlying
        TokenAmount[] memory perpTokens = perp.redeem(burnAmts.perpAmt);
        TokenAmount[] memory vaultTokens = vault.redeem(burnAmts.noteAmt);

        // Meld perp tranches with vault tranches if possible if not transfer out
        TokenAmount[] memory tokensOut = new TokenAmount[](perpTokens.length + vaultTokens.length - 1);

        // Note we transfer underlying out and set the amount at the end after melding
        uint8 k = 0;
        IERC20Upgradeable underlying = perpTokens[0].token;
        tokensOut[k++] = TokenAmount({ token: underlying, amount: 0 });

        for (uint8 i = 1; i < perpTokens.length; i++) {
            IERC20Upgradeable token = perpTokens[i].token;
            _redeemImmatureTranche(ITranche(address(token)));
            tokensOut[k++] = TokenAmount({ token: token, amount: _transferAll(token, msg.sender) });
        }

        for (uint8 i = 1; i < vaultTokens.length; i++) {
            IERC20Upgradeable token = vaultTokens[i].token;
            tokensOut[k++] = TokenAmount({ token: token, amount: _transferAll(token, msg.sender) });
        }

        // transfer out remaining underlying
        tokensOut[0].amount = _transferAll(underlying, msg.sender);

        return (burnAmts, _removeEmptyTokens(tokensOut));
    }

    /// @notice Burns perp tokens and mints vault notes.
    /// @dev Swaps perp tokens for underlying which are deposited into the vault.
    ///      This operation increases the system's `deviationRatio` (by reducing the perpTVL and increasing the vaultTVL).
    ///      Its only allowed when the system is under-subscribed.
    /// @param perp Address of the perp contract.
    /// @param perpAmtBurnt The amount of perp tokens to be burnt.
    /// @return notesMinted The amount of vault notes minted.
    function redeemPerpsAndMintVaultNotes(IPerpetualTranche perp, uint256 perpAmtBurnt) external returns (uint256) {
        IRolloverVault vault = perp.vault();
        IERC20Upgradeable underlying = perp.underlying();

        // Enforce `deviationRatio`
        if (_queryDeviationRatio(perp, vault) > FEE_ONE_PERC) {
            revert UnacceptableRedemption();
        }

        // Transfer perps from user
        perp.safeTransferFrom(msg.sender, address(this), perpAmtBurnt);

        // Swap perps for underlying
        _checkAndApproveMax(perp, address(vault), perpAmtBurnt);
        uint256 underlyingAmt = vault.swapPerpsForUnderlying(perpAmtBurnt);

        // Deposit underlying into vault
        _checkAndApproveMax(underlying, address(vault), underlyingAmt);
        vault.deposit(underlyingAmt);

        // Transfer minted notes back to user
        return _transferAll(vault, msg.sender);
    }

    /// @notice Burns vault notes and mints as many perps as possible.
    /// @dev Redeems vault notes for the underlying tokens and tranches, then swaps the underlying for perps and
    ///      returns all intermediate tokens to the user.
    ///      This operation decreases the system's `deviationRatio` (by reducing the vaultTVL and increasing the perpTVL).
    ///      Its only allowed when the system is over-subscribed.
    /// @param perp Address of the perp contract.
    /// @param noteAmtBurnt The amount of vault notes to be burnt.
    /// @return perpsMinted The amount of perps minted.
    /// @return tokensOut The list of redeemed tokens and amounts returned to the user.
    function redeemVaultNotesAndMintPerps(IPerpetualTranche perp, uint256 noteAmtBurnt)
        external
        returns (uint256, TokenAmount[] memory)
    {
        IRolloverVault vault = perp.vault();

        // Enforce `deviationRatio`
        if (_queryDeviationRatio(perp, vault) <= FEE_ONE_PERC) {
            revert UnacceptableRedemption();
        }

        // Transfer vault notes from user
        vault.safeTransferFrom(msg.sender, address(this), noteAmtBurnt);

        // Calculate and charge vault note redemption fee
        uint256 redemptionFeeAmt = noteAmtBurnt.mulDiv(
            feePolicy.computeVaultBurnFeePerc(),
            FEE_ONE_PERC,
            MathUpgradeable.Rounding.Up
        );

        // The remaining is redeemed for underlying and tranches
        noteAmtBurnt -= redemptionFeeAmt;

        // redeem vault notes
        TokenAmount[] memory vaultTokens = vault.redeem(noteAmtBurnt);

        // use redeemed underlying to mint perps
        vault.swapUnderlyingForPerps(vaultTokens[0].amount);

        // keep track of all vault tokens redeemed
        TokenAmount[] memory tokensOut = new TokenAmount[](vaultTokens.length);
        for (uint8 i = 0; i < vaultTokens.length; i++) {
            // transfer any remaining vault tokens out
            IERC20Upgradeable token = vaultTokens[i].token;
            tokensOut[i] = TokenAmount({ token: token, amount: _transferAll(token, msg.sender) });
        }

        // Transfer minted perps back to user and return the list of vault tokens
        return (_transferAll(perp, msg.sender), tokensOut);
    }

    //-------------------------------------------------------------------------
    // Private methods

    struct SystemTVL {
        uint256 perpTVL;
        uint256 perpSupply;
        uint256 vaultTVL;
        uint256 noteSupply;
    }

    /// @dev Calculates the amount of perps and vault notes to burn based on the magic ratio.
    function _computeNeutralBurnAmts(
        IPerpetualTranche perp,
        IRolloverVault vault,
        PairAmounts memory availableAmts
    ) private returns (PairAmounts memory) {
        // Compute current system state

        // NOTE: `perpSupply` and `noteSupply` have different base denominations.
        SystemTVL memory s = SystemTVL({
            perpTVL: perp.getTVL(),
            perpSupply: perp.totalSupply(),
            vaultTVL: vault.getTVL(),
            noteSupply: vault.totalSupply()
        });

        // Figure out the accepted perp/vault collateral split
        (uint256 perpPerc, uint256 vaultPerc) = perp.feePolicy().computeNeutralPerpVaultSplit(
            perp.getDepositTrancheRatio()
        );

        // We calculate `noteAmtReq` based on `availableAmts.perpAmt`
        PairAmounts memory burnAmts;
        burnAmts.perpAmt = availableAmts.perpAmt;
        burnAmts.noteAmt = (s.noteSupply)
            .mulDiv(burnAmts.perpAmt, s.perpSupply, MathUpgradeable.Rounding.Up)
            .mulDiv(s.perpTVL, s.vaultTVL, MathUpgradeable.Rounding.Up)
            .mulDiv(vaultPerc, perpPerc, MathUpgradeable.Rounding.Up);

        // if more notes are burnAmtsuired than availableable, we recalculate `burnAmts.perpAmt` based on `availableAmts.noteAmt`
        if (burnAmts.noteAmt > availableAmts.noteAmt) {
            burnAmts.noteAmt = availableAmts.noteAmt;
            burnAmts.perpAmt = (s.perpSupply)
                .mulDiv(burnAmts.noteAmt, s.noteSupply, MathUpgradeable.Rounding.Up)
                .mulDiv(s.vaultTVL, s.perpTVL, MathUpgradeable.Rounding.Up)
                .mulDiv(perpPerc, vaultPerc, MathUpgradeable.Rounding.Up);
        }

        return burnAmts;
    }

    /// @dev Redeems tranche tokens held by this contract, for underlying.
    function _redeemImmatureTranche(ITranche tranche) private {
        uint256 trancheBalance = tranche.balanceOf(address(this));
        if (trancheBalance < TRANCHE_DUST_AMT) {
            return;
        }

        IBondController bond = IBondController(tranche.bond());
        uint256[] memory trancheAmts = (bond.getTranches()).computeRedeemableTrancheAmounts(address(this));
        if (trancheAmts[0] > 0) {
            bond.redeem(trancheAmts);
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

    /// @dev Queries the current subscription state of the perp and vault systems.
    function _querySubscriptionState(IPerpetualTranche perp, IRolloverVault vault)
        private
        returns (SubscriptionParams memory)
    {
        return
            SubscriptionParams({
                perpTVL: perp.getTVL(),
                vaultTVL: vault.getTVL(),
                seniorTR: perp.getDepositTrancheRatio()
            });
    }

    /// @dev Filters out tokens with zero amounts.
    function _removeEmptyTokens(TokenAmount[] memory tokensOut) private pure returns (TokenAmount[] memory) {
        uint8 k = 0;
        for (uint8 i = 0; i < tokensOut.length; i++) {
            if (tokensOut[i].amount > 0) {
                k++;
            }
        }
        TokenAmount[] memory filteredTokensOut = new TokenAmount[](k);
        k = 0;
        for (uint8 i = 0; i < tokensOut.length; i++) {
            if (tokensOut[i].amount > 0) {
                filteredTokensOut[k++] = tokensOut[i];
            }
        }
        return filteredTokensOut;
    }

    /// @dev Calculates the amount of perps and vault notes to burn such that the system's deviation ratio remains unchanged.
    function _computeProportionalBurnAmts(PairAmounts memory availableAmts, PairAmounts memory totalSupplies)
        private
        pure
        returns (PairAmounts memory)
    {
        // We calculate `noteAmtReq` based on `availableAmts.perpAmt`.
        // (perpAmt / perpSupply) = (noteAmt / noteSupply) => calculating the same share of supply.
        // If x% of perp supply and note supply are burnt, then the system's deviation ratio remains unchanged.
        PairAmounts memory burnAmts = PairAmounts({
            perpAmt: availableAmts.perpAmt,
            noteAmt: totalSupplies.noteAmt.mulDiv(
                availableAmts.perpAmt,
                totalSupplies.perpAmt,
                MathUpgradeable.Rounding.Up
            )
        });

        // if more notes are required to be burnt than available,
        // we recalculate `burnAmts.perpAmt` based on `availableAmts.noteAmt`
        if (burnAmts.noteAmt > availableAmts.noteAmt) {
            burnAmts = PairAmounts({
                noteAmt: availableAmts.noteAmt,
                perpAmt: totalSupplies.perpAmt.mulDiv(
                    availableAmts.noteAmt,
                    totalSupplies.noteAmt,
                    MathUpgradeable.Rounding.Up
                )
            });
        }

        return burnAmts;
    }
}
