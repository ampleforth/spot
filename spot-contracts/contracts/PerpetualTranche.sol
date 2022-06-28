// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { SignedMathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SignedMathUpgradeable.sol";

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";
import { SafeERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";

import { TrancheData, TrancheDataHelpers, BondHelpers } from "./_utils/BondHelpers.sol";

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IERC20MetadataUpgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/IERC20MetadataUpgradeable.sol";
import { ITranche } from "./_interfaces/buttonwood/ITranche.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";

import { IPerpetualTranche } from "./_interfaces/IPerpetualTranche.sol";
import { IBondIssuer } from "./_interfaces/IBondIssuer.sol";
import { IFeeStrategy } from "./_interfaces/IFeeStrategy.sol";
import { IPricingStrategy } from "./_interfaces/IPricingStrategy.sol";
import { IYieldStrategy } from "./_interfaces/IYieldStrategy.sol";

/// @notice Expected bond issuer to not be `address(0)`.
error UnacceptableBondIssuer();

/// @notice Expected fee strategy to not be `address(0)`.
error UnacceptableFeeStrategy();

/// @notice Expected pricing strategy to not be `address(0)`.
error UnacceptablePricingStrategy();

/// @notice Expected pricing strategy to return a fixed point with exactly {PRICE_DECIMALS} decimals.
error InvalidPricingStrategyDecimals();

/// @notice Expected yield strategy to not be `address(0)`.
error UnacceptableYieldStrategy();

/// @notice Expected yield strategy to return a fixed point with exactly {YIELD_DECIMALS} decimals.
error InvalidYieldStrategyDecimals();

/// @notice Expected skim percentage to be less than 100 with {PERC_DECIMALS}.
/// @param skimPerc The skim percentage.
error UnacceptableSkimPerc(uint256 skimPerc);

/// @notice Expected minTrancheMaturity be less than or equal to maxTrancheMaturity.
/// @param minTrancheMaturiySec Minimum tranche maturity time in seconds.
/// @param minTrancheMaturiySec Maximum tranche maturity time in seconds.
error InvalidTrancheMaturityBounds(uint256 minTrancheMaturiySec, uint256 maxTrancheMaturiySec);

/// @notice Expected transfer out asset to not be a reserve asset.
/// @param token Address of the token transferred.
error UnauthorizedTransferOut(IERC20Upgradeable token);

/// @notice Expected deposited tranche to be of current deposit bond.
/// @param trancheIn Address of the deposit tranche.
/// @param depositBond Address of the currently accepted deposit bond.
error UnacceptableDepositTranche(ITranche trancheIn, IBondController depositBond);

/// @notice Expected to mint a non-zero amount of tokens.
/// @param trancheInAmt The amount of tranche tokens deposited.
/// @param mintAmt The amount of tranche tokens mint.
error UnacceptableMintAmt(uint256 trancheInAmt, uint256 mintAmt);

/// @notice Expected to redeem current redemption tranche.
/// @param trancheOut Address of the withdrawn tranche.
/// @param redemptionTranche Address of the next tranche up for redemption.
error UnacceptableRedemptionTranche(ITranche trancheOut, ITranche redemptionTranche);

/// @notice Expected to burn a non-zero amount of tokens.
/// @param requestedBurnAmt The amount of tranche tokens requested to be burnt.
/// @param perpSupply The current supply of perp tokens.
error UnacceptableBurnAmt(uint256 requestedBurnAmt, uint256 perpSupply);

/// @notice Expected rollover to be acceptable.
/// @param trancheIn Address of the tranche token transferred in.
/// @param tokenOut Address of the reserve token transferred out.
error UnacceptableRollover(ITranche trancheIn, IERC20Upgradeable tokenOut);

/// @notice Expected to rollover a non-zero amount of tokens.
/// @param trancheInAmt The amount of tranche tokens deposited.
/// @param trancheOutAmt The amount of tranche tokens withdrawn.
/// @param rolloverAmt The perp denominated value of tokens rolled over.
error UnacceptableRolloverAmt(uint256 trancheInAmt, uint256 trancheOutAmt, uint256 rolloverAmt);

/// @notice Expected supply to be lower than the defined max supply.
/// @param newSupply The new total supply after minting.
/// @param currentMaxSupply The current max supply.
error ExceededMaxSupply(uint256 newSupply, uint256 currentMaxSupply);

/// @notice Expected the total mint amount per tranche to be lower than the limit.
/// @param trancheIn Address of the deposit tranche.
/// @param mintAmtForCurrentTranche The amount of perps that have been minted using the tranche.
/// @param maxMintAmtPerTranche The amount of perps that can be minted per tranche.
error ExceededMaxMintPerTranche(ITranche trancheIn, uint256 mintAmtForCurrentTranche, uint256 maxMintAmtPerTranche);

/// @notice Expected the system to have no tranches and have a collateral balance.
error InvalidRebootState();

/*
 *  @title PerpetualTranche
 *
 *  @notice An opinionated implementation of a perpetual note ERC-20 token contract, backed by buttonwood tranches.
 *
 *          Perpetual note tokens (or perps for short) are backed by tokens held in this contract's reserve.
 *          Users can mint perps by depositing tranche tokens into the reserve.
 *          They can redeem tokens from the reserve by burning their perps.
 *
 *          The whitelisted bond issuer issues new deposit bonds periodically based on a predefined frequency.
 *          Users can ONLY mint perps for tranche tokens belonging to the active "deposit" bond.
 *          Users can burn perps, and redeem a proportional share of tokens held in the reserve.
 *
 *          Once tranche tokens held in the reserve mature the underlying collateral is extracted
 *          into the reserve. The system keeps track of total mature tranches held by the reserve.
 *          This acts as an "implied" tranche balance for all collateral extracted from the mature tranches.
 *
 *          At any time, the reserve holds at most 2 classes of tokens
 *          ie) the tranche tokens and mature collateral.
 *
 *          Incentivized parties can "rollover" tranches approaching maturity or the mature collateral,
 *          for newer tranche tokens that belong to the current "depositBond".
 *
 *          The time dependent system state is updated "lazily" without a need for an explicit poke
 *          from the outside world. Every external function that deals with the reserve
 *          invokes the `afterStateUpdate` modifier at the entry-point.
 *          This brings the system storage state up to date.
 *
 */
contract PerpetualTranche is ERC20Upgradeable, OwnableUpgradeable, IPerpetualTranche {
    // math
    using MathUpgradeable for uint256;
    using SafeCastUpgradeable for uint256;
    using SignedMathUpgradeable for int256;

    // data handling
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.AddressSet;
    using BondHelpers for IBondController;
    using TrancheDataHelpers for TrancheData;

    // ERC20 operations
    using SafeERC20Upgradeable for IERC20Upgradeable;

    //-------------------------------------------------------------------------
    // Perp Math Basics:
    //
    // System holds tokens in the reserve {t1, t2 ... tn}
    // with balances {b1, b2 ... bn}.
    //
    // Internally reserve token denominations (amounts/balances) are
    // standardized using a yield factor.
    // Standard denomination: b'i = bi . yield(ti)
    //
    // Yield are typically expected to be ~1.0 for safe tranches,
    // but could be less for risker junior tranches.
    //
    //
    // System reserve value:
    // RV => t'1 . price(t1) + t'2 . price(t2) + .... + t'n . price(tn)
    //    => Σ t'i . price(ti)
    //
    //
    // When `ai` tokens of type `ti` are deposited into the system:
    // Mint: mintAmt (perps) => (a'i * price(ti) / RV) * supply(perps)
    //
    // This ensures that if 10% of the collateral value is deposited,
    // the minter receives 10% of the perp token supply.
    // This removes any race conditions for minters based on reserve state.
    //
    //
    // When `p` perp tokens are redeemed:
    // Redeem: ForEach ti => (p / supply(perps)) * bi
    //
    //
    // When `ai` tokens of type `ti` are rotated in for tokens of type `tj`:
    // Rotation: aj => ai * yield(ti) / yield(tj), ie) (a'i = a'j)
    //
    //-------------------------------------------------------------------------
    // Constants & Immutables
    uint8 public constant YIELD_DECIMALS = 18;
    uint256 public constant UNIT_YIELD = (10**YIELD_DECIMALS);

    uint8 public constant PRICE_DECIMALS = 8;
    uint256 public constant UNIT_PRICE = (10**PRICE_DECIMALS);

    uint8 public constant PERC_DECIMALS = 6;
    uint256 public constant UNIT_PERC = (10**PERC_DECIMALS);
    uint256 public constant HUNDRED_PERC = 100 * UNIT_PERC;

    //-------------------------------------------------------------------------
    // Storage

    //--------------------------------------------------------------------------
    // CONFIG

    // @notice External contract points to the fee token and computes mint, burn and rollover fees.
    IFeeStrategy public override feeStrategy;

    // @notice External contract that computes a given reserve token's price.
    // @dev The computed price is expected to be a fixed point unsigned integer with {PRICE_DECIMALS} decimals.
    IPricingStrategy public pricingStrategy;

    // @notice External contract that computes a given reserve token's yield.
    // @dev Yield is the discount or premium factor applied to every asset when added to
    //      the reserve. This accounts for things like tranche seniority and underlying
    //      collateral volatility. It also allows for standardizing denominations when comparing,
    //      two different reserve tokens.
    //      The computed yield is expected to be a fixed point unsigned integer with {YIELD_DECIMALS} decimals.
    IYieldStrategy public yieldStrategy;

    // @notice External contract that stores a predefined bond config and frequency,
    //         and issues new bonds when poked.
    // @dev Only tranches of bonds issued by this whitelisted issuer are accepted into the reserve.
    IBondIssuer public bondIssuer;

    // @notice The active deposit bond of whose tranches are currently being accepted to mint perps.
    IBondController private _depositBond;

    // @notice The minimum maturity time in seconds for a tranche below which
    //         it can be rolled over.
    uint256 public minTrancheMaturiySec;

    // @notice The maximum maturity time in seconds for a tranche above which
    //         it can NOT get added into the reserve.
    uint256 public maxTrancheMaturiySec;

    // @notice The maximum supply of perps that can exist at any given time.
    uint256 public maxSupply;

    // @notice The max number of perps that can be minted for each tranche in the minting bond.
    uint256 public maxMintAmtPerTranche;

    // @notice The percentage of the excess value the system retains on rotation.
    // @dev Skim percentage is stored as fixed point number with {PERC_DECIMALS}.
    uint256 public skimPerc;

    // @notice The total number of perps that have been minted using a given tranche.
    mapping(ITranche => uint256) private _mintedSupplyPerTranche;

    // @notice Yield factor actually "applied" on each reserve token. It is computed and recorded when
    //         a token is deposited into the system for the first time.
    // @dev For all calculations thereafter, the token's applied yield will be used.
    //      The yield is stored as a fixed point unsigned integer with {YIELD_DECIMALS} decimals.
    mapping(IERC20Upgradeable => uint256) private _appliedYields;

    //--------------------------------------------------------------------------
    // RESERVE

    // @notice Address of the "underlying" collateral token backing the tranches.
    // @dev ONLY tranches backed by this collateral token can be deposited into the reserve.
    //      Tranches which are not rotated out before maturity, are redeemed and this
    //      collateral is held in the reserve till its rotated out for tranches.
    //      The collateral token is expected to be a rebasing ERC-20.
    IERC20Upgradeable public override collateral;

    // @notice A record of all tranche tokens in the reserve which back the perps.
    EnumerableSetUpgradeable.AddressSet private _reserveTranches;

    // @notice The standardized amount of all tranches deposited into the system.
    uint256 private _stdTotalTrancheBalance;

    // @notice The standardized amount of all the mature tranches extracted and
    //         held as the collateral token.
    uint256 private _stdMatureTrancheBalance;

    //--------------------------------------------------------------------------
    // Modifiers
    modifier afterStateUpdate() {
        updateState();
        _;
    }

    //--------------------------------------------------------------------------
    // Construction & Initialization

    // @notice Contract state initialization.
    // @param name ERC-20 Name of the Perp token.
    // @param symbol ERC-20 Symbol of the Perp token.
    // @param collateral_ Address of the underlying collateral token.
    // @param bondIssuer_ Address of the bond issuer contract.
    // @param feeStrategy_ Address of the fee strategy contract.
    // @param pricingStrategy_ Address of the pricing strategy contract.
    // @param yieldStrategy_ Address of the yield strategy contract.
    function init(
        string memory name,
        string memory symbol,
        IERC20Upgradeable collateral_,
        IBondIssuer bondIssuer_,
        IFeeStrategy feeStrategy_,
        IPricingStrategy pricingStrategy_,
        IYieldStrategy yieldStrategy_
    ) public initializer {
        __ERC20_init(name, symbol);
        __Ownable_init();

        collateral = collateral_;
        _applyYield(collateral_, UNIT_YIELD);

        updateBondIssuer(bondIssuer_);
        updateFeeStrategy(feeStrategy_);
        updatePricingStrategy(pricingStrategy_);
        updateYieldStrategy(yieldStrategy_);

        minTrancheMaturiySec = 1;
        maxTrancheMaturiySec = type(uint256).max;

        maxSupply = 1000000 * (10**decimals()); // 1M
        maxMintAmtPerTranche = 200000 * (10**decimals()); // 200k
    }

    //--------------------------------------------------------------------------
    // ADMIN only methods

    // @notice Update the reference to the bond issuer contract.
    // @param bondIssuer_ New bond issuer address.
    function updateBondIssuer(IBondIssuer bondIssuer_) public onlyOwner {
        if (address(bondIssuer_) == address(0)) {
            revert UnacceptableBondIssuer();
        }
        bondIssuer = bondIssuer_;
        emit UpdatedBondIssuer(bondIssuer_);
    }

    // @notice Update the reference to the fee strategy contract.
    // @param feeStrategy_ New strategy address.
    function updateFeeStrategy(IFeeStrategy feeStrategy_) public onlyOwner {
        if (address(feeStrategy_) == address(0)) {
            revert UnacceptableFeeStrategy();
        }
        feeStrategy = feeStrategy_;
        emit UpdatedFeeStrategy(feeStrategy_);
    }

    // @notice Update the reference to the pricing strategy contract.
    // @param pricingStrategy_ New strategy address.
    function updatePricingStrategy(IPricingStrategy pricingStrategy_) public onlyOwner {
        if (address(pricingStrategy_) == address(0)) {
            revert UnacceptablePricingStrategy();
        }
        if (pricingStrategy_.decimals() != PRICE_DECIMALS) {
            revert InvalidPricingStrategyDecimals();
        }
        pricingStrategy = pricingStrategy_;
        emit UpdatedPricingStrategy(pricingStrategy_);
    }

    // @notice Update the reference to the yield strategy contract.
    // @param yieldStrategy_ New strategy address.
    function updateYieldStrategy(IYieldStrategy yieldStrategy_) public onlyOwner {
        if (address(yieldStrategy_) == address(0)) {
            revert UnacceptableYieldStrategy();
        }
        if (yieldStrategy_.decimals() != YIELD_DECIMALS) {
            revert InvalidYieldStrategyDecimals();
        }
        yieldStrategy = yieldStrategy_;
        emit UpdatedYieldStrategy(yieldStrategy_);
    }

    // @notice Update the maturity tolerance parameters.
    // @param minTrancheMaturiySec_ New minimum maturity time.
    // @param maxTrancheMaturiySec_ New maximum maturity time.
    function updateTolerableTrancheMaturiy(uint256 minTrancheMaturiySec_, uint256 maxTrancheMaturiySec_)
        external
        onlyOwner
    {
        if (minTrancheMaturiySec_ > maxTrancheMaturiySec_) {
            revert InvalidTrancheMaturityBounds(minTrancheMaturiySec_, maxTrancheMaturiySec_);
        }
        minTrancheMaturiySec = minTrancheMaturiySec_;
        maxTrancheMaturiySec = maxTrancheMaturiySec_;
        emit UpdatedTolerableTrancheMaturiy(minTrancheMaturiySec_, maxTrancheMaturiySec_);
    }

    // @notice Update parameters controlling the perp token mint limits.
    // @param maxSupply_ New max total supply.
    // @param maxMintAmtPerTranche_ New max total for per tranche in minting bond.
    function updateMintingLimits(uint256 maxSupply_, uint256 maxMintAmtPerTranche_) external onlyOwner {
        maxSupply = maxSupply_;
        maxMintAmtPerTranche = maxMintAmtPerTranche_;
        emit UpdatedMintingLimits(maxSupply_, maxMintAmtPerTranche_);
    }

    // @notice Updates the skim percentage parameter.
    // @param skimPerc_ New skim percentage.
    function updateSkimPerc(uint256 skimPerc_) external onlyOwner {
        if (skimPerc_ > HUNDRED_PERC) {
            revert UnacceptableSkimPerc(skimPerc_);
        }
        skimPerc = skimPerc_;
        emit UpdatedSkimPerc(skimPerc_);
    }

    // @notice Allows the owner to transfer non-reserve assets out of the system if required.
    // @param token The token address.
    // @param to The destination address.
    // @param amount The amount of tokens to be transferred.
    function transferERC20(
        IERC20Upgradeable token,
        address to,
        uint256 amount
    ) external onlyOwner {
        if (isReserveToken(token)) {
            revert UnauthorizedTransferOut(token);
        }
        token.safeTransfer(to, amount);
    }

    // @notice Allows the owner to update the tranche balances to reboot rollovers.
    // @param stdTrancheBalance The new tranche balance.
    // @dev When the system moves into a state where it just holds mature collateral
    //      such that the collateral balance is below the `stdMatureTrancheBalance`,
    //      rolling over will become unprofitable as it will involve redeeming
    //      collateral for tranches at a premium (say 0.5 collateral token for
    //      1 collateral token worth tranche). The contract owner can "re-denominate"
    //      the internal tranche balances, effectively resetting the
    //      difference between the tranche and collateral balances
    //      thus allowing rollovers 1:1 again.
    function reboot(uint256 stdTrancheBalance) external onlyOwner {
        // The reboot is only allowed when:
        //  - the system has no more tranches left i.e) all the tranches have mature
        //  - the system has a collateral balance
        if (reserveCount() > 1 || _tokenBalance(collateral) == 0) {
            revert InvalidRebootState();
        }
        _stdTotalTrancheBalance = stdTrancheBalance;
        _stdMatureTrancheBalance = stdTrancheBalance;
        emit UpdatedStdTrancheBalances(stdTrancheBalance, stdTrancheBalance);
    }

    //--------------------------------------------------------------------------
    // External methods

    /// @inheritdoc IPerpetualTranche
    function deposit(ITranche trancheIn, uint256 trancheInAmt) external override afterStateUpdate {
        if (IBondController(trancheIn.bond()) != _depositBond) {
            revert UnacceptableDepositTranche(trancheIn, _depositBond);
        }

        // calculates the amount of perp tokens when depositing `trancheInAmt` of tranche tokens
        (uint256 mintAmt, uint256 stdTrancheInAmt) = computeMintAmt(trancheIn, trancheInAmt);
        if (trancheInAmt == 0 || mintAmt == 0) {
            revert UnacceptableMintAmt(stdTrancheInAmt, mintAmt);
        }

        // calculates the fee to mint `mintAmt` of perp token
        int256 mintFee = feeStrategy.computeMintFee(mintAmt);

        // transfers tranche tokens from the sender to the reserve
        _transferIntoReserve(_msgSender(), trancheIn, trancheInAmt);

        // updates reserve's tranche balance
        _stdTotalTrancheBalance += stdTrancheInAmt;
        emit UpdatedStdTrancheBalances(_stdTotalTrancheBalance, _stdMatureTrancheBalance);

        // mints perp tokens to the sender
        _mint(_msgSender(), mintAmt);

        // settles fees
        _settleFee(_msgSender(), mintFee);

        // updates the supply minted using the given tranche
        _mintedSupplyPerTranche[trancheIn] += mintAmt;

        // enforces supply cap and tranche mint cap
        _enforceMintingLimits(trancheIn);
    }

    /// @inheritdoc IPerpetualTranche
    function burn(uint256 perpAmtBurnt) external override afterStateUpdate {
        // gets the current perp supply
        uint256 perpSupply = totalSupply();

        // verifies if burn amount is acceptable
        if (perpAmtBurnt == 0 || perpAmtBurnt > perpSupply) {
            revert UnacceptableBurnAmt(perpAmtBurnt, perpSupply);
        }

        // calculates the fee to burn `perpAmtBurnt` of perp token
        int256 burnFee = feeStrategy.computeBurnFee(perpAmtBurnt);

        // calculates share of reserve tokens to be redeemed
        (IERC20Upgradeable[] memory tokensOuts, uint256[] memory tokenOutAmts) = computeRedemptionAmts(perpAmtBurnt);

        // burns perp tokens from the sender
        _burn(_msgSender(), perpAmtBurnt);

        // settles fees
        _settleFee(_msgSender(), burnFee);

        // transfers reserve tokens out
        for (uint256 i = 0; i < tokensOuts.length; i++) {
            if (tokenOutAmts[i] > 0) {
                _transferOutOfReserve(_msgSender(), tokensOuts[i], tokenOutAmts[i]);
            }
        }

        // updates reserve's tranche balances
        _stdTotalTrancheBalance -= _perpsToReserveShare(perpAmtBurnt, perpSupply, _stdTotalTrancheBalance);
        _stdMatureTrancheBalance -= _perpsToReserveShare(perpAmtBurnt, perpSupply, _stdMatureTrancheBalance);
        emit UpdatedStdTrancheBalances(_stdTotalTrancheBalance, _stdMatureTrancheBalance);
    }

    /// @inheritdoc IPerpetualTranche
    function rollover(
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmtRequested
    ) external override afterStateUpdate {
        if (!_isAcceptableRollover(trancheIn, tokenOut)) {
            revert UnacceptableRollover(trancheIn, tokenOut);
        }

        // calculates the perp denominated amount rolled over and the tokenOutAmt
        IPerpetualTranche.RolloverPreview memory r = computeRolloverAmt(
            trancheIn,
            tokenOut,
            trancheInAmtRequested,
            type(uint256).max
        );

        // verifies if rollover amount is acceptable
        if (r.trancheInAmtUsed == 0 || r.tokenOutAmt == 0 || r.perpRolloverAmt == 0) {
            revert UnacceptableRolloverAmt(r.trancheInAmtUsed, r.tokenOutAmt, r.perpRolloverAmt);
        }

        // calculates the fee to rollover `r.perpRolloverAmt` of perp token
        int256 rolloverFee = feeStrategy.computeRolloverFee(r.perpRolloverAmt);

        // transfers tranche tokens from the sender to the reserve
        _transferIntoReserve(_msgSender(), trancheIn, r.trancheInAmtUsed);

        // settles fees
        _settleFee(_msgSender(), rolloverFee);

        // transfers tranche from the reserve to the sender
        _transferOutOfReserve(_msgSender(), tokenOut, r.tokenOutAmt);

        // updates reserve's tranche balance
        // NOTE: `_stdTotalTrancheBalance` does not change on rollovers as `stdTrancheInAmt` == `stdTrancheOutAmt`
        if (tokenOut == collateral) {
            _stdMatureTrancheBalance -= r.stdTrancheRolloverAmt;
            emit UpdatedStdTrancheBalances(_stdTotalTrancheBalance, _stdMatureTrancheBalance);
        }
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Used in case an altruistic party intends to increase the collaterlization ratio.
    function burnWithoutRedemption(uint256 amount) external override returns (bool) {
        _burn(_msgSender(), amount);
        return true;
    }

    /// @inheritdoc IPerpetualTranche
    function getStdTrancheBalances() external override afterStateUpdate returns (uint256, uint256) {
        return (_stdTotalTrancheBalance, _stdMatureTrancheBalance);
    }

    /// @inheritdoc IPerpetualTranche
    function getDepositBond() external override afterStateUpdate returns (IBondController) {
        return _depositBond;
    }

    /// @inheritdoc IPerpetualTranche
    function isAcceptableRollover(ITranche trancheIn, IERC20Upgradeable tokenOut)
        external
        override
        afterStateUpdate
        returns (bool)
    {
        return _isAcceptableRollover(trancheIn, tokenOut);
    }

    //--------------------------------------------------------------------------
    // Public methods

    /// @inheritdoc IPerpetualTranche
    // @dev Lazily updates time-dependent reserve storage state.
    //      This function is to be invoked on all external function entry points which are
    //      read the reserve storage. This function is intended to be idempotent.
    function updateState() public override {
        // Lazily queries the bond issuer to get the most recently issued bond
        // and updates with the new deposit bond if it's "acceptable".
        IBondController newBond = bondIssuer.getLatestBond();

        // If the new bond has been issued by the issuer and is "acceptable"
        if (_depositBond != newBond && _isAcceptableForReserve(newBond)) {
            // updates `_depositBond` with the new bond
            _depositBond = newBond;
            emit UpdatedDepositBond(newBond);
        }

        // Lazily checks if every reserve tranche has reached maturity.
        // If so redeems the tranche balance for the underlying collateral and
        // removes the tranche from the reserve list.
        // NOTE: We traverse the reserve list in the reverse order
        //       as deletions involve swapping the deleted element to the
        //       end of the list and removing the last element.
        //       We also skip the `reserveAt(0)`, ie the mature tranche,
        //       which is never removed.
        uint256 reserveCount_ = reserveCount();
        for (uint256 i = reserveCount_ - 1; i > 0; i--) {
            ITranche tranche = ITranche(address(reserveAt(i)));
            IBondController bond = IBondController(tranche.bond());

            // If bond is not mature yet, move to the next tranche
            if (bond.timeToMaturity() > 0) {
                continue;
            }

            // If bond has reached maturity but hasn't been poked
            if (!bond.isMature()) {
                bond.mature();
            }

            // Redeeming collateral
            uint256 trancheBalance = _tokenBalance(tranche);
            bond.redeemMature(address(tranche), trancheBalance);
            _syncReserve(tranche);

            // Keeps track of the total tranches redeemed
            _stdMatureTrancheBalance += _toStdTrancheAmt(trancheBalance, computeYield(tranche));
            emit UpdatedStdTrancheBalances(_stdTotalTrancheBalance, _stdMatureTrancheBalance);
        }

        // Keeps track of reserve's rebasing collateral token balance
        _syncReserve(collateral);
    }

    //--------------------------------------------------------------------------
    // External view methods

    /// @inheritdoc IPerpetualTranche
    function reserve() external view override returns (address) {
        return _self();
    }

    /// @inheritdoc IPerpetualTranche
    function feeCollector() external view override returns (address) {
        return _self();
    }

    /// @inheritdoc IPerpetualTranche
    function reserveBalance(IERC20Upgradeable token) external view override returns (uint256) {
        return isReserveToken(token) ? token.balanceOf(_self()) : 0;
    }

    //--------------------------------------------------------------------------
    // Public view methods

    /// @inheritdoc IPerpetualTranche
    function feeToken() public view override returns (IERC20Upgradeable) {
        return feeStrategy.feeToken();
    }

    /// @inheritdoc IPerpetualTranche
    // @dev The reserve comprises of the list of tranches and the mature collateral.
    //      The `reserveCount` will always be 1 even if it's empty.
    function reserveCount() public view override returns (uint256) {
        return _reserveTranches.length() + 1;
    }

    /// @inheritdoc IPerpetualTranche
    function reserveAt(uint256 i) public view override returns (IERC20Upgradeable) {
        return (i == 0) ? collateral : IERC20Upgradeable(_reserveTranches.at(i - 1));
    }

    /// @inheritdoc IPerpetualTranche
    function isReserveToken(IERC20Upgradeable token) public view override returns (bool) {
        return isReserveTranche(token) || token == collateral;
    }

    /// @inheritdoc IPerpetualTranche
    function isReserveTranche(IERC20Upgradeable tranche) public view override returns (bool) {
        return _reserveTranches.contains(address(tranche));
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Returns a fixed point with {PRICE_DECIMALS} decimals.
    function reserveValue() public view override returns (uint256) {
        uint256 totalVal = 0;
        for (uint256 i = 0; i < reserveCount(); i++) {
            IERC20Upgradeable token = reserveAt(i);
            uint256 stdTokenAmt = _toStdTrancheAmt(_tokenBalance(token), computeYield(token));
            totalVal += (stdTokenAmt * computePrice(token));
        }
        return totalVal;
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Gets the applied yield for the given tranche if it's set,
    //      if NOT computes the yield.
    function computeYield(IERC20Upgradeable token) public view override returns (uint256) {
        uint256 yield = _appliedYields[token];
        return (yield > 0) ? yield : yieldStrategy.computeYield(token);
    }

    /// @inheritdoc IPerpetualTranche
    function computePrice(IERC20Upgradeable token) public view override returns (uint256) {
        return
            (token == collateral)
                ? pricingStrategy.computeMatureTranchePrice(token, _tokenBalance(token), _stdMatureTrancheBalance)
                : pricingStrategy.computeTranchePrice(ITranche(address(token)));
    }

    /// @inheritdoc IPerpetualTranche
    function computeMintAmt(ITranche trancheIn, uint256 trancheInAmt) public view override returns (uint256, uint256) {
        uint256 totalSupply_ = totalSupply();
        uint256 stdTrancheAmt = _toStdTrancheAmt(trancheInAmt, computeYield(trancheIn));
        uint256 price = computePrice(trancheIn);
        uint256 mintAmt = (totalSupply_ > 0)
            ? (stdTrancheAmt * totalSupply_ * price) / reserveValue()
            : (stdTrancheAmt * price) / UNIT_PRICE;
        return (mintAmt, stdTrancheAmt);
    }

    /// @inheritdoc IPerpetualTranche
    function computeRedemptionAmts(uint256 perpAmtBurnt)
        public
        view
        override
        returns (IERC20Upgradeable[] memory, uint256[] memory)
    {
        uint256 totalSupply_ = totalSupply();
        uint256 reserveCount_ = reserveCount();
        IERC20Upgradeable[] memory reserveTokens = new IERC20Upgradeable[](reserveCount_);
        uint256[] memory redemptionAmts = new uint256[](reserveCount_);
        for (uint256 i = 0; i < reserveCount_; i++) {
            reserveTokens[i] = reserveAt(i);
            redemptionAmts[i] = _perpsToReserveShare(perpAmtBurnt, totalSupply_, _tokenBalance(reserveTokens[i]));
        }
        return (reserveTokens, redemptionAmts);
    }

    /// @inheritdoc IPerpetualTranche
    // @dev Set `maxTokenOutAmtCovered` to max(uint256) to use the reserve balance.
    function computeRolloverAmt(
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmtRequested,
        uint256 maxTokenOutAmtCovered
    ) public view override returns (IPerpetualTranche.RolloverPreview memory) {
        uint256 trancheInYield = computeYield(trancheIn);
        uint256 tokenOutYield = computeYield(tokenOut);
        uint256 trancheInPrice = computePrice(trancheIn);
        uint256 tokenOutPrice = computePrice(tokenOut);

        IPerpetualTranche.RolloverPreview memory r;
        if (trancheInYield == 0 || tokenOutYield == 0 || trancheInPrice == 0 || tokenOutPrice == 0) {
            r.remainingTrancheInAmt = trancheInAmtRequested;
            return r;
        }

        uint256 tokenOutBalance = _tokenBalance(tokenOut);
        maxTokenOutAmtCovered = MathUpgradeable.min(maxTokenOutAmtCovered, tokenOutBalance);

        r.trancheInAmtUsed = trancheInAmtRequested;
        r.stdTrancheRolloverAmt = _toStdTrancheAmt(trancheInAmtRequested, trancheInYield);

        // In the case token out is the mature tranche (held as naked collateral):
        // Token balance is calculated from the tranche denomination
        uint256 trancheOutAmt = _fromStdTrancheAmt(r.stdTrancheRolloverAmt, tokenOutYield);
        r.tokenOutAmt = (tokenOut == collateral)
            ? ((trancheOutAmt * tokenOutBalance) / _stdMatureTrancheBalance)
            : trancheOutAmt;

        // When the token out balance is NOT covered
        if (r.tokenOutAmt > maxTokenOutAmtCovered) {
            r.tokenOutAmt = maxTokenOutAmtCovered;
            r.stdTrancheRolloverAmt = (tokenOut == collateral)
                ? ((r.tokenOutAmt * _stdMatureTrancheBalance) / tokenOutBalance)
                : _toStdTrancheAmt(r.tokenOutAmt, tokenOutYield);
            r.trancheInAmtUsed = _fromStdTrancheAmt(r.stdTrancheRolloverAmt, trancheInYield);
        }

        // When the rollover is measured as extractive (i.e valueOut > valueIn),
        // the system skims a portion of the excess value.
        if (skimPerc > 0) {
            uint256 valueIn = r.trancheInAmtUsed * trancheInPrice;
            uint256 valueOut = r.tokenOutAmt * tokenOutPrice;
            if (valueOut > valueIn) {
                uint256 adjustedValueOut = valueOut - ((skimPerc * (valueOut - valueIn)) / HUNDRED_PERC);
                r.tokenOutAmt = (r.tokenOutAmt * adjustedValueOut) / valueOut;
            }
        }

        r.perpRolloverAmt = (r.stdTrancheRolloverAmt * totalSupply()) / _stdTotalTrancheBalance;
        r.remainingTrancheInAmt = trancheInAmtRequested - r.trancheInAmtUsed;
        return r;
    }

    // @notice Returns the number of decimals used to get its user representation.
    // @dev For example, if `decimals` equals `2`, a balance of `505` tokens should
    //      be displayed to a user as `5.05` (`505 / 10 ** 2`).
    function decimals() public view override returns (uint8) {
        return IERC20MetadataUpgradeable(address(collateral)).decimals();
    }

    //--------------------------------------------------------------------------
    // Private/Internal helper methods

    // @dev Transfers tokens from the given address to self and updates the reserve list.
    // @return Reserve's token balance after transfer in.
    function _transferIntoReserve(
        address from,
        IERC20Upgradeable token,
        uint256 trancheAmt
    ) internal returns (uint256) {
        token.safeTransferFrom(from, _self(), trancheAmt);
        return _syncReserve(token);
    }

    // @dev Transfers tokens from self into the given address and updates the reserve list.
    // @return Reserve's token balance after transfer out.
    function _transferOutOfReserve(
        address to,
        IERC20Upgradeable token,
        uint256 tokenAmt
    ) internal returns (uint256) {
        if (tokenAmt > 0) {
            token.safeTransfer(to, tokenAmt);
        }
        return _syncReserve(token);
    }

    // @dev Keeps the reserve storage up to date. Logs the token balance held by the reserve.
    // @return The Reserve's token balance.
    function _syncReserve(IERC20Upgradeable token) internal returns (uint256) {
        uint256 balance = _tokenBalance(token);
        emit ReserveSynced(token, balance);

        // If token is a tranche
        if (token != collateral) {
            bool isReserveTranche_ = isReserveTranche(token);
            if (balance > 0 && !isReserveTranche_) {
                // Inserts new tranche into reserve list.
                _reserveTranches.add(address(token));

                // Stores the yield for future usage.
                _applyYield(token, computeYield(token));
            }

            if (balance == 0 && isReserveTranche_) {
                // Removes tranche from reserve list.
                _reserveTranches.remove(address(token));

                // Frees up stored yield.
                _applyYield(token, 0);

                // Frees up minted supply.
                delete _mintedSupplyPerTranche[ITranche(address(token))];
            }
        }

        return balance;
    }

    // @dev If the fee is positive, fee is transferred from the payer to the self
    //      else it's transferred to the payer from the self.
    //      NOTE: fee is a not-reserve asset.
    // @return True if the fee token used for settlement is the perp token.
    function _settleFee(address payer, int256 fee) internal returns (bool isNativeFeeToken) {
        IERC20Upgradeable feeToken_ = feeToken();
        isNativeFeeToken = (address(feeToken_) == _self());

        if (fee == 0) {
            return isNativeFeeToken;
        }

        uint256 fee_ = fee.abs();
        if (fee > 0) {
            // Funds are coming in
            // Handling a special case, when the fee is to be charged as the perp token itself
            // In this case we don't need to make an external call to the token ERC-20 to "transferFrom"
            // the payer, since this is still an internal call {msg.sender} will still point to the payer
            // and we can just "transfer" from the payer's wallet.
            if (isNativeFeeToken) {
                transfer(_self(), fee_);
            } else {
                feeToken_.safeTransferFrom(payer, _self(), fee_);
            }
        } else {
            // Funds are going out
            feeToken_.safeTransfer(payer, fee_);
        }

        return isNativeFeeToken;
    }

    // @dev Updates contract store with provided yield.
    function _applyYield(IERC20Upgradeable token, uint256 yield) private {
        if (yield > 0) {
            _appliedYields[token] = yield;
        } else {
            delete _appliedYields[token];
        }
        emit YieldApplied(token, yield);
    }

    // @dev Checks if the given token pair is a valid rollover.
    //      * When rolling out mature collateral,
    //          - expects incoming tranche to be part of the deposit bond
    //      * When rolling out immature tranches,
    //          - expects incoming tranche to be part of the deposit bond
    //          - expects outgoing tranche to not be part of the deposit bond
    //          - expects outgoing tranche to be in the reserve
    //          - expects outgoing bond to not be "acceptable" any more
    function _isAcceptableRollover(ITranche trancheIn, IERC20Upgradeable tokenOut) internal view returns (bool) {
        IBondController bondIn = IBondController(trancheIn.bond());

        // when rolling out the mature collateral
        if (tokenOut == collateral) {
            return (bondIn == _depositBond);
        }

        // when rolling out an immature tranche
        ITranche trancheOut = ITranche(address(tokenOut));
        IBondController bondOut = IBondController(trancheOut.bond());
        return (bondIn == _depositBond &&
            bondOut != _depositBond &&
            isReserveTranche(trancheOut) &&
            !_isAcceptableForReserve(bondOut));
    }

    // @dev Checks if the bond's tranches can be accepted into the reserve.
    //      * Expects the bond to to have the same collateral token as perp.
    //      * Expects the bond's maturity to be within expected bounds.
    // @return True if the bond is "acceptable".
    function _isAcceptableForReserve(IBondController bond) internal view returns (bool) {
        // NOTE: `timeToMaturity` will be 0 if the bond is past maturity.
        uint256 timeToMaturity = bond.timeToMaturity();
        return (address(collateral) == bond.collateralToken() &&
            timeToMaturity >= minTrancheMaturiySec &&
            timeToMaturity < maxTrancheMaturiySec);
    }

    // @dev Enforces the mint limits. To be invoked AFTER the mint operation.
    function _enforceMintingLimits(ITranche trancheIn) private view {
        // checks if new total supply is within the max supply cap
        uint256 newSupply = totalSupply();
        if (newSupply > maxSupply) {
            revert ExceededMaxSupply(newSupply, maxSupply);
        }

        // checks if supply minted using the given tranche is within the cap
        if (_mintedSupplyPerTranche[trancheIn] > maxMintAmtPerTranche) {
            revert ExceededMaxMintPerTranche(trancheIn, _mintedSupplyPerTranche[trancheIn], maxMintAmtPerTranche);
        }
    }

    // @dev Fetches the perp contract's token balance.
    function _tokenBalance(IERC20Upgradeable token) private view returns (uint256) {
        return token.balanceOf(_self());
    }

    // @dev Alias to self.
    function _self() private view returns (address) {
        return address(this);
    }

    // @dev Calculates the standardized tranche amount for internal book keeping.
    //      stdTrancheAmt = (trancheAmt * yield).
    function _toStdTrancheAmt(uint256 trancheAmt, uint256 yield) private pure returns (uint256) {
        return ((trancheAmt * yield) / UNIT_YIELD);
    }

    // @dev Calculates the external tranche amount from the internal standardized tranche amount.
    //      trancheAmt = stdTrancheAmt / yield.
    function _fromStdTrancheAmt(uint256 stdTrancheAmt, uint256 yield) private pure returns (uint256) {
        return ((stdTrancheAmt * UNIT_YIELD) / yield);
    }

    // @dev Calculates share of the reserve's balance redeemable for given perp amount.
    //      tokenAmt = (perpAmt * reserveBalance_) / perpSupply
    function _perpsToReserveShare(
        uint256 perpAmt,
        uint256 perpSupply,
        uint256 reserveBalance_
    ) private pure returns (uint256) {
        return ((perpAmt * reserveBalance_) / (perpSupply));
    }
}
