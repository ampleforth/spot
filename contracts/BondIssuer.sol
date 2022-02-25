pragma solidity ^0.8.0;

import { IBondFactory } from "./interfaces/button-wood/IBondFactory.sol";
import { IBondIssuer } from "./interfaces/IBondIssuer.sol";
import { IBondController } from "./interfaces/button-wood/IBondController.sol";

// A issuer periodically issues a specified class of bonds or config
// A config is uniquely identified by {collateralToken, trancheRatios}
// Based on the provided frequency issuer instantiates new bonds with the given config when poked
contract BondIssuer is IBondIssuer {
    // bond factory
    IBondFactory public immutable bondFactory;

    // issue frequency parameters
    uint256 public immutable minIssueTimeInterval;
    uint256 public immutable issueWindowOffset;
    uint256 public immutable bondDuration;
    uint256 public lastIssueWindowTimestamp;

    IBondIssuer.BondConfig public config;
    bytes32 private _configHash;

    // mapping of issued bonds
    mapping(IBondController => bool) public issuedBonds;

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
        _configHash = keccak256(abi.encode(config_.collateralToken, config_.trancheRatios, bondDuration_));

        lastIssueWindowTimestamp = 0;
    }

    // checks if bond has been issued using this issuer
    function isInstance(IBondController bond) external view override returns (bool) {
        return issuedBonds[bond];
    }

    // returns the config hash of a given bond if issued by this issuer
    // todo compute this from the bond
    function configHash(IBondController bond) external view override returns (bytes32) {
        return issuedBonds[bond] ? _configHash : bytes32(0);
    }

    // issues new bond
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

        issuedBonds[IBondController(bond)] = true;

        emit BondIssued(bond);
    }
}
