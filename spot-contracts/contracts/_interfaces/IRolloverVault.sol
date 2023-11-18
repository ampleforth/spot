// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IVault } from "./IVault.sol";
import { IBondController } from "./buttonwood/IBondController.sol";
import { ITranche } from "./buttonwood/ITranche.sol";

interface IRolloverVault is IVault {
    function deposit2(uint256 amount) external returns (uint256, uint256);

    function meld(IBondController bond, uint256[] memory trancheAmtsIn) external returns (uint256);

    function swap(ITranche trancheOut, uint256 underlyingAmtIn) external returns (uint256);
}
