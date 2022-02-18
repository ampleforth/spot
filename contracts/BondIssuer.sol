pragma solidity ^0.8.0;

import { IBondFactory } from "./interfaces/button-wood/IBondFactory.sol";
import { IBondIssuer } from "./interfaces/IBondIssuer.sol";

// A minter periodically mints a specified class of bonds or config
// a config is uniquely identified by {collateralToken, trancheRatios and duration}
// Based on the provided frequency minter instantiates new bonds with the given config when poked
//
// Minor Modification to button wood's version
// https://github.com/buttonwood-protocol/tranche/blob/main/contracts/BondIssuer/
// in ours configs are immutable and we limit one config per minter
// and we have a way of checking if the given bond was issued by the issuer
contract BondIssuer is IBondIssuer {
    // bond factory
    IBondFactory public immutable bondFactory;

    // issue frequency parameters
    uint256 public immutable minIssueTimeInterval;
    uint256 public immutable issueWindowOffset;
    uint256 public immutable bondDuration;
    uint256 public lastIssueWindowTimestamp;

    IBondIssuer.BondConfig public config;

    // mapping of minted bonds
    mapping(address => bool) mintedBonds;

    constructor(
        IBondFactory bondFactory_,
        uint256 minIssueTimeInterval_,
        uint256 issueWindowOffset_,
        uint256 bondDuration_,
        IBondIssuer.BondConfig memory config_
    ) {
        bondFactory = bondFactory_;
        minIssueTimeInterval = minIssueTimeInterval_; // 1 week
        issueWindowOffset = issueWindowOffset_; // 7200, 2AM UTC
        bondDuration = bondDuration_; // 4 weeks
        config = config_;

        lastIssueWindowTimestamp = 0;
    }

    // checks if bond has been minted using this minter
    function isInstance(address bond) external view override returns (bool) {
        return mintedBonds[bond];
    }

    function issue() external override {
        require(
            lastIssueWindowTimestamp + minIssueTimeInterval < block.timestamp,
            "BondIssuer: Not enough time has passed since last issue timestamp"
        );

        lastIssueWindowTimestamp = block.timestamp - (block.timestamp % minIssueTimeInterval);

        address bond = bondFactory.createBond(
            config.collateralToken,
            config.trancheRatios,
            lastIssueWindowTimestamp + bondDuration
        );

        mintedBonds[bond] = true;

        emit BondIssued(bond);
    }
}
