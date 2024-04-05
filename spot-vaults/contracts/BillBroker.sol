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
import { IPerpetualTranche } from "@ampleforthorg/spot-contracts/contracts/_interfaces/IPerpetualTranche.sol";
import { IBillBrokerPricingStrategy } from "./_interfaces/IBillBrokerPricingStrategy.sol";
import { ReserveState, Range, Line, BillBrokerFees } from "./_interfaces/BillBrokerTypes.sol";
import { UnacceptableSwap, UnreliablePrice, UnexpectedDecimals, InvalidPerc, InvalidARBound, SlippageTooHigh, UnauthorizedCall, UnexpectedARDelta } from "./_interfaces/BillBrokerErrors.sol";

/**
 *  @title BillBroker
 *
 *  @notice The `BillBroker` contract (inspired by bill brokers in LombardSt) acts as an intermediary between parties who want to borrow and lend.
 *
 *          `BillBroker` LPs deposit perps and dollars as available liquidity into the contract.
 *          Any user can now sell/buy perps (swap) from the bill broker for dollars, at a "fair" exchange rate determined by the contract.
 *
 *          The contract charges a fee for swap operations. The fee is a function of available liquidity held in the contract, and goes to the LPs.
 *
 *          The ratio of value of dollar tokens vs perp tokens held by the contract is defined as it's `assetRatio`.
 *              => `assetRatio` = reserveValue(usd) / reserveValue(perp)
 *
 *          The owner can define hard limits on the system's assetRatio outside which swapping is disabled.
 *
 *          The contract relies on external data sources to price assets.
 *          If the data is unreliable, swaps are simply halted.
 *
 *          Intermediating borrowing:
 *          Borrowers who want to borrower dollars against their collateral,
 *          tranche their collateral, mint perps and sell it for dollars to the bill broker.
 *          When they want to close out their position they can buy back perps from the bill broker
 *          using dollars, and redeem their tranches for the original collateral.
 *          The spread is the "interest rate" paid for the loan, which goes to the bill broker LPs
 *          who take on the risk of holding perps through the duration of the loan.
 *
 *          Intermediating lending:
 *          Lenders can buy perps from the bill broker contract when it's under-priced,
 *          hold the perp tokens until the market price recovers and sell it back to the bill broker contract.
 *
 *
 */
