// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;
import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";

interface IBalancer {
    function decimals() external view returns (uint8);
    function deviationRatio() external view returns (uint256);
}

interface IPerpetualTranche is IERC20Upgradeable {
    function balancer() external view returns (IBalancer);
    function getTVL() external view returns (uint256);
}
