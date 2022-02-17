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

    // mint frequency parameters
    uint256 public immutable waitingPeriod;
    uint256 public lastIssueTimestamp;

    // minter bond config
    IBondIssuer.BondConfig public config;

    // mapping of minted bonds
    mapping(address => bool) mintedBonds;

    constructor(
        IBondFactory bondFactory_,
        uint256 waitingPeriod_,
        IBondIssuer.BondConfig memory config_
    ) {
        bondFactory = bondFactory_;
        waitingPeriod = waitingPeriod_;
        config = config_;
        lastIssueTimestamp = 0;

        emit BondConfigAdded(config);
    }

    // checks if bond has been minted using this minter
    function isInstance(address bond) external view override returns (bool) {
        return mintedBonds[bond];
    }

    function issue() external override {
        require(
            block.timestamp - lastIssueTimestamp >= waitingPeriod,
            "BondIssuer: Not enough time has passed since last issue timestamp"
        );
        lastIssueTimestamp = block.timestamp;

        address bond = bondFactory.createBond(
            config.collateralToken,
            config.trancheRatios,
            lastIssueTimestamp + config.duration
        );

        mintedBonds[bond] = true;

        emit BondIssued(bond);
    }
}
