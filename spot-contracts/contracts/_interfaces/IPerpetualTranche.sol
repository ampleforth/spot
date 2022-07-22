// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

import { IBondIssuer } from "./IBondIssuer.sol";
import { IFeeStrategy } from "./IFeeStrategy.sol";
import { IPricingStrategy } from "./IPricingStrategy.sol";
import { IYieldStrategy } from "./IYieldStrategy.sol";
import { IBondController } from "./buttonwood/IBondController.sol";
import { ITranche } from "./buttonwood/ITranche.sol";

interface IPerpetualTranche is IERC20Upgradeable {
    //--------------------------------------------------------------------------
    // Events

    // @notice Event emitted when the bond issuer is updated.
    // @param issuer Address of the issuer contract.
    event UpdatedBondIssuer(IBondIssuer issuer);

    // @notice Event emitted when the fee strategy is updated.
    // @param strategy Address of the strategy contract.
    event UpdatedFeeStrategy(IFeeStrategy strategy);

    // @notice Event emitted when the pricing strategy is updated.
    // @param strategy Address of the strategy contract.
    event UpdatedPricingStrategy(IPricingStrategy strategy);

    // @notice Event emitted when the yield strategy is updated.
    // @param strategy Address of the strategy contract.
    event UpdatedYieldStrategy(IYieldStrategy strategy);

    // @notice Event emitted when maturity tolerance parameters are updated.
    // @param min The minimum maturity time.
    // @param max The maximum maturity time.
    event UpdatedTolerableTrancheMaturity(uint256 min, uint256 max);

    // @notice Event emitted when the max total supply is updated.
    // @param maxSupply The max total supply.
    // @param maxMintAmtPerTranche The max mint amount per tranche.
    event UpdatedMintingLimits(uint256 maxSupply, uint256 maxMintAmtPerTranche);

    // @notice Event emitted when the applied yield for a given token is set.
    // @param token The address of the token.
    // @param yield The yield factor applied.
    event YieldApplied(IERC20Upgradeable token, uint256 yield);

    // @notice Event emitted the reserve's current token balance is recorded after change.
    // @param token Address of token.
    // @param balance The recorded ERC-20 balance of the token held by the reserve.
    event ReserveSynced(IERC20Upgradeable token, uint256 balance);

    // @notice Event emitted when the active deposit bond is updated.
    // @param bond Address of the new deposit bond.
    event UpdatedDepositBond(IBondController bond);

    // @notice Event emitted when the mature tranche balance is updated.
    // @param matureTrancheBalance The mature tranche balance.
    event UpdatedMatureTrancheBalance(uint256 matureTrancheBalance);

    //--------------------------------------------------------------------------
    // Methods

    // @notice Deposits tranche tokens into the system and mint perp tokens.
    // @param trancheIn The address of the tranche token to be deposited.
    // @param trancheInAmt The amount of tranche tokens deposited.
    function deposit(ITranche trancheIn, uint256 trancheInAmt) external;

    // @notice Burn perp tokens and redeem the share of reserve assets.
    // @param perpAmtBurnt The amount of perp tokens burnt from the caller.
    function burn(uint256 perpAmtBurnt) external;

    // @notice Rotates newer tranches in for reserve tokens.
    // @param trancheIn The tranche token deposited.
    // @param tokenOut The reserve token to be redeemed.
    // @param trancheInAmt The amount of trancheIn tokens deposited.
    function rollover(
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmt
    ) external;

    // @notice Burn perp tokens without redemption.
    // @param amount Amount of perp tokens to be burnt.
    // @return True if burn is successful.
    function burnWithoutRedemption(uint256 amount) external returns (bool);

    // @notice The address of the underlying rebasing ERC-20 collateral token backing the tranches.
    // @return Address of the collateral token.
    function collateral() external view returns (IERC20Upgradeable);

    // @notice The "virtual" balance of all mature tranches held by the system.
    // @return The mature tranche balance.
    function getMatureTrancheBalance() external returns (uint256);

    // @notice The parent bond whose tranches are currently accepted to mint perp tokens.
    // @return Address of the deposit bond.
    function getDepositBond() external returns (IBondController);

    // @notice Checks if the given `trancheIn` can be rolled out for `tokenOut`.
    // @param trancheIn The tranche token deposited.
    // @param tokenOut The reserve token to be redeemed.
    function isAcceptableRollover(ITranche trancheIn, IERC20Upgradeable tokenOut) external returns (bool);

