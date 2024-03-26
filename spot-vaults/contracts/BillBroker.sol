// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

// TODO: remove me!
import "hardhat/console.sol";

/**
 *  @title BillBroker
 *
 *  @notice The `BillBroker` contract (inspired by bill brokers in LombardSt) acts as an intermediary between parties who want to borrow and lend.
 *
 *          `BillBroker` LPs deposit equal value perps and dollars as available liquidity into the contract.
 *          Any user can now sell/buy perps (swap) from the bill broker for dollars, at a "fair" exchange rate determined by the contract.
 *
 *          Borrowing/Lending flow:
 *          Borrowers who want to borrower dollars against their collateral, tranche their collateral, mint perps and sell it for dollars to the bill broker.
 *          When they want to close out their position they can buy back perps from the bill broker for dollars, and redeem their tranches for the collateral.
 *
 *          The bill broker aggressively discounts the value of perps swapped-in based on it's "credit-quality";
 *          (in the case of perps, its measured simply as function of perp's subscription state of the system which ensures that perp is backed by healthy tranches).
 *
 *          The contract charges a fee for swap operations. The fee is a function of available liquidity held in the contract.
 *
 *
 */
contract BillBroker {
    IERC20Upgradeable public perp;
    IERC20Upgradeable public usd;

    uint8 public perpDecimals;
    uint8 public usdDecimals;

    IBillBrokerOracle public oracle;

    uint256 minUSDLiquidityAmt;
    uint256 minDiscountFactor;

    SystemFees public fees;

    Range public arHardBound;
    Range public arSoftBound;

    uint256 private constant DECIMALS = 18;
    uint256 private constant ONE = (10 ** DECIMALS);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Contract initializer.
    function init(IERC20Upgradeable perp_, IERC20Upgradeable usd_, IBillBrokerOracle oracle_) public initializer {
        perp = perp_;
        usd = usd_;

        perpDecimals = perp_.decimals();
        usdDecimals = usd_.decimals();

        updateOracle(oracle_);

        minUSDLiquidityAmt = 0;
        minDiscountFactor = ONE / 3; // 0.33, i.e) A minimum discount factor of 33% or a maximum discount of 66%

        arHardBound = Range({
            lower: ((ONE * 3) / 4), // 0.75
            upper: ((ONE * 5) / 4) // 1.25
        });

        arSoftBound = Range({
            lower: ((ONE * 9) / 10), // 0.9
            upper: ((ONE * 11) / 10) // 1.1
        });

        updateFees(
            SystemFees({
                perpToUSDSwapFeePercs: Range({ lower: ONE, upper: ONE }),
                usdToPerpSwapFeePercs: Range({ lower: ONE, upper: ONE }),
                burnFeePerc: 0,
                protocolSwapSharePerc: 0
            })
        );
    }

    function deposit(uint256 usdAmtAvailable, uint256 perpAmtAvailable) external returns (uint256) {
        uint256 usdReserveBal_ = usdReserveBal();
        uint256 perpReserveBal_ = perpReserveBal();

        (uint256 usdAmtIn, uint256 perpAmtIn, uint256 mintAmt) = _computeDepositAndMintAmt(
            usdAmtAvailable,
            perpAmtAvailable,
            usdReserveBal_,
            perpReserveBal_
        );

        // Transfer perp and usd tokens from the user
        usd.safeTransferFrom(msg.sender, address(this), usdAmtIn);
        perp.safeTransferFrom(msg.sender, address(this), perpAmtIn);

        // mint LP tokens
        _mint(_msgSender(), mintAmt);
        return mintAmt;
    }

    function depositUSD(uint256 usdAmtIn) external returns (uint256) {
        uint256 usdReserveBal_ = usdReserveBal();
        uint256 perpReserveBal_ = perpReserveBal();
        uint256 usdPrice = getUSDPrice();
        uint256 perpPrice = getPerpPrice();

        uint256 arPre = computeAssetRatio(usdReserveBal_, perpReserveBal_, usdPrice, perpPrice);
        uint256 arPost = computeAssetRatio(usdReserveBal_ + usdAmtIn, perpReserveBal_, usdPrice, perpPrice);
        if (arPost > ONE) {
            revert UnacceptableDeposit();
        }

        // deposit logic
    }

    function depositPerps(uint256 perpAmtIn) external returns (uint256) {
        uint256 usdReserveBal_ = usdReserveBal();
        uint256 perpReserveBal_ = perpReserveBal();
        uint256 usdPrice = getUSDPrice();
        uint256 perpPrice = getPerpPrice();

        uint256 arPre = computeAssetRatio(usdReserveBal_, perpReserveBal_, usdPrice, perpPrice);
        uint256 arPost = computeAssetRatio(usdReserveBal_, perpReserveBal_ + perpAmtIn, usdPrice, perpPrice);
        if (arPost < ONE) {
            revert UnacceptableDeposit();
        }

        (perpAmtIn * perpPrice) * ONE / getTVL()
        // deposit logic
    }

    function redeem(uint256 notes) external returns (uint256, uint256) {
        if (notes <= 0) {
            return (0, 0);
        }

        uint256 noteSupply = totalSupply();
        uint256 usdAmtOut = notes.mulDiv(usdReserveBal(), noteSupply);
        uint256 perpAmtOut = notes.mulDiv(perpReserveBal(), noteSupply);

        // withhold fees
        usdAmtOut -= usdAmtOut.mulDiv(fees.burnFeePerc, ONE, MathUpgradable.Rounding.Up);
        perpAmtOut -= perpAmtOut.mulDiv(fees.burnFeePerc, ONE, MathUpgradable.Rounding.Up);
        
        // burn notes
        _burn(_msgSender(), notes);

        // return funds
        usd.safeTransfer(_msgSender(), usdAmtOut);
        perp.safeTransfer(_msgSender(), perpAmtOut);
        return (usdAmtOut, perpAmtOut);
    }

    // increases ar
    function swapPerpsForUSD(uint256 perpAmtIn) external returns (uint256) {
        // check if swaps are open!

        // Transfer perp tokens from user
        perp.safeTransferFrom(msg.sender, address(this), perpAmtIn);

        // compute USD amount out
        uint256 usdReserveBal_ = usdReserveBal();
        uint256 perpReserveBal_ = perpReserveBal();
        uint256 usdPrice = getUSDPrice();
        uint256 perpPrice = getPerpPrice();
        perpPrice -= perpPrice.mulDiv(discountFactor(), ONE, MathUpgradable.Rounding.Up); // apply discount
        uint256 usdAmtOut = perpAmtIn.mulDiv(perpPrice, usdPrice).mulDiv(10 ** usdDecimals, 10 ** perpDecimals);

        // compute fees
        uint256 arPre = computeAssetRatio(usdReserveBal_, perpReserveBal_, usdPrice, perpPrice);
        uint256 arPost = computeAssetRatio(
            usdReserveBal_ - usdAmtOut,
            perpReserveBal_ + perpAmtIn,
            usdPrice,
            perpPrice
        );
        (uint256 lpFeePerc, uint256 protocolFeePerc) = computePerpToUSDSwapFeePercs(arPre, arPost);
        if (arPost > arHardBound.upper) {
            revert UnacceptableSwap();
        }

        // settle protocol fee
        if (protocolFeePerc > 0) {
            underlying.safeTransfer(onwer(), usdAmtOut.mulDiv(protocolFeePerc, ONE, MathUpgradable.Rounding.Up));
        }

        // withhold fees and transfer remaining out
        usdAmtOut -= usdAmtOut.mulDiv(lpFeePerc + protocolFeePerc, ONE, MathUpgradable.Rounding.Up);
        usd.safeTransfer(msg.sender, usdAmtOut);
        return usdAmtOut;
    }

    // decreases ar
    function swapUSDForPerps(uint256 usdAmtIn) external returns (uint256) {
        // check if swaps are open!

        // Transfer usd tokens from user
        usd.safeTransferFrom(msg.sender, address(this), usdAmtIn);

        // compute perp amount out
        uint256 usdReserveBal_ = usdReserveBal();
        uint256 perpReserveBal_ = perpReserveBal();
        uint256 usdPrice = getUSDPrice();
        uint256 perpPrice = getPerpPrice();
        uint256 perpAmtOut = usdAmtIn.mulDiv(usdPrice, perpPrice).mulDiv(10 ** perpDecimals, 10 ** usdDecimals);

        // compute fees
        uint256 arPre = computeAssetRatio(usdReserveBal_, perpReserveBal_, usdPrice, perpPrice);
        uint256 arPost = computeAssetRatio(
            usdReserveBal_ + usdAmtIn,
            perpReserveBal_ - perpAmtOut,
            usdPrice,
            perpPrice
        );
        (uint256 lpFeePerc, uint256 protocolFeePerc) = computeUSDToPerpSwapFeePercs(arPre, arPost);
        if (arPost < arHardBound.lower) {
            revert UnacceptableSwap();
        }

        // settle protocol fee
        if (protocolFeePerc > 0) {
            perp.safeTransfer(owner(), perpAmtOut.mulDiv(protocolFeePerc, ONE, MathUpgradable.Rounding.Up));
        }

        // withhold fees and transfer remaining out
        perpAmtOut -= perpAmtOut.mulDiv(lpFeePerc + protocolFeePerc, ONE, MathUpgradable.Rounding.Up);
        perp.safeTransfer(msg.sender, perpAmtOut);
        return perpAmtOut;
    }

    // deposit, redeem()
    // single sided deposit

    // ar = 1, balance
    // ar < 1 more perps, less dollars
    // ar > 1 less perps, more dollars
    function assetRatio() public returns (uint256) {
        return computeAssetRatio(usdReserveBal(), perpReserveBal(), getUSDPrice(), getPerpPrice());
    }

    function getTVL() public returns (uint256) {
        return (getUSDValue(usdReserveBal()) + getPerpValue(perpReserveBal()));
    }

    function getUSDValue(uint256 usdAmt) public returns (uint256) {
        return usdAmt.mulDiv(getUSDPrice(), ONE).mulDiv(ONE, 10 ** usdDecimals);
    }

    function getPerpValue(uint256 perpAmt) public returns (uint256) {
        return perpAmt.mulDiv(getPerpPrice(), ONE).mulDiv(ONE, 10 ** perpDecimals);
    }

    function getUSDPrice() public returns (uint256) {
        (uint256 p, bool v) = oracle.getUSDPrice();
        if (!v) {
            revert InvalidPrice();
        }
        return p;
    }

    function getPerpPrice() public returns (uint256) {
        (uint256 p, bool v) = oracle.getUnderlyingTargetPrice();
        if (!v) {
            revert InvalidPrice();
        }
        return p.mulDiv(perp.getTVL(), perp.totalSupply());
    }

    function computeAssetRatio(
        uint256 usdReserveBal,
        uint256 perpReserveBal,
        uint256 usdPrice,
        uint256 perpPrice
    ) public view returns (uint256) {
        return
            usdPrice.mulDiv(usdReserveBal, 10 ** usdDecimals).mulDiv(
                ONE,
                perpPrice.mulDiv(perpReserveBal, 10 ** perpDecimals)
            );
    }

    function discountFactor() public view returns (uint256) {
        IBalancer balancer = perp.balancer();
        uint256 perpDR = balancer.deviationRatio().mulDiv(ONE, 10 ** balancer.decimals());
        // If perp is over-subscribed, no discount is applied.
        if (perpDR >= ONE) {
            return ONE;
        }
        // If not we compute the discount rate based on a linear function.
        return (ONE - (ONE - perpDR).mulDiv(ONE - minDiscountFactor, ONE));
    }

    function usdReserveBal() public view returns (uint256) {
        return usd.balanceOf(address(this));
    }

    function perpReserveBal() public view returns (uint256) {
        return perp.balanceOf(address(this));
    }

    // increases ar
    function computePerpToUSDSwapFeePercs(uint256 arPre, uint256 arPost) public view returns (uint256, uint256) {
        uint256 swapFeePercs = fee.perpToUSDSwapFeePercs;
        uint256 totalSwapFeePerc = _computeFeePerc(
            LinearFn({ x1: 0, y1: swapFeePercs.lower, x2: ONE, y2: swapFeePercs.lower }),
            LinearFn({
                x1: arSoftBound.upper,
                y1: swapFeePercs.lower,
                x2: arHardBound.upper,
                y2: fees.swapFeePercs.upper
            }),
            arPre,
            arPost,
            arSoftBound.upper
        );
        uint256 protocolSwapFeePerc = totalSwapFeePerc.mulDiv(fees.protocolSwapSharePerc, ONE);
        return (totalSwapFeePerc - protocolSwapFeePerc, protocolSwapFeePerc);
    }

    // reduces ar
    function computeUSDToPerpSwapFeePercs(
        uint256 arPre,
        uint256 arPost
    ) public view override returns (uint256, uint256) {
        uint256 swapFeePercs = fee.usdToPerpSwapFeePercs;
        uint256 totalSwapFeePerc = _computeFeePerc(
            LinearFn({ x1: arHardBound.lower, y1: swapFeePercs.upper, x2: arSoftBound.lower, y2: swapFeePercs.lower }),
            LinearFn({ x1: 0, y1: swapFeePercs.lower, x2: ONE, y2: swapFeePercs.lower }),
            arPost,
            arPre,
            arSoftBound.lower
        );
        uint256 protocolSwapFeePerc = totalSwapFeePerc.mulDiv(fees.protocolSwapSharePerc, ONE);
        return (totalSwapFeePerc - protocolSwapFeePerc, protocolSwapFeePerc);
    }

    /// @dev The function assumes the fee curve is defined a pair-wise linear function which merge at the cutoff point.
    ///      The swap fee is computed as area under the fee curve between {arL,arU}.
    function _computeFeePerc(
        LinearFn memory fn1,
        LinearFn memory fn2,
        uint256 arL,
        uint256 arU,
        uint256 cutoff
    ) private pure returns (uint256) {
        if (arU <= cutoff) {
            return _auc(fn1, arL, arU);
        } else if (arL > cutoff) {
            return _auc(fn2, arL, arU);
        } else {
            return (_auc(fn1, arL, cutoff).mulDiv(cutoff - arL, arU - arL) +
                _auc(fn2, cutoff, arU).mulDiv(arU - cutoff, arU - arL));
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
}
