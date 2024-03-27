// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { ERC20BurnableUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IERC20MetadataUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";
import { IPerpetualTranche, IBalancer } from "./_interfaces/external/IPerp.sol";
import { IBillBrokerOracle } from "./_interfaces/IBillBrokerOracle.sol";
import { ReserveState, Range, LinearFn, SystemFees } from "./_interfaces/CommonTypes.sol";
import { UnacceptableSwap, InvalidPrice, UnexpectedDecimals, InvalidPerc, UnacceptableDeposit } from "./_interfaces/ProtocolErrors.sol";

// TODO: remove me!
import "hardhat/console.sol";

/**
 *  @title BillBroker
 *
 *  @notice The `BillBroker` contract (inspired by bill brokers in LombardSt) acts as an intermediary between parties who want to borrow and lend.
 *
 *          `BillBroker` LPs deposit perps and dollars as available liquidity into the contract.
 *          Any user can now sell/buy perps (swap) from the bill broker for dollars, at a "fair" exchange rate determined by the contract.
 *
 *          The bill broker aggressively discounts the value of perps swapped-in based on it's "credit-quality";
 *          (in the case of perps, its measured simply as function of perp's subscription state of the system which ensures that perp is backed by healthy tranches).
 *
 *          The contract charges a fee for swap operations. The fee is a function of available liquidity held in the contract, and goes to the LPs.
 * 
 *          The ratio of value of dollar tokens vs perp tokens held by the contract is defined as it's `assetRatio`.
 *          The owner can define hard limits on the system's assetRatio outside which swapping is disabled.
 *
 *          Intermediating borrowing:
 *          Borrowers who want to borrower dollars against their collateral, tranche their collateral, mint perps and sell it for dollars to the bill broker.
 *          When they want to close out their position they can buy back perps from the bill broker for dollars, and redeem their tranches for the collateral.
 *          The spread is the "interest rate" paid for the loan, which goes to the bill broker LPs who take on the risk of holding perps through the duration of the loan.
 *
 *          Intermediating lending:
 *          Lenders can buy perps from the bill broker contract when it's under-priced, hold the perp tokens until the market price recovers and sell it back to the bill broker contract.
 *
 *
 */
