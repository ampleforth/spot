// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IPerpetualTranche } from "./IPerpetualTranche.sol";
import { IRolloverVault } from "./IRolloverVault.sol";
import { ITranche } from "./buttonwood/ITranche.sol";
import { SubscriptionParams, PairAmounts, TokenAmount } from "./CommonTypes.sol";

interface IBalancer {
    //--------------------------------------------------------------------------
    // Events

    /// @notice Emits the fees collected by perp.
    /// @param perpAmt The amount of perp tokens paid as fees.
    event FeePerps(uint256 perpAmt);

    /// @notice Emits the fees collected by the vault.
    /// @param noteAmt The amount of vault notes paid as fees.
    event FeeVault(uint256 noteAmt);

    /// @notice Emits the protocol fee collected by the system paid to the owner.
    /// @param underlyingAmt The amount of underlying tokens paid as fees.
    event FeeProtocol(uint256 underlyingAmt);

    //--------------------------------------------------------------------------
    // Methods

    /// @return The address of the perp token.
    function perp() external view returns (IPerpetualTranche);

    /// @return The address of the rollover vault.
    function vault() external view returns (IRolloverVault);

    /// @return The address of the underlying rebasing token.
    function underlying() external view returns (IERC20Upgradeable);

    /// @notice Mints perps and vault notes at the right ratio using the underlying token.
    /// @param underlyingAmtIn The amount of underlying tokens deposited.
    /// @return The amount of perps and vault notes minted.
    function mint2(uint256 underlyingAmtIn) external returns (PairAmounts memory);

    /// @notice Redeems perps and vault notes for the underlying token and remainder tranches.
    /// @param burnAmts The amount of perps and vault notes to be redeemed.
    /// @return underlyingAmt The amount of underlying redeemed.
    /// @return perpTranches The remainder tranches from redeeming perp tokens.
    /// @return vaultTranches The remainder tranches from redeeming vault notes.
    function redeem2(
        PairAmounts memory burnAmts
    ) external returns (uint256 underlyingAmt, TokenAmount[] memory perpTranches, TokenAmount[] memory vaultTranches);

    /// @notice Redeems perps and vault notes for the underlying token and
    ///         re-mints perps and vault notes based on the system's neutral ratio.
    ///         It returns perps, vault notes and remainder tranches.
    /// @param burnAmts The amount of perps and vault notes to be redeemed.
    /// @return mintAmts The amount of perp tokens and vault notes re-minted.
    /// @return perpTranches The remainder perp tranches after re-minting.
    /// @return vaultTranches The remainder vault tranches after re-minting.
    function rebalance(
        PairAmounts memory burnAmts
    ) external returns (PairAmounts memory, TokenAmount[] memory, TokenAmount[] memory);

    /// @notice Mints perps using accepted senior tranches.
    /// @param trancheIn The address of the senior tranche token to be deposited into perp.
    /// @param trancheInAmt The amount of tranche tokens deposited.
    /// @return The amount of perps minted.
    function mintPerps(ITranche trancheIn, uint256 trancheInAmt) external returns (uint256);

    /// @notice Redeems perps for the senior tranches and underlying tokens backing it.
    /// @param perpAmtBurnt The amount of perps to be burnt.
    /// @return tokensOut The list of perp's reserve tokens and amounts redeemed.
    function redeemPerps(uint256 perpAmtBurnt) external returns (TokenAmount[] memory);

    /// @notice Mints vault notes using underlying tokens.
    /// @param underlyingAmtIn The amount of underlying tokens to be deposited into the vault.
    /// @return The amount of vault notes minted.
    function mintVaultNotes(uint256 underlyingAmtIn) external returns (uint256);

    /// @notice Redeems vault notes for the junior tranches and underlying tokens backing it.
    /// @param noteAmtBurnt The amount of vault notes to be burnt.
    /// @return The list of the vault's asset tokens and amounts redeemed.
    function redeemVaultNotes(uint256 noteAmtBurnt) external returns (TokenAmount[] memory);

