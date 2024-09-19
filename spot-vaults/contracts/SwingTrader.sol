// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { PausableUpgradeable } from "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import { ERC20BurnableUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

import { IPerpetualTranche } from "@ampleforthorg/spot-contracts/contracts/_interfaces/IPerpetualTranche.sol";
import { IPerpPricer } from "./_interfaces/IPerpPricer.sol";
import { Range } from "./_interfaces/types/CommonTypes.sol";
import { UnacceptableSwap, UnexpectedDecimals, SlippageTooHigh, UnauthorizedCall, InvalidRange } from "./_interfaces/errors/CommonErrors.sol";
import { TooManyRedemptionRequests, SwapLimitExceeded, WaittimeTooHigh } from "./_interfaces/errors/SwingTraderErrors.sol";

/**
 *  @title SwingTrader
 *
 *  @notice The `SwingTrader` contract a counter-cyclical trader which gradually buys/sells underlying tokens for
 *          perps above/below a defined band of operation.
 *
 *          The vault quoted prices are centered around perp's redeemable underlying token value P (and P' = 1/P).
 *          For example if the `tradingBand` is +-5%. The vault buys underlying tokens for perps at (0.95*P') and
 *          sells underlying tokens for perps at (1.05*P').
 *
 *          Additionally, the vault uses and external market price oracle to be better informed.
 *              -   If the underlying token market price is below the lower band price (0.95*P'),
 *                  it quotes the market price.
 *                  This is essentially a "buy stop order" which stops buying above the lower band price.
 *              -   If the underlying token market price is above the upper band price (1.05*P'),
 *                  it again quotes the market price.
 *                  This is essentially a "sell stop order" which stops selling below the upper band price.
 *
 *          It limits daily swap volume thereby making it's market impact gradual
 *          (somewhat similar to a twap buy/sell).
 *
 *          The vault is open access and doesn't charge fees for any operation.
 *          However, it does NOT allow on-demand redemption and enforces a waiting period.
 *
 */
