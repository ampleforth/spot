// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { IERC20MetadataUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";
import { IERC20Upgradeable, IPerpetualTranche, IBondIssuer, IBalancer, IBondController, ITranche } from "./_interfaces/IPerpetualTranche.sol";
import { IRolloverVault } from "./_interfaces/IRolloverVault.sol";
import { TokenAmount, RolloverData } from "./_interfaces/CommonTypes.sol";
import { UnauthorizedCall, UnauthorizedTransferOut, UnexpectedDecimals, UnexpectedAsset, UnacceptableParams, UnacceptableDeposit, UnacceptableRollover, ExceededMaxMintPerTranche, ReserveCountOverLimit } from "./_interfaces/ProtocolErrors.sol";

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";
import { ERC20BurnableUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { BondHelpers } from "./_utils/BondHelpers.sol";
import { TrancheHelpers } from "./_utils/TrancheHelpers.sol";

// Un-comment this line to use console.log
// import "hardhat/console.sol";

contract BillBroker {

    IERC20Upgradeable public perp;
    IERC20Upgradeable public underlying;
    IERC20Upgradeable public usd;

    uint256 private constant ORACLE_DECIMALS = 18;
    uint256 private constant UNIT_PRICE = (10 ** ORACLE_DECIMALS);

    // Simple on-chain contracts to discount bills based on a pre-defined strategy
    // LPs can provide perp and dollar tokens to fund the bill broker
    // Allows single sided deposits?

    // Bill broker buys perps for dollars from the market after applying a discount on the fair value
    // The bill broker sells perps for dollars

    // swapping is paused on various conditions.
    // price of dollar coin deviates, 
    // spot price of AMPL is too high (buy spot but don't sell)
    // or too low (sell spot but don't buy)

    // TODO: Increase the time to activity to 1 week,
    // make it active for 90 days
    // (underlyingPriceTarget, targetDataValid) = IPolicy(underlying.monetaryPolicy()).cpiOracle()
    // perpPrice = underlyingPriceTarget.mulDiv(perp.getTVL(), perp.totalSupply()) 

    function getTVL() public view returns(uint256) {
        uint256 v1 = perp.balanceOf(address(this)).mulDiv(
            perpPrice,
            UNIT_PRICE,
            MathUpgradable.Rounding.Up
        );        
        uint256 v2 = usd.balanceOf(address(this)).mulDiv(
            oracle.getUSDPrice(),
            UNIT_PRICE,
            MathUpgradable.Rounding.Up
        );
        return (v1 + v2);
    }

    /// @dev The function assumes the fee curve is defined as DR with 2 linear parts which transition at DR = 1.
    ///      The swap fee is computed as area under the curve between {drL,drU}.
    function _computeFeePerc(
        LinearFn memory fn1,
        LinearFn memory fn2,
        uint256 drL,
        uint256 drU
    ) private pure returns (uint256) {
        if (drU <= ONE) {
            return _auc(fn1, drL, drU);
        } else if (drL > ONE) {
            return _auc(fn2, drL, drU);
        } else {
            return (_auc(fn1, drL, ONE).mulDiv(ONE - drL, drU - drL) +
                _auc(fn2, ONE, drU).mulDiv(drU - ONE, drU - drL));
        }
    }

    /// @dev Given a linear function defined by points (x1,y1) (x2,y2),
    ///      we compute the are under the curve between (xL, xU) assuming xL <= xU.
    function _auc(LinearFn memory fn, uint256 xL, uint256 xU) private pure returns (uint256) {
        // m = dlY/dlX
        // c = y2 - m . x2
        // Integral m . x + c => m . x^2 / 2 + c
        // Area between [xL, xU] => (m . (xU^2 - xL^2) / 2 + c . (xU - xL)) / (xU - xL)
        //                       => m.(xU+xL)/2 + c
        int256 dlY = fn.y2.toInt256() - fn.y1.toInt256();
        int256 dlX = fn.x2.toInt256() - fn.x1.toInt256();
        int256 c = fn.y2.toInt256() - ((fn.x2.toInt256() * dlY) / dlX);
        int256 area = ((xL + xU).toInt256() * dlY) / (2 * dlX) + c;
        return area.abs();
    }

    struct LinearFn {
        uint256 x1;
        uint256 y1;
        uint256 x2;
        uint256 y2;
    }
}
