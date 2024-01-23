// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;

import { IERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import { IVault } from "./IVault.sol";
import { IFeePolicy } from "./IFeePolicy.sol";
import { SubscriptionParams } from "./ReturnData.sol";

interface IRolloverVault is IVault {
    function swapUnderlyingForPerps(uint256 underlyingAmtIn) external returns (uint256);

    function swapPerpsForUnderlying(uint256 perpAmtIn) external returns (uint256);

    function computeUnderlyingToPerpSwapAmt(uint256 underlyingAmtIn)
        external
        returns (
            uint256,
            uint256,
            SubscriptionParams memory
        );

    function computePerpToUnderlyingSwapAmt(uint256 perpAmtIn)
        external
        returns (
            uint256,
            uint256,
            SubscriptionParams memory
        );
}