contract SwingTrader is
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

    //-------------------------------------------------------------------------
    // Constants & Immutables

    uint256 public constant DECIMALS = 18;
    uint256 public constant ONE = (10 ** DECIMALS);
    uint256 private constant DAY_SEC = 86400;
    uint256 private constant MAX_REDEMPTION_WAIT_SEC = (86400 * 120);
    uint256 private constant INITIAL_RATE = 10 ** 6;
    uint256 public constant MINIMUM_LIQUIDITY = 10 ** 12;
    uint8 public constant MAX_REDEMPTION_REQUESTS_PER_ACCOUNT = 32;

    //-------------------------------------------------------------------------
    // Storage

    /// @notice The perpetual senior tranche token.
    IPerpetualTranche public perp;

    /// @notice The underlying token.
    IERC20Upgradeable public underlying;

    /// @notice Reference to the address that has the ability to pause/unpause operations.
    /// @dev The keeper is meant for time-sensitive operations, and may be different from the owner address.
    /// @return The address of the keeper.
    address public keeper;

    /// @notice The band around which the vault buys/sells underlying tokens for perps.
    /// @dev Quotes a price to buy underlying tokens for perps below the lower band.
    ///      Quotes a price to sell underlying tokens for perps above the upper band.
    Range public tradingBand;

    /// @notice Amount of time before the redeemed tokens can be released to the user.
    uint256 public redemptionWaitTimeSec;

    /// @notice The redemption request data structure keeps track of the amount of LP tokens
    ///         to be redeemed and the request can be resolved (i.e when the lockup expires).
    struct RedemptionRequest {
        /// @notice The amount of LP tokens to be redeemed.
        uint256 amount;
        /// @notice Timestamp when the request can be resolved.
        uint256 resolutionTimestampSec;
    }

    /// @notice Mapping between account address and a list of pending redemptions.
    mapping(address => RedemptionRequest[]) public pendingRedemptions;

    /// @notice The daily swap limit data structure keeps track of the total volume of tokens
    ///         that can be traded daily as a fixed amount and a percentage of the current vault balance.
    /// @dev Swaps are allowed only if daily volume is below both the defined absolute amount
    ///      and percentage of vault balance.
    struct DailySwapLimit {
        uint256 amount;
        uint256 perc;
    }

    /// @notice The defined limits on the vault's underlying to perp token swaps.
    DailySwapLimit public perpSellLimit;

    /// @notice The defined limits on the vault's perps to underlying token swaps.
    DailySwapLimit public underlyingSellLimit;

    /// @notice The daily volume data structure keeps track of the total volume of
    ///         of assets leaving the vault through swaps on a daily basis.
    struct DailyVolume {
        /// @notice The day timestamp of the last recorded swap.
        uint256 dayTimestamp;
        /// @notice The total amount of underlying tokens which have left the vault
        ///         through swaps in the last day.
        uint256 underlyingAmt;
        /// @notice The total amount of perp tokens which have left the vault
        ///         through swaps in the last day.
        uint256 perpAmt;
    }
    /// @notice The daily swap volume flowing through the vault.
    DailyVolume public dailyVolume;

    /// @notice External oracle which returns the current market price of perp
    ///         and the underlying tokens denominated in dollars.
    /// @dev This reference is optional when it is not set, the vault simply buys and sells
    ///      around the trading band.
    IPerpPricer public oracle;

    /// @notice The premium/discount the vault applies to market price to encourage arbitrage.
    uint256 public arbTolerancePerc;

    //--------------------------------------------------------------------------
    // Modifiers

    /// @dev Throws if called by any account other than the keeper.
    modifier onlyKeeper() {
        if (msg.sender != keeper) {
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
    /// @param perp_ Address of the perp token.
    /// @param oracle_ Address of the oracle contract.
    function init(
        string memory name,
        string memory symbol,
        IERC20Upgradeable underlying_,
        IPerpetualTranche perp_,
        IPerpPricer oracle_
    ) public initializer {
        // initialize dependencies
        __ERC20_init(name, symbol);
        __ERC20Burnable_init();
        __Ownable_init();
        __Pausable_init();
        __ReentrancyGuard_init();

        // initialize storage variables
        underlying = underlying_;
        perp = perp_;

        updateKeeper(owner());
        updateOracle(oracle_);

        updateTradingConfig(
            Range({
                lower: (ONE * 95) / 100, // 0.95
                upper: (ONE * 105) / 100 // 1.05
            }),
            (ONE * 25) / 1000 // 0.025 or 2.5%
        );
        updateRedemptionWaitTimeSec(28 * 86400); // 28 days

        updateDailySwapLimit(DailySwapLimit(0, 0), DailySwapLimit(0, 0));
        dailyVolume = DailyVolume(0, 0, 0);
    }

    //--------------------------------------------------------------------------
    // Owner only methods

    /// @notice Updates the reference to the keeper.
    /// @param keeper_ The address of the new keeper.
    function updateKeeper(address keeper_) public onlyOwner {
        keeper = keeper_;
    }

    /// @notice Updates the reference to the oracle.
    /// @param oracle_ The address of the new oracle.
    function updateOracle(IPerpPricer oracle_) public onlyOwner {
        if (oracle_.decimals() != DECIMALS) {
            revert UnexpectedDecimals();
        }
        oracle = oracle_;
    }

    /// @notice Updates the redemption wait time.
    /// @param redemptionWaitTimeSec_ The new redemption wait time in seconds.
    function updateRedemptionWaitTimeSec(
        uint256 redemptionWaitTimeSec_
    ) public onlyOwner {
        if (redemptionWaitTimeSec_ > MAX_REDEMPTION_WAIT_SEC) {
            revert WaittimeTooHigh();
        }
        redemptionWaitTimeSec = redemptionWaitTimeSec_;
    }

    /// @notice Updates the training configuration.
    /// @param tradingBand_ The new trading band.
    /// @param arbTolerancePerc_ The discount/premium on top of market price to facilitate arb.
    function updateTradingConfig(
        Range memory tradingBand_,
        uint256 arbTolerancePerc_
    ) public onlyOwner {
        if (tradingBand_.lower > tradingBand_.upper) {
            revert InvalidRange();
        }
        tradingBand = tradingBand_;
        arbTolerancePerc = arbTolerancePerc_;
    }

    /// @notice Updates the daily swap limits.
    function updateDailySwapLimit(
        DailySwapLimit memory underlyingSellLimit_,
        DailySwapLimit memory perpSellLimit_
    ) public onlyOwner {
        underlyingSellLimit = underlyingSellLimit_;
        perpSellLimit = perpSellLimit_;
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

    /// @notice Single sided underlying token deposit and mint LP tokens.
    /// @param underlyingAmtIn The amount of underlying tokens to be deposited.
    /// @return mintAmt The amount of LP tokens minted.
    function depositUnderlying(
        uint256 underlyingAmtIn
    ) external nonReentrant whenNotPaused returns (uint256 mintAmt) {
        bool isFirstMint;
        (mintAmt, isFirstMint) = computeMintAmtWithUnderlying(underlyingAmtIn);
        if (mintAmt <= 0) {
            return 0;
        }

        // Transfer underlying tokens from the user
        underlying.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // Permanently lock the MINIMUM_LIQUIDITY tokens on first mint
        if (isFirstMint) {
            _mint(address(this), MINIMUM_LIQUIDITY);
            mintAmt -= MINIMUM_LIQUIDITY;
        }

        // mint LP tokens to the user
        _mint(msg.sender, mintAmt);
    }

    /// @notice Single sided perp token deposit and mint LP tokens.
    /// @param perpAmtIn The amount of perp tokens to be deposited.
    /// @return mintAmt The amount of LP tokens minted.
    function depositPerp(
        uint256 perpAmtIn
    ) external nonReentrant whenNotPaused returns (uint256 mintAmt) {
        mintAmt = computeMintAmtWithPerp(perpAmtIn);
        if (mintAmt <= 0) {
            return 0;
        }

        // Transfer perp tokens from the user
        perp.safeTransferFrom(msg.sender, address(this), perpAmtIn);

        // mint LP tokens to the user
        _mint(msg.sender, mintAmt);
    }

    /// @notice Queues up redemption request.
    /// @param burnAmt The LP tokens to be redeem.
    function requestRedeem(uint256 burnAmt) external nonReentrant whenNotPaused {
        if (burnAmt == 0) {
            return;
        }

        // Takes custody of LP tokens and queues up redemption.
        transfer(address(this), burnAmt);

        // Queues up redemption request
        _addRequest(msg.sender, burnAmt);
    }

    /// @notice Burns LP tokens and redeems underlying and perp tokens.
    /// @return underlyingAmtOut The amount underlying tokens returned.
    /// @return perpAmtOut The amount perp tokens returned.
    function execRedeem()
        external
        nonReentrant
        whenNotPaused
        returns (uint256 underlyingAmtOut, uint256 perpAmtOut)
    {
        // Removes resolved requests from the pending list and
        // calculates total LP tokens that can be burnt now.
        uint256 burnAmt = _removeResolvedRequests(msg.sender);

        // Compute redemption accounts.
        (underlyingAmtOut, perpAmtOut) = computeRedemptionAmts(burnAmt);
        if (burnAmt == 0 || underlyingAmtOut == 0 || perpAmtOut == 0) {
            return (0, 0);
        }

        // Burn LP tokens.
        _burn(address(this), burnAmt);

        // Transfer underlying tokens and perps back to the user.
        underlying.safeTransfer(msg.sender, underlyingAmtOut);
        perp.safeTransfer(msg.sender, perpAmtOut);
    }

    /// @notice Swaps underlying tokens from the user for perp tokens from the vault.
    /// @dev The vault buys underlying tokens and sells perps.
    /// @param underlyingAmtIn The amount of underlying tokens swapped in.
    /// @param perpAmtMin The minimum amount of perp tokens that are expected out.
    /// @return perpAmtOut The amount perp tokens swapped out.
    function swapUnderlyingForPerps(
        uint256 underlyingAmtIn,
        uint256 perpAmtMin
    ) external nonReentrant whenNotPaused returns (uint256 perpAmtOut) {
        // compute perp amount out
        perpAmtOut = computeUnderlyingToPerpSwapAmt(underlyingAmtIn);
        if (underlyingAmtIn <= 0 || perpAmtOut <= 0) {
            revert UnacceptableSwap();
        }
        if (perpAmtOut < perpAmtMin) {
            revert SlippageTooHigh();
        }

        // Transfer underlying tokens from user
        underlying.safeTransferFrom(msg.sender, address(this), underlyingAmtIn);

        // enforce daily swap limit
        _enforcePerpSellLimit(perpAmtOut);

        // transfer perps out to the user
        perp.safeTransfer(msg.sender, perpAmtOut);
    }

    /// @notice Swaps perp tokens from the user for underlying tokens from the vault.
    /// @dev The vault sells underlying tokens and buys perps.
    /// @param perpAmtIn The amount of perp tokens swapped in.
    /// @param underlyingAmtMin The minimum amount of underlying tokens that are expected out.
    /// @return underlyingAmtOut The amount underlying tokens swapped out.
    function swapPerpsForUnderlying(
        uint256 perpAmtIn,
        uint256 underlyingAmtMin
    ) external nonReentrant whenNotPaused returns (uint256 underlyingAmtOut) {
        // Compute swap amount
        underlyingAmtOut = computePerpToUnderlyingSwapAmt(perpAmtIn);
        if (perpAmtIn <= 0 || underlyingAmtOut <= 0) {
            revert UnacceptableSwap();
        }
        if (underlyingAmtOut < underlyingAmtMin) {
            revert SlippageTooHigh();
        }

        // Transfer perp tokens from user
        perp.safeTransferFrom(msg.sender, address(this), perpAmtIn);

        // enforce daily swap limit
        _enforceUnderlyingSellLimit(underlyingAmtOut);

        // transfer underlying out to the user
        underlying.safeTransfer(msg.sender, underlyingAmtOut);
    }

    //-----------------------------------------------------------------------------
    // Public methods

    /// @notice Computes the amount of LP tokens minted,
    ///         when the given number of underlying tokens are deposited.
    /// @param underlyingAmtIn The amount of underlying tokens deposited.
    /// @return mintAmt The amount of LP tokens minted.
    function computeMintAmtWithUnderlying(
        uint256 underlyingAmtIn
    ) public returns (uint256 mintAmt, bool isFirstMint) {
        uint256 totalReserveVal = underlying.balanceOf(address(this)) +
            perp.balanceOf(address(this)).mulDiv(perp.getTVL(), perp.totalSupply());
        uint256 totalSupply_ = totalSupply();
        mintAmt = (totalReserveVal > 0)
            ? underlyingAmtIn.mulDiv(totalSupply_, totalReserveVal)
            : (underlyingAmtIn * INITIAL_RATE);
        isFirstMint = (totalSupply_ == 0);
    }

    /// @notice Computes the amount of LP tokens minted,
    ///         when the given number of perp tokens are deposited.
    /// @param perpAmtIn The amount of perp tokens deposited.
    /// @return mintAmt The amount of LP tokens minted.
    function computeMintAmtWithPerp(uint256 perpAmtIn) public returns (uint256 mintAmt) {
        uint256 perpPrice = ONE.mulDiv(perp.getTVL(), perp.totalSupply());
        uint256 valueIn = perpAmtIn.mulDiv(perpPrice, ONE);
        uint256 totalReserveVal = underlying.balanceOf(address(this)) +
            perp.balanceOf(address(this)).mulDiv(perpPrice, ONE);
        mintAmt = (totalReserveVal > 0)
            ? valueIn.mulDiv(totalSupply(), totalReserveVal)
            : 0;
    }

    /// @notice Computes the amount of underlying tokens swapped out,
    ///         when the given number of perp tokens are sent in.
    /// @param perpAmtIn The amount of perp tokens swapped in.
    /// @return underlyingAmtOut The amount underlying tokens swapped out.
    function computePerpToUnderlyingSwapAmt(
        uint256 perpAmtIn
    ) public returns (uint256 underlyingAmtOut) {
        // NOTE: Vault sells underlying tokens to the user.

        // We calculate underlying token to perp exchange rate.
        uint256 underlyingPerPerp = ONE.mulDiv(perp.totalSupply(), perp.getTVL());
        underlyingPerPerp = underlyingPerPerp.mulDiv(tradingBand.upper, ONE);

        // If the market price is higher than offered price,
        // the vault quotes the market price.
        (uint256 marketRate, bool marketRateValid) = getMarketRate();
        if (marketRateValid) {
            // The vault offers a slight discount on top of the market price to allow for arb.
            marketRate = marketRate.mulDiv(ONE - arbTolerancePerc, ONE);
            underlyingPerPerp = MathUpgradeable.max(underlyingPerPerp, marketRate);
        }

        return perpAmtIn.mulDiv(ONE, underlyingPerPerp);
    }

    /// @notice Computes the amount of perp tokens swapped out,
    ///         when the given number of underlying tokens are sent in.
    /// @param underlyingAmtIn The number of underlying tokens sent in.
    /// @return perpAmtOut The amount of perp tokens swapped out.
    function computeUnderlyingToPerpSwapAmt(
        uint256 underlyingAmtIn
    ) public returns (uint256 perpAmtOut) {
        // NOTE: Vault buys underlying tokens from the user.

        // We calculate underlying token to perp exchange rate.
        uint256 underlyingPerPerp = ONE.mulDiv(perp.totalSupply(), perp.getTVL());
        underlyingPerPerp = underlyingPerPerp.mulDiv(tradingBand.lower, ONE);

        // If the market price is lower than offered price,
        // the vault quotes the market price.
        (uint256 marketRate, bool marketRateValid) = getMarketRate();
        if (marketRateValid) {
            // The vault offers a slight premium on top of the market price to allow for arb.
            marketRate = marketRate.mulDiv(ONE + arbTolerancePerc, ONE);
            underlyingPerPerp = MathUpgradeable.min(underlyingPerPerp, marketRate);
        }
        return underlyingAmtIn.mulDiv(underlyingPerPerp, ONE);
    }

    /// @notice Fetches the exchange rate between underlying tokens and perps
    ///         based on market prices.
    function getMarketRate() public returns (uint256, bool) {
        // When the oracle reference is not set, it returns.
        if (address(oracle) == address(0)) {
            return (0, false);
        }
        (uint256 underlyingPerUsd, bool underlyingUsdRateValid) = oracle
            .underlyingUsdPrice();
        (uint256 perpPerUsd, bool perpUnderlyingRateValid) = oracle.perpUsdPrice();
        if (!underlyingUsdRateValid || !perpUnderlyingRateValid) {
            return (0, false);
        }
        return (underlyingPerUsd.mulDiv(ONE, perpPerUsd), true);
    }

    //-----------------------------------------------------------------------------
    // External view methods

    /// @return The balance of underlying tokens in the reserve.
    function underlyingBalance() external view returns (uint256) {
        return underlying.balanceOf(address(this));
    }

    /// @return The balance of perp tokens in the reserve.
    function perpBalance() external view returns (uint256) {
        return perp.balanceOf(address(this));
    }

    /// @return The redemption request for a given account and list index.
    function getRedemptionRequest(
        address account,
        uint8 reqIdx
    ) external view returns (RedemptionRequest memory) {
        return pendingRedemptions[account][reqIdx];
    }

    /// @return The number of redemption requests active from the given account.
    function getRedemptionRequestCount(address account) external view returns (uint8) {
        return uint8(pendingRedemptions[account].length);
    }

    //-----------------------------------------------------------------------------
    // Public view methods

    /// @notice Computes the amount of underlying and perp tokens redeemed,
    ///         when the given number of LP tokens are burnt.
    /// @param burnAmt The amount of LP tokens to be burnt.
    /// @return underlyingAmtOut The amount of underlying tokens redeemed.
    /// @return perpAmtOut The amount of perp tokens redeemed.
    function computeRedemptionAmts(
        uint256 burnAmt
    ) public view returns (uint256 underlyingAmtOut, uint256 perpAmtOut) {
        if (burnAmt <= 0) {
            return (0, 0);
        }

        uint256 totalSupply_ = totalSupply();
        underlyingAmtOut = underlying.balanceOf(address(this)).mulDiv(
            burnAmt,
            totalSupply_
        );
        perpAmtOut = perp.balanceOf(address(this)).mulDiv(burnAmt, totalSupply_);
    }

    /// @notice Computes the total amount of LP tokens have no more lockups and are available to be burnt now.
    /// @param account Account address.
    /// @return burnAmt Total amount of LP tokens.
    function computeBurnableAmt(
        address account
    ) public view returns (uint256 burnAmt) {
        uint8 nRequests = uint8(pendingRedemptions[account].length);
        if (nRequests <= 0) {
            return 0;
        }
        for (uint8 i = nRequests; i > 0; i--) {
            RedemptionRequest memory req = pendingRedemptions[account][i - 1];
            if (req.resolutionTimestampSec >= block.timestamp) {
                continue;
            }
            burnAmt += req.amount;
        }
    }

    //-----------------------------------------------------------------------------
    // Private methods

    /// @dev Adds redemption request to the list.
    function _addRequest(address account, uint256 burnAmt) private {
        pendingRedemptions[account].push(
            RedemptionRequest(burnAmt, block.timestamp + redemptionWaitTimeSec)
        );
        if (pendingRedemptions[account].length > MAX_REDEMPTION_REQUESTS_PER_ACCOUNT) {
            revert TooManyRedemptionRequests();
        }
    }

    /// @dev Removes resolved redemption requests from the list.
    function _removeResolvedRequests(
        address account
    ) private returns (uint256 amountToBurn) {
        uint8 nRequests = uint8(pendingRedemptions[account].length);
        if (nRequests <= 0) {
            return 0;
        }

        for (uint8 i = nRequests; i > 0; i--) {
            RedemptionRequest storage req = pendingRedemptions[account][i - 1];

            // Redemption request has not yet been resolved,
            // still in the waiting period, so skip to the next request.
            if (req.resolutionTimestampSec >= block.timestamp) {
                continue;
            }

            // Keep track of the total amount.
            amountToBurn += req.amount;

            // We delete current redemption request by over-writing with the last element and
            // removing the last element.
            RedemptionRequest memory req_ = pendingRedemptions[account][
                pendingRedemptions[account].length - 1
            ];
            req.amount = req_.amount;
            req.resolutionTimestampSec = req_.resolutionTimestampSec;
            pendingRedemptions[account].pop();
        }
    }

    /// @dev Enforces underlying to perp token swap volume under limits.
    function _enforcePerpSellLimit(uint256 perpAmtOut) private {
        _resetDailyVolume();
        dailyVolume.perpAmt += perpAmtOut;
        uint256 swapVolumePerc = ONE.mulDiv(
            dailyVolume.perpAmt,
            perp.balanceOf(address(this))
        );
        if (
            dailyVolume.perpAmt > perpSellLimit.amount ||
            swapVolumePerc > perpSellLimit.perc
        ) {
            revert SwapLimitExceeded();
        }
    }

    /// @dev Enforces perps to underlying token swap volume under limits.
    function _enforceUnderlyingSellLimit(uint256 underlyingAmtOut) private {
        _resetDailyVolume();
        dailyVolume.underlyingAmt += underlyingAmtOut;
        uint256 swapVolumePerc = ONE.mulDiv(
            dailyVolume.underlyingAmt,
            underlying.balanceOf(address(this))
        );
        if (
            dailyVolume.underlyingAmt > underlyingSellLimit.amount ||
            swapVolumePerc > underlyingSellLimit.perc
        ) {
            revert SwapLimitExceeded();
        }
    }

    /// @dev Resets daily volume book-keeping when in a new calendar day.
    function _resetDailyVolume() private {
        uint256 currentWindow = block.timestamp - (block.timestamp % DAY_SEC);
        if (currentWindow > dailyVolume.dayTimestamp) {
            dailyVolume = DailyVolume(currentWindow, 0, 0);
        }
    }
}
