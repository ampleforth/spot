// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.17;

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { EnumerableSetUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/structs/EnumerableSetUpgradeable.sol";

import { BondHelpers } from "./_utils/BondHelpers.sol";

import { IBondFactory } from "./_interfaces/buttonwood/IBondFactory.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";
import { IBondIssuer } from "./_interfaces/IBondIssuer.sol";

/// @notice Expected at least one mature bond.
error NoMaturedBonds();

/**
 *  @title BondIssuer
 *
 *  @notice An issuer periodically issues bonds based on a predefined configuration.
 *
 *  @dev Based on the provided frequency, issuer instantiates a new bond with the config when poked.
 *
 */
contract BondIssuer is IBondIssuer, OwnableUpgradeable {
    using EnumerableSetUpgradeable for EnumerableSetUpgradeable.AddressSet;
    using BondHelpers for IBondController;

    /// @dev Using the same granularity as the underlying buttonwood tranche contracts.
    ///      https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol
    uint256 private constant TRANCHE_RATIO_GRANULARITY = 1000;

    /// @notice Address of the bond factory.
    IBondFactory public immutable bondFactory;

    /// @notice The underlying rebasing token used for tranching.
    address public immutable collateral;

    /// @notice The maximum maturity duration for the issued bonds.
    /// @dev In practice, bonds issued by this issuer won't have a constant duration as
    ///      block.timestamp when the issue function is invoked can vary.
    ///      Rather these bonds are designed to have a predictable maturity date.
    uint256 public maxMaturityDuration;

    /// @notice The tranche ratios.
    /// @dev Each tranche ratio is expressed as a fixed point number
    ///      such that the sum of all the tranche ratios is exactly 1000.
    ///      https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol#L20
    uint256[] public trancheRatios;

    /// @notice Time to elapse since last issue window start, after which a new bond can be issued.
    ///         AKA, issue frequency.
    uint256 public minIssueTimeIntervalSec;

    /// @notice The issue window begins this many seconds into the minIssueTimeIntervalSec period.
    /// @dev For example if minIssueTimeIntervalSec is 604800 (1 week), and issueWindowOffsetSec is 93600
    ///      then the issue window opens at Friday 2AM GMT every week.
    uint256 public issueWindowOffsetSec;

    /// @dev List of all active bonds, i.e) issued bonds which have not been matured.
    EnumerableSetUpgradeable.AddressSet private _activeBonds;

    /// @dev List of "inactive", matured bonds.
    ///      Once a bond is matured it's moved from the `active` list into this one.
    EnumerableSetUpgradeable.AddressSet private _maturedBonds;

    /// @dev The reference to the most recently issued bond.
    IBondController private _lastBond;

    /// @notice The timestamp when the issue window opened during the last issue.
    uint256 public lastIssueWindowTimestamp;

    /// @notice Contract constructor
    /// @param bondFactory_ The bond factory reference.
    /// @param collateral_ The address of the collateral ERC-20.
    constructor(IBondFactory bondFactory_, address collateral_) {
        bondFactory = bondFactory_;
        collateral = collateral_;
    }

    /// @notice Contract initializer.
    /// @param maxMaturityDuration_ The maximum maturity duration.
    /// @param trancheRatios_ The tranche ratios.
    /// @param minIssueTimeIntervalSec_ The minimum time between successive issues.
    /// @param issueWindowOffsetSec_ The issue window offset.
    function init(
        uint256 maxMaturityDuration_,
        uint256[] memory trancheRatios_,
        uint256 minIssueTimeIntervalSec_,
        uint256 issueWindowOffsetSec_
    ) public initializer {
        __Ownable_init();
        updateMaxMaturityDuration(maxMaturityDuration_);
        updateTrancheRatios(trancheRatios_);
        updateIssuanceTimingConfig(minIssueTimeIntervalSec_, issueWindowOffsetSec_);
    }

    /// @notice Updates the bond duration.
    /// @param maxMaturityDuration_ The new maximum maturity duration.
    function updateMaxMaturityDuration(uint256 maxMaturityDuration_) public onlyOwner {
        maxMaturityDuration = maxMaturityDuration_;
    }

    /// @notice Updates the tranche ratios used to issue bonds.
    /// @param trancheRatios_ The new tranche ratios, ordered by decreasing seniority (i.e. A to Z)
    function updateTrancheRatios(uint256[] memory trancheRatios_) public onlyOwner {
        trancheRatios = trancheRatios_;
        uint256 ratioSum;
        for (uint8 i = 0; i < trancheRatios_.length; i++) {
            ratioSum += trancheRatios_[i];
        }
        require(ratioSum == TRANCHE_RATIO_GRANULARITY, "BondIssuer: Invalid tranche ratios");
    }

    /// @notice Updates the bond frequency and offset.
    /// @param minIssueTimeIntervalSec_ The new issuance interval.
    /// @param issueWindowOffsetSec_ The new issue window offset.
    function updateIssuanceTimingConfig(uint256 minIssueTimeIntervalSec_, uint256 issueWindowOffsetSec_)
        public
        onlyOwner
    {
        minIssueTimeIntervalSec = minIssueTimeIntervalSec_;
        issueWindowOffsetSec = issueWindowOffsetSec_;
    }

    /// @inheritdoc IBondIssuer
    function isInstance(IBondController bond) external view override returns (bool) {
        return (_activeBonds.contains(address(bond)) || _maturedBonds.contains(address(bond)));
    }

    /// @inheritdoc IBondIssuer
    /// @dev Reverts if none of the active bonds are mature.
    function matureAll() external {
        bool bondsMature = false;
        uint256 activeCount_ = _activeBonds.length();

        // NOTE: We traverse the active list in the reverse order as deletions involve
        //       swapping the deleted element to the end of the list and removing the last element.
        for (uint256 i = activeCount_; i > 0; i--) {
            IBondController bond = IBondController(_activeBonds.at(i - 1));
            if (bond.timeToMaturity() <= 0) {
                if (!bond.isMature()) {
                    bond.mature();
                }

                _activeBonds.remove(address(bond));
                _maturedBonds.add(address(bond));
                emit BondMature(bond);

                bondsMature = true;
            }
        }

        if (!bondsMature) {
            revert NoMaturedBonds();
        }
    }

    /// @inheritdoc IBondIssuer
    function issue() public override {
        if (block.timestamp < lastIssueWindowTimestamp + minIssueTimeIntervalSec) {
            return;
        }

        // Set to the timestamp of the most recent issue window start
        lastIssueWindowTimestamp =
            block.timestamp -
            ((block.timestamp - issueWindowOffsetSec) % minIssueTimeIntervalSec);

        IBondController bond = IBondController(
            bondFactory.createBond(collateral, trancheRatios, lastIssueWindowTimestamp + maxMaturityDuration)
        );

        _activeBonds.add(address(bond));
        _lastBond = bond;

        emit BondIssued(bond);
    }

    /// @inheritdoc IBondIssuer
    /// @dev Lazily issues a new bond when the time is right.
    function getLatestBond() external override returns (IBondController) {
        issue();
        return _lastBond;
    }

    /// @inheritdoc IBondIssuer
    function issuedCount() external view override returns (uint256) {
        return _activeBonds.length() + _maturedBonds.length();
    }

    /// @inheritdoc IBondIssuer
    /// @dev Internally, we first iterate through the active list and then move on to the mature list.
    ///      This list is NOT guaranteed to be ordered.
    function issuedBondAt(uint256 index) external view override returns (IBondController) {
        uint256 activeCount_ = _activeBonds.length();
        if (index < activeCount_) {
            return IBondController(_activeBonds.at(index));
        } else {
            return IBondController(_maturedBonds.at(index - activeCount_));
        }
    }

    /// @notice Returns the count of issued bonds which are still active (i.e have not matured).
    /// @return The number of active bonds.
    function activeCount() external view returns (uint256) {
        return _activeBonds.length();
    }
}
