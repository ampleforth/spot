// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import { SignedMath } from "@openzeppelin/contracts/utils/math/SignedMath.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { TrancheData, BondHelpers, TrancheDataHelpers } from "./_utils/BondHelpers.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPerpetualTranche } from "./_interfaces/IPerpetualTranche.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";
import { ITranche } from "./_interfaces/buttonwood/ITranche.sol";

// TODO: Vault to Implement I4626
// TODO: emit events
/*
 *  @title RolloverVault
 *
 *  @notice An opinionated vault strategy which provides leveraged exposure to the underlying asset (say AMPL)
 *          by performing rollover operations for the perpetual safe tranche (perp contract).
 *
 *          This strategy tranches AMPL using the perp contract's minting bond to A-Z tranches.
 *          It swaps the newly minted safe tranches (A-Y) for older safe tranches (A-Y) which
 *          immediately (or in the near future) are redeemable for AMPL.
 *
 *          This is essentially tranching AMPL and exchanging the safe tranches for more AMPL.
 *          The perp contract pays a reward for each rotation operation
 *          which is distributed to LPs of this vault as yield.
 *
 */
contract RolloverVault is ERC20 {
    using SignedMath for int256;
    using EnumerableSet for EnumerableSet.AddressSet;
    using SafeERC20 for IERC20;
    using BondHelpers for IBondController;

    //-------------------------------------------------------------------------
    // Constants & Immutables
    uint8 public constant PERC_DECIMALS = 6;

    // @dev Initial exchange rate between vault shares and underlying tokens.
    uint256 private constant INITIAL_RATE = 10**6;

    //-------------------------------------------------------------------------
    // Data

    // @notice List of bonds whose tranches are currently held by the system.
    // @dev Updated when a new tranche is added or removed or during rollovers.
    EnumerableSet.AddressSet private _reserveBonds;

    // @notice Address of the underlying token accepted by this vault.
    IERC20 public underlying;

    // @notice Address of the perpetual tranche contract on which roll over operations are to be performed.
    IPerpetualTranche public perp;

    // @notice The percentage of the reserve's assets to be held as naked collateral
    //         the rest are held as tranches.
    uint256 public targetCashPerc;

    // @notice The system only rolls over bonds which are about to mature within this amount of time.
    // @dev This reduces any volatility risk the system takes on by controlling the time
    //      it obtains the bonds, to the time it matures.
    uint256 public maxTimeToMaturitySec;

    // @notice Constructor to create the contract.
    // solhint-disable-next-line no-empty-blocks
    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    //--------------------------------------------------------------------------
    // External methods

    // @notice Mints tranches by depositing the underlying token into the perp contract's active minting bond.
    // TODO: can we run into a spam when someone just keep tranching assets held in the _reserve()?
    //       they can be un-tranched using the redeem method if this happens.
    function mintTranches(uint256 uAmount) external {
        IBondController bond = perp.getMintingBond();
        TrancheData memory td = bond.getTrancheData();

        require(
            td.collateralToken == address(underlying),
            "Expected bond collateral to be the vault's underlying token"
        );

        underlying.approve(address(bond), uAmount);
        bond.deposit(uAmount);
        _syncReserve(bond, td);

        _validateReserve();
    }

    // @notice Rolls over older tranches held by the perp contract for more recently tranched ones.
    function rolloverTranches(
        ITranche trancheIn,
        ITranche trancheOut,
        uint256 trancheInAmt,
        int256 reward
    ) external {
        IBondController bondIn = IBondController(trancheIn.bond());
        IBondController bondOut = IBondController(trancheOut.bond());

        TrancheData memory bondInTrancheData = bondIn.getTrancheData();
        TrancheData memory bondOutTrancheData = bondOut.getTrancheData();

        require(bondOut.timeToMaturity() <= maxTimeToMaturitySec, "Expected bondOut maturity to be closer");

        trancheIn.approve(address(perp), trancheInAmt);
        if (reward < 0) {
            // if a fee is to be paid
            perp.rewardToken().approve(address(perp), reward.abs());
        }
        perp.rollover(trancheIn, trancheOut, trancheInAmt);

        _syncReserve(bondIn, bondInTrancheData);
        _syncReserve(bondOut, bondOutTrancheData);
    }

    // @notice Redeems tranches held by the reserve for the underlying token.
    // @dev Expected the reserve to hold all the tranches in the parent bond's desired ratio
    //      to reconstruct the collateral completely.
    function redeem(IBondController bond, uint256[] memory trancheAmts) external {
        bond.redeem(trancheAmts);
        _syncReserve(bond, bond.getTrancheData());
    }

    // @notice Redeems the mature tranches held by the reserve for the underlying token.
    // @dev Reverts if tranche's parent bond is not mature.
    function redeemMature(IBondController bond) external {
        if (!bond.isMature()) {
            bond.mature();
        }
        TrancheData memory td = bond.getTrancheData();
        for (uint8 i = 0; i < td.trancheCount; i++) {
            bond.redeemMature(address(td.tranches[i]), td.tranches[i].balanceOf(_reserve()));
        }
        _syncReserve(bond, td);
    }

    // @notice Deposits the underlying token into the vault to mint vault shares.
    function deposit(uint256 uAmount) external returns (uint256) {
        uint256 shares = _uAmountToShares(uAmount, _getTotalAssets(), totalSupply());

        underlying.safeTransferFrom(_msgSender(), _reserve(), uAmount);

        _mint(_msgSender(), shares);

        return shares;
    }

    // @notice Withdraws the underlying token and reward from the vault by burning shares.
    function withdraw(uint256 uAmount) external returns (uint256, uint256) {
        uint256 totalSupply_ = totalSupply();
        uint256 shares = _uAmountToShares(uAmount, _getTotalAssets(), totalSupply_);

        uint256 reward = _rewardShare(shares, _getTotalIncome(), totalSupply_);

        _burn(_msgSender(), shares);

        perp.rewardToken().safeTransfer(_msgSender(), reward);
        underlying.safeTransfer(_msgSender(), uAmount);

        _validateReserve();

        return (shares, reward);
    }

    //--------------------------------------------------------------------------
    // External view methods

    // @notice Total assets currently managed by the vault, which includes assets held as cash
    //         and tranched positions.
    function totalAssets() external view returns (uint256) {
        return _getTotalAssets();
    }

    // @notice Total income generated by the vault currently held in the reserve.
    function totalIncome() external view returns (uint256) {
        return _getTotalIncome();
    }

    //--------------------------------------------------------------------------
    // Private/Internal helper methods

    // @dev Runs check to ensure that the reserve has enough cash holdings.
    function _validateReserve() private {
        // NOTE: this is expensive, recomputing _getTotalAssets()
        // This can be optimized.
        require(
            _currentCashPerc(_getTotalAssets()) > targetCashPerc,
            "Expect cash percentage to be greater than target"
        );
    }

    // @dev Updates the list of bonds held in the reserve.
    function _syncReserve(IBondController bond, TrancheData memory td) private {
        bool hasTrancheBalance = false;
        for (uint8 i = 0; i < td.trancheCount && !hasTrancheBalance; i++) {
            hasTrancheBalance = hasTrancheBalance || (td.tranches[i].balanceOf(_reserve()) > 0);
        }

        if (hasTrancheBalance && !_reserveBonds.contains(address(bond))) {
            _reserveBonds.add(address(bond));
        }

        if (!hasTrancheBalance && _reserveBonds.contains(address(bond))) {
            _reserveBonds.remove(address(bond));
        }

        // emit event
    }

    // @dev The reserve holds underling tokens as cash and tranches positions
    //      which are redeemable for underlying tokens at maturity.
    //      This methods computes the total assets as the sum of the reserve's
    //      underlying token balance (i.e cash position) and
    //      the collateral balance of every tranche position.
    // NOTE: think about if we need more sophisticated pricing methods here and
    // what are the potential pitfalls?
    function _getTotalAssets() private view returns (uint256) {
        uint256 totalAssets_ = underlying.balanceOf(_reserve());
        for (uint256 i = 0; i < _reserveBonds.length(); i++) {
            IBondController bond = IBondController(_reserveBonds.at(i));
            (TrancheData memory td, uint256[] memory balances) = bond.getTrancheCollateralBalances(_reserve());
            for (uint8 j = 0; j < td.trancheCount; j++) {
                totalAssets_ += balances[i];
            }
        }
        return totalAssets_;
    }

    // @dev The total rotation reward held by the reserve.
    function _getTotalIncome() private view returns (uint256) {
        return perp.rewardToken().balanceOf(_reserve());
    }

    // @dev Computes the percentage of the reserve held as "cash", i.e) the underlying token.
    function _currentCashPerc(uint256 totalAssets_) private view returns (uint256) {
        return (underlying.balanceOf(_reserve()) * (10**PERC_DECIMALS)) / totalAssets_;
    }

    // @dev Computes the share of the reward balance.
    function _rewardShare(
        uint256 shares,
        uint256 totalIncome_,
        uint256 totalSupply_
    ) private view returns (uint256) {
        return (shares * totalIncome_) / totalSupply_;
    }

    // @dev Address of the reserve where all the vault funds are held.
    function _reserve() private view returns (address) {
        return address(this);
    }

    // @dev Computes the amount of vault shares can be exchanged for a given amount of underlying tokens.
    function _uAmountToShares(
        uint256 uAmount,
        uint256 totalAssets_,
        uint256 totalSupply_
    ) private pure returns (uint256) {
        // TODO: alternatively can make a mico-deposit on construction
        return totalSupply_ > 0 ? ((uAmount * totalSupply_) / totalAssets_) : uAmount * INITIAL_RATE;
    }

    // @dev Computes the amount of underlying tokens that can be exchanged for a given amount of vault shares.
    function _sharesToUAmount(
        uint256 shares,
        uint256 totalAssets_,
        uint256 totalSupply_
    ) private pure returns (uint256) {
        return (shares * totalAssets_) / totalSupply_;
    }
}
