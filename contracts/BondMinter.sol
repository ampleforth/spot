pragma solidity ^0.8.0;

import {IBondFactory} from "./interfaces/button-wood/IBondFactory.sol";
import {IBondMinter} from "./interfaces/IBondMinter.sol";

// A minter periodically mints a specified class of bonds or config
// a config is uniquely identified by {collateralToken, trancheRatios and duration}
// Based on the provided frequency minter instantiates new bonds with the given config when poked
//
// Minor Modification to button wood's version
// https://github.com/buttonwood-protocol/tranche/blob/main/contracts/bondMinter/
// in ours configs are immutable and we limit one config per minter
contract BondMinter is IBondMinter {
    // bond factory
    IBondFactory public immutable bondFactory;

    // mint frequency parameters
    uint256 public immutable waitingPeriod;
    uint256 public lastMintTimestamp;

    // minter bond config
    IBondMinter.BondConfig public config;
    bytes32 public immutable override configHash;

    // mapping of minted bonds
    mapping(address => bool) mintedBonds;


    constructor(IBondFactory bondFactory_,  uint256 waitingPeriod_, IBondMinter.BondConfig memory config_) {
        bondFactory = bondFactory_;
        waitingPeriod = waitingPeriod_;
        config = config_;
        configHash = computeHash(config_);
        lastMintTimestamp = 0;

        emit BondConfigAdded(config);
    }

    // checks if bond has been minted using this minter
    function isInstance(address bond) external view override returns (bool) {
        return mintedBonds[bond];
    }

    function mintBonds() external override {
        require(
            block.timestamp - lastMintTimestamp >= waitingPeriod,
            "BondMinter: Not enough time has passed since last mint timestamp"
        );
        lastMintTimestamp = block.timestamp;

        address bond = bondFactory.createBond(
            config.collateralToken,
            config.trancheRatios,
            lastMintTimestamp + config.duration
        );

        mintedBonds[bond] = true;

        emit BondMinted(bond);
    }

    function computeHash(IBondMinter.BondConfig memory config_) private pure returns (bytes32) {
        return keccak256(abi.encode(config_.collateralToken, config_.trancheRatios, config_.duration));
    }
}