    /// @notice Swaps underlying tokens for perps.
    /// @param underlyingAmtIn The amount of underlying tokens swapped in.
    /// @return The amount of perps swapped out.
    function swapUnderlyingForPerps(uint256 underlyingAmtIn) external returns (uint256);

    /// @notice Swaps perps for underlying tokens.
    /// @param perpAmtIn The amount of perps swapped in.
    /// @return The amount of underlying tokens swapped out.
    function swapPerpsForUnderlying(uint256 perpAmtIn) external returns (uint256);

    /// @return Number of whitelisted rebalancers.
    function rebalancerCount() external view returns (uint256);

    /// @param index The index of the rebalancer whitelist.
    /// @return Rebalancers at a given index.
    function rebalancerAt(uint256 index) external view returns (address);

    /// @return Number of decimals representing a multiplier of 1.0. So, 100% = 1*10**decimals.
    function decimals() external view returns (uint8);

    /// @param dr The current system deviation ratio.
    /// @return The applied exchange rate adjustment between tranches into perp and
    ///         tokens out of perp during a rollover,
    ///         as a fixed-point number with {DECIMALS} decimal places.
    /// @dev - A fee of 0%, implies the rollover exchange rate is unaltered.
    ///         example) 100 tranchesIn for 100 tranchesOut
    ///      - A fee of 1%, implies the exchange rate is adjusted in favor of tranchesIn.
    ///         example) 100 tranchesIn for 99 tranchesOut; i.e) perp enrichment
    ///      - A fee of -1%, implies the exchange rate is adjusted in favor of tranchesOut.
    ///         example) 99 tranchesIn for 100 tranchesOut
    function computeRolloverFeePerc(uint256 dr) external view returns (int256);

    /// @notice Fetches the system's current subscription state.
    /// @return The the perp, vault tvls and the senior tranche ratio.
    function subscriptionState() external view returns (SubscriptionParams memory);

    /// @param s The subscription parameters of both the perp and vault systems.
    /// @return The deviation ratio given the system subscription parameters.
    function computeDeviationRatio(SubscriptionParams memory s) external view returns (uint256);

    /// @return The current deviation ratio of the system.
    function deviationRatio() external view returns (uint256);

    /// @notice Computes the amount of perp tokens that are returned when user swaps a given number of underlying tokens.
    /// @param underlyingAmtIn The number of underlying tokens the user swaps in.
    /// @return perpAmtOut The number of perp tokens returned to the user.
    /// @return underlyingAmtSwapped The number of underlying tokens swapped into perp tokens (after partial fee withholding).
    /// @return perpFeeAmtToBurn Perp's share of the swap fee paid in perp tokens.
    /// @return vaultFeeUnderlyingAmt The vault's share of the swap fee paid in underlying tokens.
    /// @return protocolFeeUnderlyingAmt The protocol share of the swap fee paid in underlying tokens.
    function computeUnderlyingToPerpSwapAmt(
        uint256 underlyingAmtIn
    ) external view returns (uint256, uint256, uint256, uint256, uint256);

    /// @notice Computes the amount of underlying tokens that are returned when user swaps a given number of perp tokens.
    /// @param perpAmtIn The number of perp tokens the user swaps in.
    /// @return underlyingAmtOut The number of underlying tokens returned to the user.
    /// @return perpAmtSwapped The number of perp tokens swapped into underlying tokens (after partial fee withholding).
    /// @return perpFeeAmtToBurn Perp's share of the swap fee paid in underlying tokens.
    /// @return vaultFeeUnderlyingAmt The vault's share of the swap fee paid in underlying tokens.
    /// @return protocolFeeUnderlyingAmt The protocol share of the swap fee paid in underlying tokens.
    function computePerpToUnderlyingSwapAmt(
        uint256 perpAmtIn
    ) external view returns (uint256, uint256, uint256, uint256, uint256);
}