contract BillBroker is ERC20BurnableUpgradeable, OwnableUpgradeable, PausableUpgradeable, ReentrancyGuardUpgradeable {
    //-------------------------------------------------------------------------
    // Libraries

    // ERC20 operations
    using SafeERC20Upgradeable for IERC20Upgradeable;
    using SafeERC20Upgradeable for IPerpetualTranche;

    // Math
    using MathUpgradeable for uint256;
    using SafeCastUpgradeable for uint256;
    using SafeCastUpgradeable for int256;
    using SignedMathUpgradeable for int256;

    //-------------------------------------------------------------------------
    // Constants & Immutables

    uint256 private constant DECIMALS = 18;
    uint256 private constant ONE = (10 ** DECIMALS);

    //-------------------------------------------------------------------------
    // Storage

    /// @notice The perpetual senior tranche token.
    IPerpetualTranche public perp;

    /// @notice The USD token.
    IERC20Upgradeable public usd;

    /// @notice The number of decimals for the fixed-point representation of usd tokens.
    uint8 public usdDecimals;

    /// @notice The number of decimals for the fixed-point representation of perp tokens.
    uint8 public perpDecimals;

    /// @notice The price oracle.
    IBillBrokerOracle public oracle;

    /// @notice The asset ratio bounds outside which swapping is disabled.
    /// @dev Swapping for dollars to perps is disabled if the system ends up with too few dollars, and the asset ratio reduces below `arBound.lower`.
    ///      Swapping for perps to dollars is disabled if the system ends up with too few perps, and the asset ratio increases above `arBound.higher`.
    Range public arBound;

    /// @notice All of the system fees.
    SystemFees public fees;

    /// @notice The asset ratio bounds outside which swap fees transition from a flat percentage fee to a linear function.
    Range public arFeeBound;

    /// @notice The maximum discount rate applied to perp tokens, when perp's DR is 0.
    /// @dev When perp's DR is 0, it not backed by any tranches but just a claim on the underlying. 
    ///      To learn more about how perp tokens work, refer the perp contract documentation.
    ///      The applied discount rate is a linear function based on perp's DR. 
    ///      discountRate = Math.min(LinearFn((1,1), (0, `maxPerpDiscountPerc`)), 1)
    uint256 public maxPerpDiscountPerc;

    //-----------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Contract initializer.
    function init(
        string memory name,
        string memory symbol,
        IPerpetualTranche perp_,
        IERC20Upgradeable usd_,
        IBillBrokerOracle oracle_
    ) public initializer {
        // initialize dependencies
        __ERC20_init(name, symbol);
        __ERC20Burnable_init();
        __Ownable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        perp = perp_;
        usd = usd_;
        perpDecimals = IERC20MetadataUpgradeable(address(perp_)).decimals();
        usdDecimals = IERC20MetadataUpgradeable(address(usd_)).decimals();

        updateOracle(oracle_);

        arBound = Range({
            lower: ((ONE * 3) / 4), // 0.75
            upper: ((ONE * 5) / 4) // 1.25
        });

        
        arFeeBound = Range({
            lower: ((ONE * 9) / 10), // 0.9
            upper: ((ONE * 11) / 10) // 1.1
        });

        updateFees(
            SystemFees({
                mintFeePerc: 0,
                burnFeePerc: 0,
                perpToUSDSwapFeePercs: Range({ lower: ONE, upper: ONE }),
                usdToPerpSwapFeePercs: Range({ lower: ONE, upper: ONE }),
                protocolSwapSharePerc: 0
            })
        );

        maxPerpDiscountPerc = (ONE * 2) / 3; // A maximum discount rate of 66%
    }

    //--------------------------------------------------------------------------
    // Owner only methods

    function updateOracle(IBillBrokerOracle oracle_) public onlyOwner {
        if (oracle.decimals() != DECIMALS) {
            revert UnexpectedDecimals();
        }
        oracle = oracle_;
    }

    function updateFees(SystemFees memory fees_) public onlyOwner {
        if (
            fees_.mintFeePerc > ONE ||
            fees_.burnFeePerc > ONE ||
            fees_.perpToUSDSwapFeePercs.lower > ONE ||
            fees_.perpToUSDSwapFeePercs.upper > ONE ||
            fees_.perpToUSDSwapFeePercs.lower > fees_.perpToUSDSwapFeePercs.upper ||
            fees_.usdToPerpSwapFeePercs.lower > ONE ||
            fees_.usdToPerpSwapFeePercs.upper > ONE ||
            fees_.usdToPerpSwapFeePercs.lower > fees_.usdToPerpSwapFeePercs.upper ||
            fees_.protocolSwapSharePerc > ONE
        ) {
            revert InvalidPerc();
        }

        fees = fees_;
    }

    //--------------------------------------------------------------------------
    // External & Public write methods

    function deposit(uint256 usdAmtAvailable, uint256 perpAmtAvailable) external returns (uint256) {
        (uint256 mintAmt, uint256 usdAmtIn, uint256 perpAmtIn) = computeMintAmt(
            usdAmtAvailable,
            perpAmtAvailable,
            reserveState()
        );
        if (mintAmt <= 0) {
            return 0;
        }

        // Transfer perp and usd tokens from the user
        usd.safeTransferFrom(msg.sender, address(this), usdAmtIn);
        perp.safeTransferFrom(msg.sender, address(this), perpAmtIn);

        // mint lp tokens
        _mint(_msgSender(), mintAmt);
        return mintAmt;
    }

    function redeem(uint256 burnAmt) external returns (uint256, uint256) {
        if (burnAmt <= 0) {
            return (0, 0);
        }

        (uint256 usdAmtOut, uint256 perpAmtOut) = computeRedemptionAmts(burnAmt);

        // burn lp tokens
        _burn(_msgSender(), burnAmt);

        // return funds
        usd.safeTransfer(_msgSender(), usdAmtOut);
        perp.safeTransfer(_msgSender(), perpAmtOut);
        return (usdAmtOut, perpAmtOut);
    }

    // increases ar
    function swapPerpsForUSD(uint256 perpAmtIn) external returns (uint256) {
        // TODO: open swaps only on certain conditions

        // Transfer perp tokens from user
        perp.safeTransferFrom(msg.sender, address(this), perpAmtIn);

        // Compute swap amount
        (uint256 usdAmtOut, uint256 protocolFeeAmt) = computePerpToUSDSwapAmt(perpAmtIn, reserveState());

        // Revert swap amount is zero
        if (perpAmtIn <= 0 || usdAmtOut <= 0) {
            revert UnacceptableSwap();
        }

        // settle protocol fee
        if (protocolFeeAmt > 0) {
            usd.safeTransfer(owner(), protocolFeeAmt);
        }

        // transfer usd out
        usd.safeTransfer(msg.sender, usdAmtOut);
        return usdAmtOut;
    }

    // decreases ar
    function swapUSDForPerps(uint256 usdAmtIn) external returns (uint256) {
        // TODO: open swaps only on certain conditions

        // Transfer usd tokens from user
        usd.safeTransferFrom(msg.sender, address(this), usdAmtIn);

        // compute perp amount out
        (uint256 perpAmtOut, uint256 protocolFeeAmt) = computeUSDToPerpSwapAmt(usdAmtIn, reserveState());

        // Revert swap amount is zero
        if (usdAmtIn <= 0 || perpAmtOut <= 0) {
            revert UnacceptableSwap();
        }

        // settle protocol fee
        if (protocolFeeAmt > 0) {
            perp.safeTransfer(owner(), protocolFeeAmt);
        }

        // transfer perps out
        perp.safeTransfer(msg.sender, perpAmtOut);
        return perpAmtOut;
    }

    // ar = 1, balance
    // ar < 1 more perps, less dollars
    // ar > 1 less perps, more dollars
    function assetRatio() external returns (uint256) {
        return _computeAssetRatio(reserveState());
    }

    function getTVL() external returns (uint256) {
        return
            usdReserve().mulDiv(getUSDPrice(), 10 ** usdDecimals) +
            perpReserve().mulDiv(getPerpPrice(), 10 ** perpDecimals);
    }

    function reserveState() public returns (ReserveState memory) {
        return
            ReserveState({
                usdReserve: usdReserve(),
                perpReserve: perpReserve(),
                usdPrice: getUSDPrice(),
                perpPrice: getPerpPrice(),
                usdUnitAmt: (10 ** usdDecimals),
                perpUnitAmt: (10 ** perpDecimals)
            });
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

    //-----------------------------------------------------------------------------
    // Public view methods

    function computeMintAmt(
        uint256 usdAmtAvailable,
        uint256 perpAmtAvailable,
        ReserveState memory s
    ) public view returns (uint256, uint256, uint256) {
        uint256 usdAmtIn = usdAmtAvailable;
        uint256 perpAmtIn = usdAmtAvailable.mulDiv(s.perpReserve, s.usdReserve);
        if (perpAmtIn > perpAmtAvailable) {
            perpAmtIn = perpAmtAvailable;
            usdAmtIn = perpAmtAvailable.mulDiv(s.usdReserve, s.perpReserve);
        }

        uint256 usdValueIn = usdAmtIn.mulDiv(s.usdPrice, s.usdUnitAmt);
        uint256 perpValueIn = perpAmtIn.mulDiv(s.perpPrice, s.perpUnitAmt);
        uint256 vauleIn = (usdValueIn+perpValueIn);
        uint256 tvl = s.usdReserve.mulDiv(s.usdPrice, s.usdUnitAmt) + s.perpReserve.mulDiv(s.perpPrice, s.perpUnitAmt);
        uint256 totalSupply_ = totalSupply();
        uint256 mintAmt = (totalSupply_ > 0) ? totalSupply_.mulDiv(vauleIn, tvl) : vauleIn;

        // On first deposit we ensure that the asset ratio bounds are honored.
        if(totalSupply_ <= 0) {
            uint256 assetRatio_ = usdValueIn.mulDiv(ONE, perpValueIn);
            if(assetRatio_ < arBound.lower || assetRatio > arBound.higher) {
                revert UnacceptableDeposit();
            }
        }

        return (mintAmt, usdAmtIn, perpAmtIn);
    }

    function computeRedemptionAmts(uint256 burnAmt) public view returns (uint256, uint256) {
        uint256 totalSupply_ = totalSupply();
        uint256 usdAmtOut = burnAmt.mulDiv(usdReserve(), totalSupply_);
        uint256 perpAmtOut = burnAmt.mulDiv(perpReserve(), totalSupply_);
        usdAmtOut = usdAmtOut.mulDiv(ONE - fees.burnFeePerc, ONE);
        perpAmtOut = perpAmtOut.mulDiv(ONE - fees.burnFeePerc, ONE);
        return (usdAmtOut, perpAmtOut);
    }

    function computePerpToUSDSwapAmt(uint256 perpAmtIn, ReserveState memory s) public view returns (uint256, uint256) {
        // We compute equal value of usd out given perp tokens in.
        // While swapping in we discount perp tokens based on the perp system's health.
        uint256 usdAmtOut = perpAmtIn.mulDiv(s.perpPrice, s.usdPrice).mulDiv(s.usdUnitAmt, s.perpUnitAmt).mulDiv(
            ONE - computeDiscountPerc(),
            ONE
        );

        uint256 arPre = _computeAssetRatio(s);
        uint256 arPost = _computeAssetRatio(
            ReserveState({
                usdReserve: s.usdReserve - usdAmtOut,
                perpReserve: s.perpReserve + perpAmtIn,
                usdPrice: s.usdPrice,
                perpPrice: s.perpPrice,
                usdUnitAmt: s.usdUnitAmt,
                perpUnitAmt: s.perpUnitAmt
            })
        );
        if (arPost > arBound.upper) {
            revert UnacceptableSwap();
        }

        (uint256 lpFeePerc, uint256 protocolFeePerc) = computePerpToUSDSwapFeePercs(arPre, arPost);
        uint256 protocolFeeAmt = usdAmtOut.mulDiv(protocolFeePerc, ONE, MathUpgradeable.Rounding.Up);
        usdAmtOut = usdAmtOut.mulDiv(ONE - (lpFeePerc + protocolFeePerc), ONE);
        return (usdAmtOut, protocolFeeAmt);
    }

    function computeUSDToPerpSwapAmt(uint256 usdAmtIn, ReserveState memory s) public view returns (uint256, uint256) {
        uint256 perpAmtOut = usdAmtIn.mulDiv(s.usdPrice, s.perpPrice).mulDiv(s.perpUnitAmt, s.usdUnitAmt);

        uint256 arPre = _computeAssetRatio(s);
        uint256 arPost = _computeAssetRatio(
            ReserveState({
                usdReserve: s.usdReserve + usdAmtIn,
                perpReserve: s.perpReserve - perpAmtOut,
                usdPrice: s.usdPrice,
                perpPrice: s.perpPrice,
                usdUnitAmt: s.usdUnitAmt,
                perpUnitAmt: s.perpUnitAmt
            })
        );
        if (arPost < arBound.lower) {
            revert UnacceptableSwap();
        }

        (uint256 lpFeePerc, uint256 protocolFeePerc) = computeUSDToPerpSwapFeePercs(arPre, arPost);
        uint256 protocolFeeAmt = perpAmtOut.mulDiv(protocolFeePerc, ONE, MathUpgradeable.Rounding.Up);
        perpAmtOut = perpAmtOut.mulDiv(ONE - (lpFeePerc + protocolFeePerc), ONE);
        return (perpAmtOut, protocolFeeAmt);
    }

    // increases ar
    function computePerpToUSDSwapFeePercs(uint256 arPre, uint256 arPost) public view returns (uint256, uint256) {
        Range memory swapFeePercs = fees.perpToUSDSwapFeePercs;
        uint256 totalSwapFeePerc = _computeFeePerc(
            LinearFn({ x1: 0, y1: swapFeePercs.lower, x2: ONE, y2: swapFeePercs.lower }),
            LinearFn({ x1: arFeeBound.upper, y1: swapFeePercs.lower, x2: arBound.upper, y2: swapFeePercs.upper }),
            arPre,
            arPost,
            arFeeBound.upper
        );
        uint256 protocolSwapFeePerc = totalSwapFeePerc.mulDiv(fees.protocolSwapSharePerc, ONE);
        return (totalSwapFeePerc - protocolSwapFeePerc, protocolSwapFeePerc);
    }

    // reduces ar
    function computeUSDToPerpSwapFeePercs(uint256 arPre, uint256 arPost) public view returns (uint256, uint256) {
        Range memory swapFeePercs = fees.usdToPerpSwapFeePercs;
        uint256 totalSwapFeePerc = _computeFeePerc(
            LinearFn({ x1: arBound.lower, y1: swapFeePercs.upper, x2: arFeeBound.lower, y2: swapFeePercs.lower }),
            LinearFn({ x1: 0, y1: swapFeePercs.lower, x2: ONE, y2: swapFeePercs.lower }),
            arPost,
            arPre,
            arFeeBound.lower
        );
        uint256 protocolSwapFeePerc = totalSwapFeePerc.mulDiv(fees.protocolSwapSharePerc, ONE);
        return (totalSwapFeePerc - protocolSwapFeePerc, protocolSwapFeePerc);
    }

    function computeDiscountPerc() public view returns (uint256) {
        IBalancer balancer = perp.balancer();
        uint256 perpDR = balancer.deviationRatio().mulDiv(ONE, 10 ** balancer.decimals());
        // If perp is over-subscribed, no discount is applied.
        if (perpDR >= ONE) {
            return 0;
        }
        // If not we compute the discount rate based on a linear function.
        return (ONE - perpDR).mulDiv(ONE - maxPerpDiscountPerc, ONE);
    }

    function usdReserve() public view returns (uint256) {
        return usd.balanceOf(address(this));
    }

    function perpReserve() public view returns (uint256) {
        return perp.balanceOf(address(this));
    }

    //-----------------------------------------------------------------------------
    // Private pure methods

    function _computeAssetRatio(ReserveState memory s) private pure returns (uint256) {
        return
            s.usdReserve.mulDiv(s.usdPrice, s.usdUnitAmt).mulDiv(ONE, s.perpReserve.mulDiv(s.perpPrice, s.perpUnitAmt));
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
