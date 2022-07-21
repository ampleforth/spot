// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.15;

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";
import { SignedMathHelpers } from "../_utils/SignedMathHelpers.sol";

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IFeeStrategy } from "../_interfaces/IFeeStrategy.sol";
import { IPerpetualTranche } from "../_interfaces/IPerpetualTranche.sol";

/// @notice Expected perc value to be less than 100 with {PERC_DECIMALS}.
/// @param perc The percentage value.
error UnacceptablePercValue(int256 perc);

/*
 *  @title BasicFeeStrategy
 *
 *  @notice Basic fee strategy using fixed percentages.
 *
 *  @dev IMPORTANT: If mint or burn fee is negative, the other must overcompensate in the positive direction.
 *       Otherwise, user could extract from the fee collector by constant mint/burn transactions.
 */
contract BasicFeeStrategy is IFeeStrategy, OwnableUpgradeable {
    using SignedMathUpgradeable for int256;
    using SignedMathHelpers for int256;
    using SafeCastUpgradeable for uint256;
    using SafeCastUpgradeable for int256;

    // @dev {10 ** PERC_DECIMALS} is considered 1%
    uint8 public constant PERC_DECIMALS = 6;
    uint256 public constant UNIT_PERC = 10**PERC_DECIMALS;
    uint256 public constant HUNDRED_PERC = 100 * UNIT_PERC;

    // @notice Address of the parent perpetual ERC-20 token contract which uses this strategy.
    IPerpetualTranche public immutable perp;

    /// @inheritdoc IFeeStrategy
    IERC20Upgradeable public override feeToken;

    // @notice Fixed percentage of the mint amount to be used as fee.
    int256 public mintFeePerc;

    // @notice Fixed percentage of the burn amount to be used as fee.
    int256 public burnFeePerc;

    // @notice Fixed percentage of the fee collector's balance to be used as the fee,
    //         for rolling over the entire supply of the perp tokens.
    // @dev NOTE: This is different from the mint/burn fees which are just a percentage of
    //      the perp token amounts.
    int256 public rolloverFeePerc;

    // @notice The percentage of the value the system retains or disburses on every rollover operation.
    // @dev Discount percentage is stored as fixed point number with {PERC_DECIMALS}.
    //      When positive, the discount percentage is a tax paid by users who rollover collateral, which over-collateralizes
    //      the system. When negative, it acts as a subsidy to incentivize rollovers by diluting perp holders.
    //      eg) If discount is 5%, user can rollover 1x worth tranches for 0.95x worth tranches from the reserve.
    //          Or if discount is -5%, user can rollover 1x worth tranches for 1.05x worth tranches from the reserve.
    int256 public rolloverDiscountPerc;

    // EVENTS

    // @notice Event emitted when the fee token is updated.
    // @param feeToken Address of the fee token contract.
    event UpdatedFeeToken(IERC20Upgradeable feeToken);

    // @notice Event emitted when the mint fee percentage is updated.
    // @param mintFeePerc Mint fee percentage.
    event UpdatedMintPerc(int256 mintFeePerc);

    // @notice Event emitted when the burn fee percentage is updated.
    // @param burnFeePerc Burn fee percentage.
    event UpdatedBurnPerc(int256 burnFeePerc);

    // @notice Event emitted when the rollover fee percentage is updated.
    // @param rolloverFeePerc Rollover fee percentage.
    event UpdatedRolloverPerc(int256 rolloverFeePerc);

    // @notice Event emitted when the rollover discount percentage is updated.
    // @param rolloverDiscountPerc The rollover discount percentage.
    event UpdatedRolloverDiscountPerc(int256 rolloverDiscountPerc);

    // @notice Contract constructor.
    // @param perp_ Address of the perpetual ERC-20 token contract.
    constructor(IPerpetualTranche perp_) {
        perp = perp_;
    }

    // @notice Contract initializer.
    // @param feeToken_ Address of the fee ERC-20 token contract.
    // @param mintFeePerc_ Mint fee percentage.
    // @param burnFeePerc_ Burn fee percentage.
    // @param rolloverFeePerc_ Rollover fee percentage.
    // @param rolloverDiscountPerc_ Rollover discount percentage.
    function init(
        IERC20Upgradeable feeToken_,
        int256 mintFeePerc_,
        int256 burnFeePerc_,
        int256 rolloverFeePerc_,
        int256 rolloverDiscountPerc_
    ) public initializer {
        __Ownable_init();

        updateFeeToken(feeToken_);
        updateMintFeePerc(mintFeePerc_);
        updateBurnFeePerc(burnFeePerc_);
        updateRolloverFeePerc(rolloverFeePerc_);
        updateRolloverDiscountPerc(rolloverDiscountPerc_);
    }

    // @notice Updates the fee token.
    // @param feeToken_ New fee token.
    function updateFeeToken(IERC20Upgradeable feeToken_) public onlyOwner {
        feeToken = feeToken_;
        emit UpdatedFeeToken(feeToken);
    }

    // @notice Updates the mint fee percentage.
    // @param mintFeePerc_ New mint fee percentage.
    function updateMintFeePerc(int256 mintFeePerc_) public onlyOwner {
        _validatePercValue(mintFeePerc_);
        mintFeePerc = mintFeePerc_;
        emit UpdatedMintPerc(mintFeePerc_);
    }

    // @notice Updates the burn fee percentage.
    // @param burnFeePerc_ New burn fee percentage.
    function updateBurnFeePerc(int256 burnFeePerc_) public onlyOwner {
        _validatePercValue(burnFeePerc_);
        burnFeePerc = burnFeePerc_;
        emit UpdatedBurnPerc(burnFeePerc_);
    }

    // @notice Updates the rollover fee percentage.
    // @param rolloverFeePerc_ New rollover fee percentage.
    function updateRolloverFeePerc(int256 rolloverFeePerc_) public onlyOwner {
        _validatePercValue(rolloverFeePerc_);
        rolloverFeePerc = rolloverFeePerc_;
        emit UpdatedRolloverPerc(rolloverFeePerc_);
    }

    // @notice Updates the rollover discount percentage parameter.
    // @param rolloverDiscountPerc_ New rollover discount percentage.
    function updateRolloverDiscountPerc(int256 rolloverDiscountPerc_) public onlyOwner {
        _validatePercValue(rolloverDiscountPerc_);
        rolloverDiscountPerc = rolloverDiscountPerc_;
        emit UpdatedRolloverDiscountPerc(rolloverDiscountPerc_);
    }

    /// @inheritdoc IFeeStrategy
    function computeMintFee(uint256 mintAmt) external view override returns (int256) {
        uint256 absoluteFee = (mintFeePerc.abs() * mintAmt) / HUNDRED_PERC;
        return mintFeePerc.sign() * absoluteFee.toInt256();
    }

    /// @inheritdoc IFeeStrategy
    function computeBurnFee(uint256 burnAmt) external view override returns (int256) {
        uint256 absoluteFee = (burnFeePerc.abs() * burnAmt) / HUNDRED_PERC;
        return burnFeePerc.sign() * absoluteFee.toInt256();
    }

    /// @inheritdoc IFeeStrategy
    function computeRolloverFee(uint256 rolloverAmt) external view override returns (int256) {
        uint256 share = (feeToken.balanceOf(perp.feeCollector()) * rolloverAmt) / perp.totalSupply();
        uint256 absoluteFee = (rolloverFeePerc.abs() * share) / HUNDRED_PERC;
        return rolloverFeePerc.sign() * absoluteFee.toInt256();
    }

    /// @inheritdoc IFeeStrategy
    function computeScaledRolloverValue(uint256 value) external view override returns (uint256) {
        return (value * (int256(HUNDRED_PERC) - rolloverDiscountPerc).toUint256()) / HUNDRED_PERC;
    }

    // @dev Ensures that the given perc value is valid.
    function _validatePercValue(int256 perc) private pure {
        if (perc > int256(HUNDRED_PERC)) {
            revert UnacceptablePercValue(perc);
        }
    }
}
