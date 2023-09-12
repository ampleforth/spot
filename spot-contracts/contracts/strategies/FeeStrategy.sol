// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IFeeStrategy, IERC20Upgradeable } from "../_interfaces/IFeeStrategy.sol";
import { IPerpetualTranche, IBondController } from "../_interfaces/IPerpetualTranche.sol";
import { IVault } from "../_interfaces/IVault.sol";

import { MathUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/MathUpgradeable.sol";
import { SafeCastUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/math/SafeCastUpgradeable.sol";
import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { Sigmoid } from "../_utils/Sigmoid.sol";
import { BondHelpers } from "../_utils/BondHelpers.sol";
import { PerpHelpers } from "../_utils/PerpHelpers.sol";

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
    using PerpHelpers for IPerpetualTranche;

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

        _rolloverFeeAPR.lower = -2 * int256(UNIT_PERC); // -2%
        _rolloverFeeAPR.upper = 5 * int256(UNIT_PERC); // 5%
        _rolloverFeeAPR.growth = 5 * int256(HUNDRED_PERC); // 5x
    }

    // TODO: add setter for sigmoid parameters.

    /// @inheritdoc IFeeStrategy
    function computeRolloverFeePerc() external override returns (int256) {
        // We calculate the rollover fee for the given cycle by dividing the annualized rate
        // by the number of cycles in any given year.
        // NOTE: Ensure that the perp's TVL and vault's TVL have the same base denomination.
        IBondController referenceBond = perp.getDepositBond();
        return ((computeRolloverAPR(getCurrentVaultTVL(), computeTargetVaultTVL(referenceBond)) *
            referenceBond.duration().toInt256()) / ONE_YEAR_SEC);
    }

    /// @return The annualized rollover fee percentage.
    function computeRolloverAPR(uint256 currentTVL, uint256 targetTVL) public view returns (int256) {
        return
            Sigmoid.compute(
                currentTVL.mulDiv(HUNDRED_PERC, targetTVL).toInt256(),
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
            address authorizedRoller = perp.authorizedRollerAt(i);

            // no-op, EOA doesn't count as on-chain capital
            if (!AddressUpgradeable.isContract(authorizedRoller)) {
                continue;
            }

            try IVault(authorizedRoller).getTVL() returns (uint256 val) {
                tvl += val;
            } catch // solhint-disable-next-line no-empty-blocks
            {
                // no-op, if the vault doens't implement `getTVL`,
                // we can't use it.
            }
        }
        return tvl;
    }

    /// @return The expected TVL to support the perp supply.
    function computeTargetVaultTVL(IBondController referenceBond) public returns (uint256) {
        (uint256 perpRatio, uint256 vaultRatio) = perp.computeEffectiveTrancheRatio(referenceBond);
        return perp.getTVL().mulDiv(vaultRatio, perpRatio);
    }

    //-------------------------------------------------------------------------
    // Deprecated section, keeping for backward comparability with RouterV1.

    // @notice Deprecated.
    function feeToken() external pure override returns (IERC20Upgradeable) {
        return IERC20Upgradeable(address(0));
    }

    // @notice Deprecated.
    function computeMintFees(
        uint256 /*mintAmt*/
    ) external pure override returns (int256, uint256) {
        return (0, 0);
    }

    // @notice Deprecated.
    function computeBurnFees(
        uint256 /*burnAmt*/
    ) external pure override returns (int256, uint256) {
        return (0, 0);
    }

    // @notice Deprecated.
    function computeRolloverFees(
        uint256 /*rolloverAmt*/
    ) external pure override returns (int256, uint256) {
        return (0, 0);
    }
}
