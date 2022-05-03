// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";
import { SignedMathHelpers } from "../_utils/SignedMathHelpers.sol";

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IFeeStrategy } from "../_interfaces/IFeeStrategy.sol";
import { IPerpetualTranche } from "../_interfaces/IPerpetualTranche.sol";

/*
 *  @title BasicFeeStrategy
 *
 *  @notice Basic fee strategy using fixed percentage of perpetual ERC-20 token amounts.
 *
 *  @dev IMPORTANT: If mint or burn fee is negative, the other must overcompensate in the positive direction.
 *       Otherwise, user could extract from the fee collector by constant mint/burn transactions.
 */
contract BasicFeeStrategy is IFeeStrategy {
    using SignedMathUpgradeable for int256;
    using SignedMathHelpers for int256;
    using SafeCastUpgradeable for uint256;

    // @dev {10 ** PCT_DECIMALS} is considered 100%
    uint256 public constant PCT_DECIMALS = 6;

    // @notice Address of the parent perpetual ERC-20 token contract which uses this strategy.
    IPerpetualTranche public immutable perp;

    /// @inheritdoc IFeeStrategy
    IERC20Upgradeable public immutable override feeToken;

    // @notice Fixed percentage of the mint amount to be used as fee.
    int256 public immutable mintFeePct;

    // @notice Fixed percentage of the burn amount to be used as fee.
    int256 public immutable burnFeePct;

    // @notice Fixed percentage of the fee collector's balance to be used as the fee,
    //         for rolling over the entire supply of the perp tokens.
    // @dev NOTE: This is different from the mint/burn fees which are just a percentage of
    //      the perp token amounts.
    int256 public immutable rolloverFeePct;

    // @dev Constructor for the fee strategy.
    // @param perp_ Address of the perpetual ERC-20 token contract.
    // @param feeToken_ Address of the fee ERC-20 token contract.
    // @param mintFeePct_ Mint fee percentage.
    // @param burnFeePct_ Burn fee percentage.
    // @param rolloverFeePct_ Rollover fee percentage.
    constructor(
        IPerpetualTranche perp_,
        IERC20Upgradeable feeToken_,
        int256 mintFeePct_,
        int256 burnFeePct_,
        int256 rolloverFeePct_
    ) {
        perp = perp_;
        feeToken = feeToken_;
        mintFeePct = mintFeePct_;
        burnFeePct = burnFeePct_;
        rolloverFeePct = rolloverFeePct_;
    }

    /// @inheritdoc IFeeStrategy
    function computeMintFee(uint256 mintAmt) external view override returns (int256) {
        uint256 absoluteFee = (mintFeePct.abs() * mintAmt) / (10**PCT_DECIMALS);
        return mintFeePct.sign() * absoluteFee.toInt256();
    }

    /// @inheritdoc IFeeStrategy
    function computeBurnFee(uint256 burnAmt) external view override returns (int256) {
        uint256 absoluteFee = (burnFeePct.abs() * burnAmt) / (10**PCT_DECIMALS);
        return burnFeePct.sign() * absoluteFee.toInt256();
    }

    /// @inheritdoc IFeeStrategy
    function computeRolloverFee(uint256 rolloverAmt) external view override returns (int256) {
        uint256 share = (feeToken.balanceOf(perp.feeCollector()) * rolloverAmt) / perp.totalSupply();
        uint256 absoluteFee = (rolloverFeePct.abs() * share) / (10**PCT_DECIMALS);
        return rolloverFeePct.sign() * absoluteFee.toInt256();
    }
}
