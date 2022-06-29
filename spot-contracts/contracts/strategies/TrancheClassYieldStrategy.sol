// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.15;

import { OwnableUpgradeable } from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import { TrancheData, TrancheDataHelpers, BondHelpers } from "../_utils/BondHelpers.sol";

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { ITranche } from "../_interfaces/buttonwood/ITranche.sol";
import { IYieldStrategy } from "../_interfaces/IYieldStrategy.sol";
import { IBondController } from "../_interfaces/buttonwood/IBondController.sol";

/*
 *  @title TrancheClassYieldStrategy
 *
 *  @dev Yield factor defined for a particular "class" of tranches.
 *       Any tranche's class is defined as the unique combination of:
 *        - it's collateraToken
 *        - it's parent bond's trancheRatios
 *        - it's seniorityIDX.
 *
 *       For example:
 *        - All AMPL [35-65] bonds can be configured to have a yield of [1, 0] and
 *        => An AMPL-A tranche token from any [35-65] bond will be applied a yield factor of 1.
 *        - All AMPL [50-50] bonds can be configured to have a yield of [0.8,0]
 *        => An AMPL-A tranche token from any [50-50] bond will be applied a yield factor of 0.8.
 *
 */
contract TrancheClassYieldStrategy is IYieldStrategy, OwnableUpgradeable {
    using BondHelpers for IBondController;
    using TrancheDataHelpers for TrancheData;

    uint8 private constant DECIMALS = 18;

    // @notice Mapping between a tranche class and the yield to be applied.
    mapping(bytes32 => uint256) private _trancheYields;

    // @notice Event emitted when the defined tranche yields are updated.
    // @param hash The tranche class hash.
    // @param yield The yield factor for any tranche belonging to that class.
    event UpdatedDefinedTrancheYields(bytes32 hash, uint256 yield);

    // @notice Contract initializer.
    function init() public initializer {
        __Ownable_init();
    }

    // @notice Updates the tranche class's yield.
    // @param classHash The tranche class (hash(collteralToken, trancheRatios, seniority)).
    // @param yield The yield factor.
    function updateDefinedYield(bytes32 classHash, uint256 yield) external onlyOwner {
        if (yield > 0) {
            _trancheYields[classHash] = yield;
        } else {
            delete _trancheYields[classHash];
        }
        emit UpdatedDefinedTrancheYields(classHash, yield);
    }

    // @notice The computes the class hash of a given tranche.
    // @dev A given tranche's computed class is the hash(collateralToken, trancheRatios, seniority).
    //      This is used to identify different tranche tokens instances of the same class
    // @param tranche The address of the tranche token.
    // @return The class hash.
    function trancheClass(ITranche tranche) public view returns (bytes32) {
        IBondController bond = IBondController(tranche.bond());
        TrancheData memory td = bond.getTrancheData();
        return keccak256(abi.encode(bond.collateralToken(), td.trancheRatios, td.getTrancheIndex(tranche)));
    }

    /// @inheritdoc IYieldStrategy
    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    /// @inheritdoc IYieldStrategy
    function computeYield(IERC20Upgradeable token) public view override returns (uint256) {
        return _trancheYields[trancheClass(ITranche(address(token)))];
    }
}
