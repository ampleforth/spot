// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IBondFactory } from "./_interfaces/button-wood/IBondFactory.sol";
import { IBondIssuer } from "./_interfaces/IBondIssuer.sol";
import { IBondController } from "./_interfaces/button-wood/IBondController.sol";

/*
 *  @title BondIssuer
 *
 *  @notice A issuer periodically issues bonds based on a pre-defined a configuration.
 *
 *  @dev A config is uniquely identified by {collateralToken, trancheRatios, maxMaturityDuration}
 *       Based on the provided frequency issuer instantiates new bond(s) with the config when poked.
 *
 */
contract BondIssuer is IBondIssuer {
    // @notice Address of the bond factory.
    IBondFactory public immutable bondFactory;

    // @notice Time to elapse since last issue, after which a new bond can be issued.
    //         AKA, issue frequency.
    uint256 public immutable minIssueTimeIntervalSec;

    // @notice The issue window begins this many seconds into the minIssueTimeIntervalSec period.
    // @dev For example if minIssueTimeIntervalSec is 604800 (1 week), and issueWindowOffsetSec is 93600
    //      then the issue window opens at Friday 2AM GMT every week.
    uint256 public immutable issueWindowOffsetSec;

    // @notice The timestamp when the issue window opened during the last issue.
    uint256 public lastIssueWindowTimestamp;

    struct BondConfig {
        // @notice The underlying rebasing token used to be tranched.
        address collateralToken;
        // @notice The tranche ratios.
        uint256[] trancheRatios;
        // @notice The maximum maturity duration for the issued bonds.
        // @dev In practice, bonds issued by this issuer won't have a constant duration as
        //      block.timestamp when the issue function is invoked can vary.
        //      Rather these bonds are designed to have a predictable maturity date.
        uint256 maxMaturityDuration;
    }

    // @notice The configuration of the bond to be issued.
    // @dev A bond's config is defined by it's {collateralToken, trancheRatios, maxMaturityDuration}
    BondConfig public config;

    // @notice A private mapping to keep track of bonds issued by this issuer.
    mapping(IBondController => bool) private _issuedBonds;

    constructor(
        IBondFactory bondFactory_,
        uint256 minIssueTimeIntervalSec_,
        uint256 issueWindowOffsetSec_,
        BondConfig memory config_
    ) {
        bondFactory = bondFactory_;
        minIssueTimeIntervalSec = minIssueTimeIntervalSec_;
        issueWindowOffsetSec = issueWindowOffsetSec_;

        config = config_;
        lastIssueWindowTimestamp = 0;
    }

    /// @inheritdoc IBondIssuer
    function isInstance(IBondController bond) external view override returns (bool) {
        return _issuedBonds[bond];
    }

    /// @inheritdoc IBondIssuer
    function issue() external override {
        require(
            lastIssueWindowTimestamp + minIssueTimeIntervalSec < block.timestamp,
            "BondIssuer: Expected enough time to elapse since last issue"
        );

        // Set to the timestamp of the most recent issue window opening
        lastIssueWindowTimestamp = block.timestamp - (block.timestamp % minIssueTimeIntervalSec) + issueWindowOffsetSec;

        IBondController bond = IBondController(
            bondFactory.createBond(
                config.collateralToken,
                config.trancheRatios,
                lastIssueWindowTimestamp + config.maxMaturityDuration
            )
        );

        _issuedBonds[bond] = true;

        emit BondIssued(bond);
    }
}
