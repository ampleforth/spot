// SPDX-License-Identifier: GPL-3.0-or-later

// solhint-disable-next-line compiler-version
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IBondIssuer } from "./IBondIssuer.sol";
import { IFeeStrategy } from "./IFeeStrategy.sol";
import { IPricingStrategy } from "./IPricingStrategy.sol";
import { IBondController } from "./buttonwood/IBondController.sol";
import { ITranche } from "./buttonwood/ITranche.sol";

struct MintData {
    uint256 amount;
    int256 fee;
}

struct BurnData {
    uint256 amount;
    int256 fee;
    uint256 remainder;
    ITranche[] tranches;
    uint256[] trancheAmts;
    uint8 trancheCount;
}

struct RolloverData {
    uint256 amount;
    int256 reward;
    uint256 trancheAmt;
}

interface IPerpetualTranche is IERC20 {
    //--------------------------------------------------------------------------
    // Events

    // @notice Event emitted when the bond issuer is updated.
    // @param issuer Address of the issuer contract.
    event BondIssuerUpdated(IBondIssuer issuer);

    // @notice Event emitted when the fee strategy is updated.
    // @param strategy Address of the strategy contract.
    event FeeStrategyUpdated(IFeeStrategy strategy);

    // @notice Event emitted when the pricing strategy is updated.
    // @param strategy Address of the strategy contract.
    event PricingStrategyUpdated(IPricingStrategy strategy);

    // @notice Event emitted when maturity tolerance parameters are updated.
    // @param min The minimum maturity time.
    // @param max The maximum maturity time.
    event TolerableBondMaturiyUpdated(uint256 min, uint256 max);

    // @notice Event emitted when the tranche yields are updated.
    // @param hash The bond class hash.
    // @param yields The yeild for each tranche.
    event TrancheYieldsUpdated(bytes32 hash, uint256[] yields);

    // @notice Event emitted when a new bond is added to the queue head.
    // @param strategy Address of the bond added to the queue.
    event BondEnqueued(IBondController bond);

    // @notice Event emitted when a bond is removed from the queue tail.
    // @param strategy Address of the bond removed from the queue.
    event BondDequeued(IBondController bond);

    // @notice Event emitted the reserve's current token balance is recorded after change.
    // @param t Address of token.
    // @param balance The recorded ERC-20 balance of the token held by the reserve.
    event ReserveSynced(IERC20 t, uint256 balance);

    //--------------------------------------------------------------------------
    // Methods

    // @notice Deposit tranche tokens to mint perp tokens.
    // @param trancheIn The address of the tranche token to be deposited.
    // @param trancheInAmt The amount of tranche tokens deposited.
    // @return The amount of perp tokens minted and the fee charged.
    function deposit(ITranche trancheIn, uint256 trancheInAmt) external returns (MintData memory);

    // @notice Dry-run a deposit operation (without any token transfers).
    // @dev To be used by off-chain services through static invocation.
    // @param trancheIn The address of the tranche token to be deposited.
    // @param trancheInAmt The amount of tranche tokens deposited.
    // @return The amount of perp tokens minted and the fee charged.
    function previewDeposit(ITranche trancheIn, uint256 trancheInAmt) external returns (MintData memory);

    // @notice Redeem perp tokens for tranche tokens.
    // @param requestedAmount The amount of perp tokens requested to be burnt.
    // @return The actual amount of perp tokens burnt, fees and the list of tranches and amounts redeemed.
    function redeem(uint256 requestedAmount) external returns (BurnData memory);

    // @notice Dry-run a redemption operation (without any transfers).
    // @param requestedAmount The amount of perp tokens requested to be burnt.
    // @return The actual amount of perp tokens burnt, fees and the list of tranches and amounts redeemed.
    function previewRedeem(uint256 requestedAmount) external returns (BurnData memory);

    // @notice Redeem perp tokens for tranche tokens from icebox when the bond queue is empty.
    // @param trancheOut The tranche token to be redeemed.
    // @param requestedAmount The amount of perp tokens requested to be burnt.
    // @return The amount of perp tokens burnt, fees.
    function redeemIcebox(ITranche trancheOut, uint256 requestedAmount) external returns (BurnData memory);

    // @notice Dry-run a redemption from icebox operation (without any transfers).
    // @param trancheOut The tranche token to be redeemed.
    // @param requestedAmount The amount of perp tokens requested to be burnt.
    // @return The amount of perp tokens burnt, fees.
    function previewRedeemIcebox(ITranche trancheOut, uint256 requestedAmount) external returns (BurnData memory);

    // @notice Rotates newer tranches in for older tranches.
    // @param trancheIn The tranche token deposited.
    // @param trancheOut The tranche token to be redeemed.
    // @param trancheInAmt The amount of trancheIn tokens deposited.
    // @return The amount of perp tokens rolled over, trancheOut tokens redeemed and reward awarded for rolling over.
    function rollover(
        ITranche trancheIn,
        ITranche trancheOut,
        uint256 trancheInAmt
    ) external returns (RolloverData memory);

    // @notice Dry-run a rollover operation (without any transfers).
    // @param trancheIn The tranche token deposited.
    // @param trancheOut The tranche token to be redeemed.
    // @param trancheInAmt The amount of trancheIn tokens deposited.
    // @return The amount of perp tokens rolled over, trancheOut tokens redeemed and reward awarded for rolling over.
    function previewRollover(
        ITranche trancheIn,
        ITranche trancheOut,
        uint256 trancheInAmt
    ) external returns (RolloverData memory);

    // @notice Burn perp tokens without redemption.
    // @param amount Amount of perp tokens to be burnt.
    // @return True if burn is successful.
    function burn(uint256 amount) external returns (bool);

    // @notice Address of the parent bond whose tranches are currently accepted to mint perp tokens.
    // @return Address of the minting bond.
    function getMintingBond() external returns (IBondController);

    // @notice Address of the parent bond whose tranches are currently redeemed for burning perp tokens.
    // @return Address of the burning bond.
    function getBurningBond() external returns (IBondController);

    // @notice The address of the reserve where the protocol holds funds.
    // @return Address of the reserve.
    function reserve() external view returns (address);

    // @notice The fee token currently used to receive fees in.
    // @return Address of the fee token.
    function feeToken() external view returns (IERC20);

    // @notice The fee token currently used to pay rewards in.
    // @return Address of the reward token.
    function rewardToken() external view returns (IERC20);

    // @notice The yield to be applied given the tranche based on its bond's class and it's seniority.
    // @param t The address of the tranche token.
    // @return The yield applied.
    function trancheYield(ITranche tranche) external view returns (uint256);

    // @notice The price of the given tranche.
    // @param t The address of the tranche token.
    // @return The computed price.
    function tranchePrice(ITranche tranche) external view returns (uint256);

    // @notice Computes the amount of perp token amount that can be exchanged for given tranche and amount.
    // @param t The address of the tranche token.
    // @param trancheAmt The amount of tranche tokens.
    // @return The perp token amount.
    function tranchesToPerps(ITranche tranche, uint256 trancheAmt) external view returns (uint256);

    // @notice Computes the amount of tranche tokens amount that can be exchanged for given perp token amount.
    // @param t The address of the tranche token.
    // @param trancheAmt The amount of perp tokens.
    // @return The tranche token amount.
    function perpsToTranches(ITranche tranche, uint256 amount) external view returns (uint256);

    // @notice Number of tranche tokens held in the reserve.
    function trancheCount() external view returns (uint256);

    // @notice The tranche address from the tranche list at a given index.
    // @param i The index of the tranche list.
    function trancheAt(uint256 i) external view returns (address);
}