    // @notice The strategy contract with the fee computation logic.
    // @return Address of the strategy contract.
    function feeStrategy() external view returns (IFeeStrategy);

    // @notice The ERC-20 contract which holds perp balances.
    // @return Address of the token.
    function erc20() external view returns (IERC20Upgradeable);

    // @notice The contract where the protocol holds funds which back the perp token supply.
    // @return Address of the reserve.
    function reserve() external view returns (address);

    // @notice The address which holds any revenue extracted by protocol.
    // @return Address of the fee collector.
    function feeCollector() external view returns (address);

    // @notice The fee token currently used to receive fees in.
    // @return Address of the fee token.
    function feeToken() external view returns (IERC20Upgradeable);

    // @notice Total count of tokens held in the reserve.
    function getReserveCount() external returns (uint256);

    // @notice The token address from the reserve list by index.
    // @param index The index of a token.
    function getReserveAt(uint256 index) external returns (IERC20Upgradeable);

    // @notice Checks if the given token is part of the reserve.
    // @param token The address of a token to check.
    function inReserve(IERC20Upgradeable token) external returns (bool);

    // @notice Fetches the reserve's tranche token balance.
    // @param tranche The address of the tranche token held by the reserve.
    function getReserveTrancheBalance(IERC20Upgradeable tranche) external returns (uint256);

    // @notice Computes the price of each perp token, i.e) reserve value / total supply.
    function getPrice() external returns (uint256);

    // @notice Fetches the list of reserve tokens which are up for rollover.
    function getReserveTokensUpForRollover() external returns (IERC20Upgradeable[] memory);

    // @notice Computes the amount of perp tokens minted when `trancheInAmt` `trancheIn` tokens
    //         are deposited into the system.
    // @param trancheIn The tranche token deposited.
    // @param trancheInAmt The amount of tranche tokens deposited.
    // @return The amount of perp tokens to be minted.
    function computeMintAmt(ITranche trancheIn, uint256 trancheInAmt) external returns (uint256);

    // @notice Computes the amount reserve tokens redeemed when burning given number of perp tokens.
    // @param perpAmtBurnt The amount of perp tokens to be burnt.
    // @return tokensOut The list of reserve tokens redeemed.
    // @return tokenOutAmts The list of reserve token amounts redeemed.
    function computeRedemptionAmts(uint256 perpAmtBurnt)
        external
        returns (IERC20Upgradeable[] memory tokensOut, uint256[] memory tokenOutAmts);

    struct RolloverPreview {
        // @notice The perp denominated value of tokens rolled over.
        uint256 perpRolloverAmt;
        // @notice The amount of tokens to be withdrawn.
        uint256 tokenOutAmt;
        // @notice The tranche denominated amount of tokens to be withdrawn.
        // @dev tokenOutAmt and trancheOutAmt can only be different values
        //      in the case of rolling over the mature tranche.
        uint256 trancheOutAmt;
        // @notice The amount of trancheIn tokens used in the rollover operation.
        uint256 trancheInAmt;
        // @notice The difference between the requested trancheIn amount and the amount used for the rollover.
        uint256 remainingTrancheInAmt;
    }

    // @notice Computes the amount reserve tokens that can be swapped out for the given number
    //         of `trancheIn` tokens.
    // @param trancheIn The tranche token deposited.
    // @param tokenOut The reserve token to be withdrawn.
    // @param trancheInAmtRequested The maximum amount of trancheIn tokens deposited.
    // @param maxTokenOutAmtCovered The reserve token balance available for rollover.
    // @return r The rollover amounts in various denominations.
    function computeRolloverAmt(
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmtRequested,
        uint256 maxTokenOutAmtCovered
    ) external returns (RolloverPreview memory);

    // @notice The yield to be applied given the reserve token.
    // @param token The address of the reserve token.
    // @return The yield applied.
    function computeYield(IERC20Upgradeable token) external view returns (uint256);

    // @notice The price of the given reserve token.
    // @param token The address of the reserve token.
    // @return The computed price.
    function computePrice(IERC20Upgradeable token) external view returns (uint256);

    // @notice Updates time dependent storage state.
    function updateState() external;
}
