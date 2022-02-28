// SPDX-License-Identifier: GPL-3.0-or-later

// solhint-disable-next-line compiler-version
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IBondIssuer } from "./IBondIssuer.sol";
import { IFeeStrategy } from "./IFeeStrategy.sol";
import { IPricingStrategy } from "./IPricingStrategy.sol";
import { IBondController } from "./button-wood/IBondController.sol";
import { ITranche } from "./button-wood/ITranche.sol";

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
    uint256 burntTrancheCount;
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

    // @notice Redeem perp tokens for tranche tokens.
    // @param requestedAmount The amount of perp tokens requested to be burnt.
    // @return The actual amount of perp tokens burnt, fees and the list of tranches and amounts redeemed.
    function redeem(uint256 requestedAmount) external returns (BurnData memory);

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

    // @notice Burn perp tokens without redemption.
    // @param amount Amount of perp tokens to be burnt.
    // @return True if burn is successful.
    function burn(uint256 amount) external returns (bool);

    // @notice Push a new active bond into the queue.
    // @param bond The bond to be pushed into the queue.
    // @return True if successful.
    function advanceMintBond(IBondController bond) external returns (bool);

    // @notice Iteratively dequeues bonds till the tail of the queue has an active bond.
    // @return True if successful.
    function advanceBurnBond() external returns (bool);

    // @notice The fee token currently used to pay fees or get rewards in.
    function feeToken() external view returns (IERC20);

    // @notice The yield to be applied given the tranche's parent bond class and it's seniority.
    // @param hash The bond class.
    // @param seniorityIndex The tranche's seniority in the given bond.
    function getTrancheYield(bytes32 hash, uint256 seniorityIndex) external view returns (uint256);
}
