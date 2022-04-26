// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IBondFactory } from "./_interfaces/buttonwood/IBondFactory.sol";
import { IBondController } from "./_interfaces/buttonwood/IBondController.sol";
import { IBondIssuer } from "./_interfaces/IBondIssuer.sol";

/*
 *  @title BondIssuer
 *
 *  @notice An issuer periodically issues bonds based on a predefined configuration.
 *
 *  @dev Based on the provided frequency, issuer instantiates a new bond with the config when poked.
 *
 */
contract BondIssuer is IBondIssuer {
    // @notice Address of the bond factory.
    IBondFactory public immutable bondFactory;

    // @notice Time to elapse since last issue window start, after which a new bond can be issued.
    //         AKA, issue frequency.
    uint256 public immutable minIssueTimeIntervalSec;

    // @notice The issue window begins this many seconds into the minIssueTimeIntervalSec period.
    // @dev For example if minIssueTimeIntervalSec is 604800 (1 week), and issueWindowOffsetSec is 93600
    //      then the issue window opens at Friday 2AM GMT every week.
    uint256 public immutable issueWindowOffsetSec;

    // @notice The maximum maturity duration for the issued bonds.
    // @dev In practice, bonds issued by this issuer won't have a constant duration as
    //      block.timestamp when the issue function is invoked can vary.
    //      Rather these bonds are designed to have a predictable maturity date.
    uint256 public immutable maxMaturityDuration;

    // @notice The underlying rebasing token used for tranching.
    address public immutable collateralToken;

    // @notice The tranche ratios.
    // @dev Each tranche ratio is expressed as a fixed point number
    //      such that the sum of all the tranche ratios is exactly 1000.
    //      https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondController.sol#L20
    uint256[] public trancheRatios;

    // @notice A private mapping to keep track of bonds issued by this issuer.
    mapping(IBondController => bool) private _issuedBonds;

    // @notice The address of the most recently issued bond.
    IBondController private _latestBond;

    // @notice The timestamp when the issue window opened during the last issue.
    uint256 public lastIssueWindowTimestamp;

    constructor(
        IBondFactory bondFactory_,
        uint256 minIssueTimeIntervalSec_,
        uint256 issueWindowOffsetSec_,
        uint256 maxMaturityDuration_,
        address collateralToken_,
        uint256[] memory trancheRatios_
    ) {
        bondFactory = bondFactory_;
        minIssueTimeIntervalSec = minIssueTimeIntervalSec_;
        issueWindowOffsetSec = issueWindowOffsetSec_;
        maxMaturityDuration = maxMaturityDuration_;

        collateralToken = collateralToken_;
        trancheRatios = trancheRatios_;

        lastIssueWindowTimestamp = 0;
    }

    /// @inheritdoc IBondIssuer
    function isInstance(IBondController bond) external view override returns (bool) {
        return _issuedBonds[bond];
    }

    /// @inheritdoc IBondIssuer
    function issue() public override {
        if (block.timestamp < lastIssueWindowTimestamp + minIssueTimeIntervalSec) {
            return;
        }

        // Set to the timestamp of the most recent issue window start
        lastIssueWindowTimestamp = block.timestamp - (block.timestamp % minIssueTimeIntervalSec) + issueWindowOffsetSec;

        IBondController bond = IBondController(
            bondFactory.createBond(collateralToken, trancheRatios, lastIssueWindowTimestamp + maxMaturityDuration)
        );

        _issuedBonds[bond] = true;

        _latestBond = bond;

        emit BondIssued(bond);
    }

    /// @inheritdoc IBondIssuer
    // @dev Lazily issues a new bond when the time is right.
    function getLatestBond() external override returns (IBondController) {
        issue();
        return _latestBond;
    }
}