contract BillBroker is
    ERC20BurnableUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
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

    /// @notice The fixed-point amount of usd tokens equivalent to 1.0$.
    uint256 public usdUnitAmt;

    /// @notice The fixed-point amount of perp tokens equivalent to 1.0 perp.
    uint256 public perpUnitAmt;

    /// @notice Reference to the address that has the ability to pause/unpause operations.
    /// @dev The keeper is meant for time-sensitive operations, and may be different from the owner address.
    /// @return The address of the keeper.
    address public keeper;

    /// @notice The pricing strategy.
    IBillBrokerPricingStrategy public pricingStrategy;

    /// @notice All of the system fees.
    BillBrokerFees public fees;

    /// @notice The asset ratio bounds outside which swapping is disabled.
    Range public arHardBound;

    /// @notice The asset ratio bounds outside which swapping is still functional but,
    ///         the swap fees transition from a flat percentage fee to a linear function.
    Range public arSoftBound;

    //--------------------------------------------------------------------------
    // Events

    /// @notice Fees in usd tokens paid to LPs.
    /// @param usdAmt Fee amount in usd tokens.
    event FeeUSD(uint256 usdAmt);

    /// @notice Fees in perp tokens paid to LPs.
    /// @param perpAmt Fee amount in perp tokens.
    event FeePerp(uint256 perpAmt);

    /// @notice Protocol's fee share paid in usd tokens.
    /// @param usdAmt Fee amount in usd tokens.
    event ProtocolFeeUSD(uint256 usdAmt);

    /// @notice Protocol's fee share paid in perp tokens.
    /// @param perpAmt Fee amount in perp tokens.
    event ProtocolFeePerp(uint256 perpAmt);

    //--------------------------------------------------------------------------
    // Modifiers

    /// @dev Throws if called by any account other than the keeper.
    modifier onlyKeeper() {
        if (_msgSender() != keeper) {
            revert UnauthorizedCall();
        }
        _;
    }

    //-----------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Contract initializer.
    /// @param name ERC-20 Name of the Bill broker LP token.
    /// @param symbol ERC-20 Symbol of the Bill broker LP token.
    /// @param usd_ Address of the usd token.
    /// @param perp_ Address of the perp token.
    /// @param pricingStrategy_ Address of the pricing strategy contract.
    function init(
        string memory name,
        string memory symbol,
        IERC20Upgradeable usd_,
        IPerpetualTranche perp_,
        IBillBrokerPricingStrategy pricingStrategy_
    ) public initializer {
        // initialize dependencies
        __ERC20_init(name, symbol);
        __ERC20Burnable_init();
        __Ownable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        usd = usd_;
        perp = perp_;

        usdUnitAmt = 10 ** IERC20MetadataUpgradeable(address(usd_)).decimals();
        perpUnitAmt = 10 ** IERC20MetadataUpgradeable(address(perp_)).decimals();

        updateKeeper(owner());
        updatePricingStrategy(pricingStrategy_);
        updateFees(
            BillBrokerFees({
                mintFeePerc: 0,
                burnFeePerc: 0,
                perpToUSDSwapFeePercs: Range({ lower: ONE, upper: ONE }),
                usdToPerpSwapFeePercs: Range({ lower: ONE, upper: ONE }),
                protocolSwapSharePerc: 0
            })
        );

        updateARHardBound(
            Range({
                lower: ((ONE * 3) / 4), // 0.75
                upper: ((ONE * 5) / 4) // 1.25
            })
        );

        updateARSoftBound(
            Range({
                lower: ((ONE * 9) / 10), // 0.9
                upper: ((ONE * 11) / 10) // 1.1
            })
        );
    }

    //--------------------------------------------------------------------------
    // Owner only methods

    /// @notice Updates the reference to the keeper.
    /// @param keeper_ The address of the new keeper.
    function updateKeeper(address keeper_) public onlyOwner {
        keeper = keeper_;
    }

    /// @notice Updates the reference to the pricing strategy.
    /// @param pricingStrategy_ The address of the new pricing strategy.
    function updatePricingStrategy(
        IBillBrokerPricingStrategy pricingStrategy_
    ) public onlyOwner {
        if (pricingStrategy_.decimals() != DECIMALS) {
            revert UnexpectedDecimals();
        }
        pricingStrategy = pricingStrategy_;
    }

    /// @notice Updates the system fees.
    /// @param fees_ The new system fees.
    function updateFees(BillBrokerFees memory fees_) public onlyOwner {
        if (
            fees_.mintFeePerc > ONE ||
            fees_.burnFeePerc > ONE ||
            fees_.perpToUSDSwapFeePercs.lower > fees_.perpToUSDSwapFeePercs.upper ||
            fees_.usdToPerpSwapFeePercs.lower > fees_.usdToPerpSwapFeePercs.upper ||
            fees_.protocolSwapSharePerc > ONE
        ) {
            revert InvalidPerc();
        }

        fees = fees_;
    }

    /// @notice Updates the hard asset ratio bound.
    /// @dev Swaps are disabled when the system is outside the defined hard bounds.
    /// @param arHardBound_ The updated hard bounds.
    function updateARHardBound(Range memory arHardBound_) public onlyOwner {
        if (arHardBound_.lower > ONE || arHardBound_.upper < ONE) {
            revert InvalidARBound();
        }
        arHardBound = arHardBound_;
    }

    /// @notice Updates the soft asset ratio bound.
    /// @dev Swaps are made expensive when the system is outside the defined soft bounds.
    /// @param arSoftBound_ The updated soft bounds.
    function updateARSoftBound(Range memory arSoftBound_) public onlyOwner {
        if (arSoftBound_.lower > ONE || arSoftBound_.upper < ONE) {
            revert InvalidARBound();
        }
        arSoftBound = arSoftBound_;
    }

    //--------------------------------------------------------------------------
    // Keeper only methods

    /// @notice Pauses deposits, withdrawals and swaps.
    /// @dev ERC-20 functions, like transfers will always remain operational.
    function pause() external onlyKeeper {
        _pause();
    }

    /// @notice Unpauses deposits, withdrawals and rollovers.
    /// @dev ERC-20 functions, like transfers will always remain operational.
    function unpause() external onlyKeeper {
        _unpause();
    }

    //--------------------------------------------------------------------------
    // External & Public write methods

    /// @notice Deposits usd tokens and perp tokens and mint LP tokens.
    /// @param usdAmtMax The amount of usd tokens maximum available to be deposited.
    /// @param perpAmtMax The amount of perp tokens maximum available to be deposited.
    /// @param usdAmtMin The minimum amount of usd tokens that are expected to be deposited.
    /// @param perpAmtMin The minimum amount of perp tokens that are expected to be deposited.
    /// @return mintAmt The amount of LP tokens minted.
    function deposit(
        uint256 usdAmtMax,
        uint256 perpAmtMax,
        uint256 usdAmtMin,
        uint256 perpAmtMin
    ) external nonReentrant whenNotPaused returns (uint256 mintAmt) {
        uint256 usdAmtIn;
        uint256 perpAmtIn;
        (mintAmt, usdAmtIn, perpAmtIn) = computeMintAmt(usdAmtMax, perpAmtMax);
        if (mintAmt <= 0) {
            return 0;
        }
        if (usdAmtIn < usdAmtMin || perpAmtIn < perpAmtMin) {
            revert SlippageTooHigh();
        }

        // Transfer perp and usd tokens from the user
        usd.safeTransferFrom(_msgSender(), address(this), usdAmtIn);
        perp.safeTransferFrom(_msgSender(), address(this), perpAmtIn);

        // mint LP tokens
        _mint(_msgSender(), mintAmt);
    }

    /// @notice Burns LP tokens and redeems usd and perp tokens.
    /// @param burnAmt The LP tokens to be burnt.
    /// @return usdAmtOut The amount usd tokens returned.
    /// @return perpAmtOut The amount perp tokens returned.
    function redeem(
        uint256 burnAmt
    )
        external
        nonReentrant
        whenNotPaused
        returns (uint256 usdAmtOut, uint256 perpAmtOut)
    {
        if (burnAmt <= 0) {
            return (0, 0);
        }

        (usdAmtOut, perpAmtOut) = computeRedemptionAmts(burnAmt);

        // burn LP tokens
        _burn(_msgSender(), burnAmt);

        // return funds
        usd.safeTransfer(_msgSender(), usdAmtOut);
        perp.safeTransfer(_msgSender(), perpAmtOut);
    }

    /// @notice Swaps usd tokens from the user for perp tokens from the reserve.
    /// @param usdAmtIn The amount of usd tokens swapped in.
    /// @param perpAmtMin The minimum amount of perp tokens that are expected out.
    /// @return perpAmtOut The amount perp tokens swapped out.
    function swapUSDForPerps(
        uint256 usdAmtIn,
        uint256 perpAmtMin
    ) external nonReentrant whenNotPaused returns (uint256 perpAmtOut) {
        // compute perp amount out
        uint256 lpFeeAmt;
        uint256 protocolFeeAmt;
        (perpAmtOut, lpFeeAmt, protocolFeeAmt) = computeUSDToPerpSwapAmt(
            usdAmtIn,
            reserveState()
        );
        if (usdAmtIn <= 0 || perpAmtOut <= 0) {
            revert UnacceptableSwap();
        }
        if (perpAmtOut < perpAmtMin) {
            revert SlippageTooHigh();
        }

        // Transfer usd tokens from user
        usd.safeTransferFrom(_msgSender(), address(this), usdAmtIn);

        // settle fees
        emit FeePerp(lpFeeAmt);
        if (protocolFeeAmt > 0) {
            perp.safeTransfer(protocolFeeCollector(), protocolFeeAmt);
            emit ProtocolFeePerp(protocolFeeAmt);
        }

        // transfer perps out
        perp.safeTransfer(_msgSender(), perpAmtOut);
    }

    /// @notice Swaps perp tokens from the user for usd tokens from the reserve.
    /// @param perpAmtIn The amount of perp tokens swapped in.
    /// @param usdAmtMin The minimum amount of usd tokens that are expected out.
    /// @return usdAmtOut The amount usd tokens swapped out.
    function swapPerpsForUSD(
        uint256 perpAmtIn,
        uint256 usdAmtMin
    ) external nonReentrant whenNotPaused returns (uint256 usdAmtOut) {
        // Compute swap amount
        uint256 lpFeeAmt;
        uint256 protocolFeeAmt;
        (usdAmtOut, lpFeeAmt, protocolFeeAmt) = computePerpToUSDSwapAmt(
            perpAmtIn,
            reserveState()
        );
        if (perpAmtIn <= 0 || usdAmtOut <= 0) {
            revert UnacceptableSwap();
        }
        if (usdAmtOut < usdAmtMin) {
            revert SlippageTooHigh();
        }

        // Transfer perp tokens from user
        perp.safeTransferFrom(_msgSender(), address(this), perpAmtIn);

        // settle fees
        emit FeeUSD(lpFeeAmt);
        if (protocolFeeAmt > 0) {
            usd.safeTransfer(protocolFeeCollector(), protocolFeeAmt);
            emit ProtocolFeeUSD(protocolFeeAmt);
        }

        // transfer usd out
        usd.safeTransfer(_msgSender(), usdAmtOut);
    }

    //-----------------------------------------------------------------------------
    // Public methods

    /// @notice Computes the amount of usd tokens swapped out,
    ///         when the given number of perp tokens are sent in.
    /// @param perpAmtIn The amount of perp tokens swapped in.
    /// @return usdAmtOut The amount usd tokens swapped out.
    function computePerpToUSDSwapAmt(
        uint256 perpAmtIn
    ) public returns (uint256 usdAmtOut) {
        (usdAmtOut, , ) = computePerpToUSDSwapAmt(perpAmtIn, reserveState());
    }

    /// @notice Computes the amount of perp tokens swapped out,
    ///         when the given number of usd tokens are sent in.
    /// @param usdAmtIn The number of usd tokens sent in.
    /// @return perpAmtOut The amount of perp tokens swapped out.
    function computeUSDToPerpSwapAmt(
        uint256 usdAmtIn
    ) public returns (uint256 perpAmtOut) {
        (perpAmtOut, , ) = computeUSDToPerpSwapAmt(usdAmtIn, reserveState());
    }

    /// @return s The reserve usd and perp token balances and prices.
    function reserveState() public returns (ReserveState memory s) {
        return
            ReserveState({
                usdReserve: usd.balanceOf(address(this)),
                perpReserve: perp.balanceOf(address(this)),
                usdPrice: usdPrice(),
                perpPrice: perpPrice()
            });
    }

    /// @dev Reverts if the pricing strategy returns an invalid price.
    /// @return The price of usd tokens from the pricing strategy.
    function usdPrice() public returns (uint256) {
        (uint256 p, bool v) = pricingStrategy.usdPrice();
        if (!v) {
            revert UnreliablePrice();
        }
        return p;
    }

    /// @dev Reverts if the pricing strategy returns an invalid price.
    /// @return The price of perp tokens from the pricing strategy.
    function perpPrice() public returns (uint256) {
        (uint256 p, bool v) = pricingStrategy.perpPrice();
        if (!v) {
            revert UnreliablePrice();
        }
        return p;
    }

    //-----------------------------------------------------------------------------
    // External view methods

    /// @return The balance of usd tokens in the reserve.
    function usdReserve() external view returns (uint256) {
        return usd.balanceOf(address(this));
    }

    /// @return The balance of perp tokens in the reserve.
    function perpReserve() external view returns (uint256) {
        return perp.balanceOf(address(this));
    }

    //-----------------------------------------------------------------------------
    // Public view methods

    /// @notice Computes the amount of LP tokens minted,
    ///         when the given number of usd and perp tokens are deposited.
    /// @param usdAmtMax The maximum available usd tokens.
    /// @param perpAmtMax The maximum available perp tokens.
    /// @return mintAmt The amount of LP tokens minted.
    /// @return usdAmtIn The usd tokens to be deposited.
    /// @return perpAmtIn The perp tokens to be deposited.
    function computeMintAmt(
        uint256 usdAmtMax,
        uint256 perpAmtMax
    ) public view returns (uint256 mintAmt, uint256 usdAmtIn, uint256 perpAmtIn) {
        if (usdAmtMax <= 0 || perpAmtMax <= 0) {
            return (0, 0, 0);
        }

        uint256 totalSupply_ = totalSupply();
        // During the initial deposit we deposit the entire available amounts.
        // The onus is on the depositor to ensure that the value of USD tokens and
        // perp tokens on first deposit are equivalent.
        if (totalSupply_ <= 0) {
            usdAmtIn = usdAmtMax;
            perpAmtIn = perpAmtMax;
            mintAmt = (ONE.mulDiv(usdAmtIn, usdUnitAmt) +
                ONE.mulDiv(perpAmtIn, perpUnitAmt));
        } else {
            // Users can deposit assets proportional to the reserve.
            uint256 usdReserve_ = usd.balanceOf(address(this));
            uint256 perpReserve_ = perp.balanceOf(address(this));
            usdAmtIn = usdAmtMax;
            perpAmtIn = perpReserve_.mulDiv(usdAmtIn, usdReserve_);
            mintAmt = totalSupply_.mulDiv(usdAmtIn, usdReserve_);
            if (perpAmtIn > perpAmtMax) {
                perpAmtIn = perpAmtMax;
                usdAmtIn = usdReserve_.mulDiv(perpAmtIn, perpReserve_);
                mintAmt = totalSupply_.mulDiv(perpAmtIn, perpReserve_);
            }
        }

        mintAmt = mintAmt.mulDiv(ONE - fees.mintFeePerc, ONE);
    }

    /// @notice Computes the amount of usd and perp tokens redeemed,
    ///         when the given number of LP tokens are burnt.
    /// @param burnAmt The amount of LP tokens to be burnt.
    /// @return usdAmtOut The amount of usd tokens redeemed.
    /// @return perpAmtOut The amount of perp tokens redeemed.
    function computeRedemptionAmts(
        uint256 burnAmt
    ) public view returns (uint256 usdAmtOut, uint256 perpAmtOut) {
        if (burnAmt <= 0) {
            return (0, 0);
        }

        uint256 totalSupply_ = totalSupply();
        usdAmtOut = burnAmt.mulDiv(usd.balanceOf(address(this)), totalSupply_).mulDiv(
            ONE - fees.burnFeePerc,
            ONE
        );
        perpAmtOut = burnAmt.mulDiv(perp.balanceOf(address(this)), totalSupply_).mulDiv(
            ONE - fees.burnFeePerc,
            ONE
        );
    }

    /// @notice Computes the amount of usd tokens swapped out,
    ///         when the given number of perp tokens are sent in.
    /// @param perpAmtIn The number of perp tokens sent in.
    /// @param s The current reserve state.
    /// @dev Quoted usd token amount out includes the fees withheld.
    /// @return usdAmtOut The amount of usd tokens swapped out.
    /// @return lpFeeAmt The amount of usd tokens charged as swap fees by LPs.
    /// @return protocolFeeAmt The amount of usd tokens charged as protocol fees.
    function computePerpToUSDSwapAmt(
        uint256 perpAmtIn,
        ReserveState memory s
    ) public view returns (uint256 usdAmtOut, uint256 lpFeeAmt, uint256 protocolFeeAmt) {
        // We compute equal value of usd tokens out given perp tokens in.
        usdAmtOut = perpAmtIn.mulDiv(s.perpPrice, s.usdPrice).mulDiv(
            usdUnitAmt,
            perpUnitAmt
        );

        // We compute the total fee percentage, lp fees and protocol fees
        uint256 totalFeePerc = computePerpToUSDSwapFeePerc(
            assetRatio(s),
            assetRatio(
                ReserveState({
                    usdReserve: s.usdReserve - usdAmtOut,
                    perpReserve: s.perpReserve + perpAmtIn,
                    usdPrice: s.usdPrice,
                    perpPrice: s.perpPrice
                })
            )
        );
        if (totalFeePerc >= ONE) {
            return (0, 0, 0);
        }
        uint256 totalFeeAmt = usdAmtOut.mulDiv(totalFeePerc, ONE);
        usdAmtOut -= totalFeeAmt;
        lpFeeAmt = totalFeeAmt.mulDiv(ONE - fees.protocolSwapSharePerc, ONE);
        protocolFeeAmt = totalFeeAmt - lpFeeAmt;
    }

    /// @notice Computes the amount of perp tokens swapped out,
    ///         when the given number of usd tokens are sent in.
    /// @param usdAmtIn The number of usd tokens sent in.
    /// @param s The current reserve state.
    /// @dev Quoted perp token amount out includes the fees withheld.
    /// @return perpAmtOut The amount of perp tokens swapped out.
    /// @return lpFeeAmt The amount of perp tokens charged as swap fees by LPs.
    /// @return protocolFeeAmt The amount of perp tokens charged as protocol fees.
    function computeUSDToPerpSwapAmt(
        uint256 usdAmtIn,
        ReserveState memory s
    ) public view returns (uint256 perpAmtOut, uint256 lpFeeAmt, uint256 protocolFeeAmt) {
        // We compute equal value of perp tokens out given usd tokens in.
        perpAmtOut = usdAmtIn.mulDiv(s.usdPrice, s.perpPrice).mulDiv(
            perpUnitAmt,
            usdUnitAmt
        );
        // We compute the total fee percentage, lp fees and protocol fees
        uint256 totalFeePerc = computeUSDToPerpSwapFeePerc(
            assetRatio(s),
            assetRatio(
                ReserveState({
                    usdReserve: s.usdReserve + usdAmtIn,
                    perpReserve: s.perpReserve - perpAmtOut,
                    usdPrice: s.usdPrice,
                    perpPrice: s.perpPrice
                })
            )
        );
        if (totalFeePerc >= ONE) {
            return (0, 0, 0);
        }
        uint256 totalFeeAmt = perpAmtOut.mulDiv(totalFeePerc, ONE);
        perpAmtOut -= totalFeeAmt;
        lpFeeAmt = totalFeeAmt.mulDiv(ONE - fees.protocolSwapSharePerc, ONE);
        protocolFeeAmt = totalFeeAmt - lpFeeAmt;
    }

    /// @notice Computes the swap fee percentage when swapping from perp to usd tokens.
    /// @dev Swapping from perp to usd tokens, leaves the system with more perp and fewer usd tokens
    ///      thereby decreasing the system's `assetRatio`. Thus arPost < arPre.
    /// @param arPre The asset ratio of the system before swapping.
    /// @param arPost The asset ratio of the system after swapping.
    /// @return The fee percentage.
    function computePerpToUSDSwapFeePerc(
        uint256 arPre,
        uint256 arPost
    ) public view returns (uint256) {
        if (arPost > arPre) {
            revert UnexpectedARDelta();
        }

        // When the ar decreases below the lower bound,
        // swaps are effectively halted by setting fees to 100%.
        if (arPost < arHardBound.lower) {
            return ONE;
        }
        // When the ar is between the soft and hard bound, a linear function is applied.
        // When the ar is above the soft bound, a flat percentage fee is applied.
        //
        //   fee
        //    ^
        //    |
        // fh |    \          |
        //    |     \         |
        //    |      \        |
        //    |       \       |
        //    |        \      |
        //    |         \     |
        // fl |          \__________
        //    |               |
        //    |               |
        //    |               |
        //    +---------------------------> ar
        //       arHL  arSL  1.0
        //
        Range memory swapFeePercs = fees.perpToUSDSwapFeePercs;
        return
            _computeFeePerc(
                Line({
                    x1: arHardBound.lower,
                    y1: swapFeePercs.upper,
                    x2: arSoftBound.lower,
                    y2: swapFeePercs.lower
                }),
                Line({ x1: 0, y1: swapFeePercs.lower, x2: ONE, y2: swapFeePercs.lower }),
                arPost,
                arPre,
                arSoftBound.lower
            );
    }

    /// @notice Computes the swap fee percentage when swapping from usd to perp tokens.
    /// @dev Swapping from usd to perp tokens, leaves the system with more usd and fewer perp tokens
    ///      thereby increasing the system's `assetRatio`. Thus arPost > arPre.
    /// @param arPre The asset ratio of the system before swapping.
    /// @param arPost The asset ratio of the system after swapping.
    /// @return The fee percentage.
    function computeUSDToPerpSwapFeePerc(
        uint256 arPre,
        uint256 arPost
    ) public view returns (uint256) {
        if (arPost < arPre) {
            revert UnexpectedARDelta();
        }

        // When the ar increases above the hard bound,
        // swaps are effectively halted by setting fees to 100%.
        if (arPost > arHardBound.upper) {
            return ONE;
        }

        // When the ar is between the soft and hard bound, a linear function is applied.
        // When the ar is below the soft bound, a flat percentage fee is applied.
        //
        //   fee
        //    ^
        //    |
        // fh |         |           /
        //    |         |          /
        //    |         |         /
        //    |         |        /
        //    |         |       /
        //    |         |      /
        // fl |     __________/
        //    |         |
        //    |         |
        //    |         |
        //    +---------------------------> ar
        //              1.0  arSU   arHU
        //
        Range memory swapFeePercs = fees.usdToPerpSwapFeePercs;
        return
            _computeFeePerc(
                Line({ x1: 0, y1: swapFeePercs.lower, x2: ONE, y2: swapFeePercs.lower }),
                Line({
                    x1: arSoftBound.upper,
                    y1: swapFeePercs.lower,
                    x2: arHardBound.upper,
                    y2: swapFeePercs.upper
                }),
                arPre,
                arPost,
                arSoftBound.upper
            );
    }

    /// @param s The system reserve state.
    /// @return The computed asset ratio of the system.
    function assetRatio(ReserveState memory s) public view returns (uint256) {
        return
            s.usdReserve.mulDiv(s.usdPrice, usdUnitAmt).mulDiv(
                ONE,
                s.perpReserve.mulDiv(s.perpPrice, perpUnitAmt)
            );
    }

    /// @notice The address which holds any revenue extracted by protocol.
    /// @return Address of the fee collector.
    function protocolFeeCollector() public view returns (address) {
        return owner();
    }

    //-----------------------------------------------------------------------------
    // Private methods

    /// @dev The function assumes the fee curve is defined a pair-wise linear function which merge at the cutoff point.
    ///      The swap fee is computed as area under the fee curve between {arL,arU}.
    function _computeFeePerc(
        Line memory fn1,
        Line memory fn2,
        uint256 arL,
        uint256 arU,
        uint256 cutoff
    ) private pure returns (uint256) {
        if (arU <= cutoff) {
            return _auc(fn1, arL, arU);
        } else if (arL >= cutoff) {
            return _auc(fn2, arL, arU);
        } else {
            return (_auc(fn1, arL, cutoff).mulDiv(cutoff - arL, arU - arL) +
                _auc(fn2, cutoff, arU).mulDiv(arU - cutoff, arU - arL));
        }
    }

    /// @dev Given a linear function defined by points (x1,y1) (x2,y2),
    ///      we compute the area under the curve between (xL, xU) assuming xL <= xU.
    function _auc(Line memory fn, uint256 xL, uint256 xU) private pure returns (uint256) {
        // m = dlY/dlX
        // c = y2 - m . x2
        // Integral m . x + c => m . x^2 / 2 + c
        // Area between [xL, xU] => (m . (xU^2 - xL^2) / 2 + c . (xU - xL)) / (xU - xL)
        //                       => m.(xL+xU)/2 + c
        int256 dlY = fn.y2.toInt256() - fn.y1.toInt256();
        int256 dlX = fn.x2.toInt256() - fn.x1.toInt256();
        int256 c = fn.y2.toInt256() - ((fn.x2.toInt256() * dlY) / dlX);
        int256 area = ((xL + xU).toInt256() * dlY) / (2 * dlX) + c;
        return area.abs();
    }
}
