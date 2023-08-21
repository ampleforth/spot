// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20Upgradeable } from "../../oz/IERC20Upgradeable.sol";

interface ITranche is IERC20Upgradeable {
    function bond() external view returns (address);
}
