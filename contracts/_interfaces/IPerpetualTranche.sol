// SPDX-License-Identifier: GPL-3.0-or-later

// solhint-disable-next-line compiler-version
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IBondIssuer } from "./IBondIssuer.sol";
import { IFeeStrategy } from "./IFeeStrategy.sol";
import { IPricingStrategy } from "./IPricingStrategy.sol";
import { IBondController } from "./buttonwood/IBondController.sol";
import { ITranche } from "./buttonwood/ITranche.sol";

interface IPerpetualTranche is IERC20 {
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

    // @notice Event emitted when maturity tolerance parameters are updated.
    // @param min The minimum maturity time.
    // @param max The maximum maturity time.
    event UpdatedTolerableTrancheMaturiy(uint256 min, uint256 max);

    // @notice Event emitted when the defined tranche yields are updated.
    // @param hash The tranche class hash.
    // @param yield The yield factor for any tranche belonging to that class.
    event UpdatedDefinedTrancheYields(bytes32 hash, uint256 yield);

    // @notice Event emitted when the applied yield for a given tranche is set.
    // @param tranche The address of the tranche token.
    // @param yield The yield factor applied.
    event TrancheYieldApplied(ITranche tranche, uint256 yield);

    // @notice Event emitted when a new tranche is added to the queue head.
    // @param strategy Address of the tranche added to the queue.
    event TrancheEnqueued(ITranche tranche);

    // @notice Event emitted when a tranche is removed from the queue tail.
    // @param strategy Address of the tranche removed from the queue.
    event TrancheDequeued(ITranche tranche);

    // @notice Event emitted the reserve's current token balance is recorded after change.
    // @param token Address of token.
    // @param balance The recorded ERC-20 balance of the token held by the reserve.
    event ReserveSynced(IERC20 token, uint256 balance);

    //--------------------------------------------------------------------------
    // Methods

    // @notice Deposits tranche tokens into the system and mint perp tokens.
    // @param trancheIn The address of the tranche token to be deposited.
    // @param trancheInAmt The amount of tranche tokens deposited.
    // @return mintAmt The amount of perp tokens minted.
    // @return fee The fee charged to mint perp tokens.
    function deposit(ITranche trancheIn, uint256 trancheInAmt) external returns (uint256 mintAmt, int256 mintFee);

    // @notice Redeem tranche tokens by burning perp tokens.
    // @param trancheOut The tranche token to be redeemed.
    // @param requestedAmount The amount of perp tokens requested to be burnt.
    // @return The actual amount of perp tokens burnt, fees.
    function redeem(ITranche trancheOut, uint256 requestedAmount) external returns (uint256 burnAmt, int256 burnFee);

    // @notice Rotates newer tranches in for older tranches.
    // @param trancheIn The tranche token deposited.
    // @param trancheOut The tranche token to be redeemed.
    // @param trancheInAmt The amount of trancheIn tokens deposited.
    // @return The amount of perp tokens rolled over, trancheOut tokens redeemed and fee charged for rolling over.
    function rollover(
        ITranche trancheIn,
        ITranche trancheOut,
        uint256 trancheInAmt
    ) external returns (uint256 trancheOutAmt, int256 fee);

    // @notice Burn perp tokens without redemption.
    // @param amount Amount of perp tokens to be burnt.
    // @return True if burn is successful.
    function burn(uint256 amount) external returns (bool);

    // @notice The parent bond whose tranches are currently accepted to mint perp tokens.
    // @return Address of the minting bond.
    function getMintingBond() external returns (IBondController);

    // @notice Tranche up for redemption next.
    // @return Address of the tranche token.
    function getBurningTranche() external returns (ITranche);

    // @notice The strategy contract with the fee computation logic.
    // @return Address of the strategy contract.
    function feeStrategy() external view returns (IFeeStrategy);

    // @notice The contract where the protocol holds funds which back the perp token supply.
    // @return Address of the reserve.
    function reserve() external view returns (address);

    // @notice The contract where the protocol holds the cash from fees.
    // @return Address of the fee collector.
    function feeCollector() external view returns (address);

    // @notice The fee token currently used to receive fees in.
    // @return Address of the fee token.
    function feeToken() external view returns (IERC20);

    // @notice The yield to be applied given the tranche.
    // @param tranche The address of the tranche token.
    // @return The yield applied.
    function trancheYield(ITranche tranche) external view returns (uint256);

    // @notice The computes the class hash of a given tranche.
    // @dev This is used to identify different tranche tokens instances of the same class.
    // @param tranche The address of the tranche token.
    // @return The class hash.
    function trancheClass(ITranche t) external view returns (bytes32);

    // @notice The price of the given tranche.
    // @param tranche The address of the tranche token.
    // @return The computed price.
    function tranchePrice(ITranche tranche) external view returns (uint256);

    // @notice Computes the amount of perp token amount that can be exchanged for given tranche and amount.
    // @param tranche The address of the tranche token.
    // @param trancheAmt The amount of tranche tokens.
    // @return The perp token amount.
    function tranchesToPerps(ITranche tranche, uint256 trancheAmt) external view returns (uint256);

    // @notice Computes the amount of tranche tokens amount that can be exchanged for given perp token amount.
    // @param tranche The address of the tranche token.
    // @param trancheAmt The amount of perp tokens.
    // @return The tranche token amount.
    function perpsToTranches(ITranche tranche, uint256 amount) external view returns (uint256);

    // @notice Computes the maximum amount of tranche tokens amount that
    //         can be exchanged for the requested perp token amount covered by the systems tranche balance.
    //         If the system doesn't have enough tranche tokens to cover the exchange,
    //         it computes the remainder perp tokens which cannot be exchanged.
    // @param tranche The address of the tranche token.
    // @param requestedAmount The amount of perp tokens to exchange.
    // @return trancheAmtUsed The tranche tokens used for the exchange.
    // @return remainder The number of perp tokens which cannot be exchanged.
    function perpsToCoveredTranches(ITranche tranche, uint256 requestedAmount)
        external
        view
        returns (uint256 trancheAmtUsed, uint256 remainder);

    // @notice Total count of tokens in the redemption queue.
    function redemptionQueueCount() external view returns (uint256);

    // @notice The token address from the redemption queue by index.
    // @param index The index of a token.
    function redemptionQueueAt(uint256 index) external view returns (address);

    // @notice Total count of tokens held in the reserve.
    function reserveCount() external view returns (uint256);

    // @notice The token address from the reserve list by index.
    // @param index The index of a token.
    function reserveAt(uint256 index) external view returns (address);

    // @notice Checks if the given token is part of the reserve list.
    // @param token The address of a token to check.
    function inReserve(IERC20 token) external view returns (bool);
}
