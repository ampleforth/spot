// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IFeeStrategy, IERC20Upgradeable } from "../_interfaces/IFeeStrategy.sol";
import { IPerpetualTranche, IBondController, IBondIssuer } from "../_interfaces/IPerpetualTranche.sol";
import { IVault } from "../_interfaces/IVault.sol";

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import {  SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Sigmoid } from "../_utils/Sigmoid.sol";
import { BondHelpers } from "../_utils/BondHelpers.sol";
import { BondTranches } from "../_utils/BondTranchesHelpers.sol";

/**
 *  @title FeeStrategy
 *
 *  @notice This contract computes perp's rollover fees & incentives.
 *
 */
contract FeeStrategy is IFeeStrategy, OwnableUpgradeable {
    // Libraries
    using MathUpgradeable for uint256;
    using SafeCastUpgradeable for uint256;
    using BondHelpers for IBondController;

    /// @dev The returned fee percentages are fixed point numbers with {PERC_DECIMALS} places.
    ///      This should line up with the consumer, i.e) perp.
    uint8 public constant PERC_DECIMALS = 8;
    uint256 public constant UNIT_PERC = 10**(PERC_DECIMALS - 2);
    uint256 public constant HUNDRED_PERC = 10**PERC_DECIMALS;

    /// @dev Number of seconds in one year.
    int256 public constant ONE_YEAR_SEC = 365 * 24 * 3600;

    // Replicating value used here:
    // https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 private constant TRANCHE_RATIO_GRANULARITY = 1000;

    // @dev Replicating value used in perp
    uint8 public constant DISCOUNT_DECIMALS = 18;
    uint256 public constant UNIT_DISCOUNT = (10**DISCOUNT_DECIMALS);

    /// @notice Reference to the perpetual token.
    IPerpetualTranche public perp;

    /// @notice Parameters which control the asymptotes and the slope of the yearly rollover fee.
    struct SigmoidParams {
        /// @notice Lower asymptote
        int256 lower;
        /// @notice Upper asymptote
        int256 upper;
        /// @notice Sigmoid slope
        int256 growth;
    }
    SigmoidParams private _rolloverFeeAPR;

    /// @notice Contract initializer.
    /// @param perp_ Reference to perp.
    function init(IPerpetualTranche perp_) public initializer {
        __Ownable_init();
        perp = perp_;

        _rolloverFeeAPR.lower = -1 * int256(UNIT_PERC); // -1%
        _rolloverFeeAPR.upper = 5 * int256(UNIT_PERC); // 5%
        _rolloverFeeAPR.growth = 3 * int256(HUNDRED_PERC); // 3x
    }

    // TODO: add setter for sigmoid parameters.

    /// @inheritdoc IFeeStrategy
    function rolloverFeePerc() external override returns (int256) {
        // We calculate the rollover fee for the given cycle by dividing the annualized rate
        // by the number of cycles in any given year.
        // TODO: use muldiv?
        int256 rolloverAPR = computeRolloverAPR(getCurrentVaultTVL(), computeTargetVaultTVL());
        int256 bondDuration = IBondIssuer(perp.bondIssuer()).maxMaturityDuration().toInt256();
        return (rolloverAPR * bondDuration / ONE_YEAR_SEC);
    }

    /// @return The annualized rollover fee percentage.
    function computeRolloverAPR(uint256 current, uint256 target) public returns (int256) {
        return
            Sigmoid.compute(
                current.mulDiv(HUNDRED_PERC, target).toInt256(),
                _rolloverFeeAPR.lower,
                _rolloverFeeAPR.upper,
                _rolloverFeeAPR.growth,
                PERC_DECIMALS
            );
    }

    /// @return The expected TVL to sustain the perp supply.
    function getCurrentVaultTVL() public returns (uint256) {
        uint256 tvl = 0;
        uint256 numVaults = perp.authorizedRollersCount();
        for (uint256 i = 0; i < numVaults; i++) {
            IVault vault = IVault(perp.authorizedRollerAt(i));
            try vault.getTVL() returns (uint256 val) {
                tvl += val;
            } catch {
                // no-op, EOA doesn't count as on-chain capital
            }
        }
        return tvl;
    }

    /// @return The expected TVL to support the perp supply.
    function computeTargetVaultTVL() public returns (uint256) {
        IBondController mintingBond = perp.getDepositBond();
        BondTranches memory bt = mintingBond.getTranches();

        // Put simply, vaultTVL is expected to be a `perpTVL` / `trancheRatio`
        // For a 25/75 tranche ratio the expected vaultTVL = 4 * `perpTVL`.
        //
        // However in practice, perp might accept multiple tranche classes each with
        // its associated discount factor. So we first compute the `effectiveTrancheRatio`.
        //
        // For example, for a 20A, 30B, 50Z bond and if perp accepts
        //   - As at a discount of 1,
        //   - Bs as a discount of 0.5, and
        //   - Zs at a discount of 0.
        //
        // The effective tranche ratio accepted by perp is (1 * 20 + (0.5) * 30 + 0 * 50)/100 => 35/100
        // And the vaultTVL = `perpTVL` * 35 / 100  => 2.85 * `perpTVL`.
        //
        uint256 effectiveTrancheRatio = 0;
        for (uint8 i = 0; i < bt.tranches.length; i++) {
            uint256 yield = perp.computeDiscount(bt.tranches[i]);
            effectiveTrancheRatio += bt.trancheRatios[i] * yield;
        }

        // The expected `vaultTVL` is calculated as `perpTVL` / `effectiveTrancheRatio`
        return (perp.getTVL() * TRANCHE_RATIO_GRANULARITY).mulDiv(UNIT_DISCOUNT, effectiveTrancheRatio);
    }

    //-------------------------------------------------------------------------
    // Deprecated section, keeping for backward comparability with RouterV1.

    function feeToken() external view override returns (IERC20Upgradeable) {
        return IERC20Upgradeable(address(0));
    }

    // @notice Deprecated.
    function computeMintFees(uint256 mintAmt) external view override returns (int256, uint256) {
        return (0, 0);
    }

    // @notice Deprecated.
    function computeBurnFees(uint256 burnAmt) external view override returns (int256, uint256) {
        return (0, 0);
    }

    // @notice Deprecated.
    function computeRolloverFees(uint256 rolloverAmt) external view override returns (int256, uint256) {
        return (0, 0);
    }
}
