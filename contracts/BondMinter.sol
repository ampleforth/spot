pragma solidity ^0.8.0;

import {IBondFactory} from "./interfaces/button-wood/IBondFactory.sol";
import {IBondMinter} from "./interfaces/IBondMinter.sol";

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import { EnumerableSet } from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

// A class of bonds are uniquely identified by collateralToken, trancheRatios and duration,
// which are hashed to create the bond's config hash
// Based on the provided frequency minter instantiates new bonds for each config when poked
//
// Minor Modification to button wood's version keep track of the bond <-> config reference
// https://github.com/buttonwood-protocol/tranche/blob/main/contracts/bondMinter/
// we want to know given a bond, was it minted by this minter and what is it's config hash
contract BondMinter is IBondMinter, Ownable {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    // bond factory
    IBondFactory public immutable bondFactory;

    // mint frequency parameters
    uint256 public immutable waitingPeriod;
    uint256 public lastMintTimestamp;

    // mapping of minted bonds
    mapping(address => bool) mintedBonds;

    // mapping to get the full bond config from config hash
    mapping(bytes32 => IBondMinter.BondConfig) private configHashesToConfigs;

    // mapping to get bond config hash from bond address
    mapping(address => bytes32) private bondToConfigHashes;

    // list of config hashes
    EnumerableSet.Bytes32Set private configHashes;

    constructor(IBondFactory bondFactory_,  uint256 waitingPeriod_) {
        bondFactory = bondFactory_;
        waitingPeriod = waitingPeriod_;
        lastMintTimestamp = 0;
    }

    // checks if bond has been minted using this minter
    function isInstance(address bond) external view override returns (bool) {
        return mintedBonds[bond];
    }

    // gets the bond's config hash
    function getConfigHash(address bond) external view override returns (bytes32) {
        return bondToConfigHashes[bond];
    }

    // get the bond's config
    function getConfig(address bond) external view override returns (IBondMinter.BondConfig memory) {
        return configHashesToConfigs[bondToConfigHashes[bond]];
    }

    // counts all configs
    function numConfigs() public view override returns (uint256) {
        return configHashes.length();
    }

    // gets configs
    function bondConfigAt(uint256 index) public view override returns (IBondMinter.BondConfig memory) {
        return configHashesToConfigs[configHashes.at(index)];
    }

    function mintBonds() external override {
        require(
            block.timestamp - lastMintTimestamp >= waitingPeriod,
            "BondMinter: Not enough time has passed since last mint timestamp"
        );
        lastMintTimestamp = block.timestamp;

        for (uint256 i = 0; i < numConfigs(); i++) {
            BondConfig memory bondConfig = bondConfigAt(i);
            bytes32 configHash = computeHash(bondConfig);
            address bond = bondFactory.createBond(
                bondConfig.collateralToken,
                bondConfig.trancheRatios,
                lastMintTimestamp + bondConfig.duration
            );

            mintedBonds[bond] = true;
            bondToConfigHashes[bond] = configHash;

            emit BondMinted(bond, configHash);
        }
    }

    function addBondConfig(IBondMinter.BondConfig memory config) external onlyOwner returns (bool) {
        bytes32 hash = computeHash(config);
        if (configHashes.add(hash)) {
            configHashesToConfigs[hash] = config;
            emit BondConfigAdded(config);
            return true;
        }
        return false;
    }

    function removeBondConfig(IBondMinter.BondConfig memory config) external onlyOwner returns (bool) {
        bytes32 hash = computeHash(config);
        if (configHashes.remove(hash)) {
            delete configHashesToConfigs[hash];
            emit BondConfigRemoved(config);
            return true;
        }
        return false;
    }

    function computeHash(IBondMinter.BondConfig memory config) private pure returns (bytes32) {
        return keccak256(abi.encode(config.collateralToken, config.trancheRatios, config.duration));
    }
}
