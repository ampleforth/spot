// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { SignedMath } from "@openzeppelin/contracts/utils/math/SignedMath.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IFeeStrategy } from "../_interfaces/IFeeStrategy.sol";

/*
 *  @title BasicFeeStrategy
 *
 *  @notice Basic fee strategy using fixed percentage of perpetual ERC-20 token amounts.
 *
 *  @dev If mint or burn fee is negative, the other must overcompensate in the positive direction.
 *       Otherwise, user could extract from fee reserve by constant mint/burn transactions.
 */
contract BasicFeeStrategy is IFeeStrategy {
    using SignedMath for int256;
    using SafeCast for uint256;

    uint256 public constant PCT_DECIMALS = 6;

    // @notice Address of the parent perpetual ERC-20 token contract which uses this strategy.
    IERC20 public immutable perp;

    /// @inheritdoc IFeeStrategy
    IERC20 public immutable override feeToken;

    // @notice Fixed percentage of the mint amount to be used as fee.
    int256 public immutable mintFeePct;

    // @notice Fixed percentage of the burn amount to be used as fee.
    int256 public immutable burnFeePct;

    // @notice Fixed percentage of the reserve's balance to be used as the reward,
    //         for rolling over the entire supply of the perp tokens.
    int256 public immutable rolloverRewardPct;

    // @dev Constructor for the fee strategy.
    // @param perp_ Address of the perpetual ERC-20 token contract.
    // @param feeToken_ Address of the fee ERC-20 token contract.
    // @param mintFeePct_ Mint fee percentage.
    // @param burnFeePct_ Burn fee percentage.
    // @param rolloverRewardPct_ Rollover reward percentage.
    constructor(
        IERC20 perp_,
        IERC20 feeToken_,
        int256 mintFeePct_,
        int256 burnFeePct_,
        int256 rolloverRewardPct_
    ) public {
        perp = perp_;
        feeToken = feeToken_;
        mintFeePct = mintFeePct_;
        burnFeePct = burnFeePct_;
        rolloverRewardPct = rolloverRewardPct_;
    }

    /// @inheritdoc IFeeStrategy
    function computeMintFee(uint256 mintAmt) external view override returns (int256) {
        return (mintAmt.toInt256() * mintFeePct) / (10**PCT_DECIMALS).toInt256();
    }

    /// @inheritdoc IFeeStrategy
    function computeBurnFee(uint256 burnAmt) external view override returns (int256) {
        return (burnAmt.toInt256() * burnFeePct) / (10**PCT_DECIMALS).toInt256();
    }

    /// @inheritdoc IFeeStrategy
    function computeRolloverReward(uint256 rolloverAmt) external view override returns (int256) {
        uint256 rewardShare = (feeToken.balanceOf(address(perp)) * rolloverAmt) / perp.totalSupply();
        uint256 absoluteReward = (rolloverRewardPct.abs() * rewardShare) / (10**PCT_DECIMALS);
        return rolloverRewardPct >= 0 ? absoluteReward.toInt256() : -absoluteReward.toInt256();
    }
}
