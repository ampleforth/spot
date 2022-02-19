//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IFeeStrategy } from "./interfaces/IFeeStrategy.sol";

contract FeeStrategy is Ownable, IFeeStrategy {
    uint256 public constant PCT_DECIMALS = 6;

    // todo: add setters
    //--- fee strategy parameters
    // IERC20 public override feeToken;

    // Special note: If mint or burn fee is negative, the other must overcompensate in the positive direction.
    // Otherwise, user could extract from fee reserve by constant mint/burn transactions.
    int256 public mintFeePct;
    int256 public burnFeePct;
    int256 public rolloverRewardPct;

    // expected mint token to be have the same number of decimals as the fee token
    function computeMintFee(uint256 mintAmt) external view override returns (int256) {
       # TODO use https://github.com/OpenZeppelin/openzeppelin-contracts/blob/master/contracts/utils/math/SafeCast.sol
       # Todo: check all math for overflow reverts 
        return (int256(mintAmt) * mintFeePct) / int256(10**PCT_DECIMALS);
    }

    function computeBurnFee(uint256 burnAmt) external view override returns (int256) {
        return (int256(burnAmt) * burnFeePct) / int256(10**PCT_DECIMALS);
    }
}
