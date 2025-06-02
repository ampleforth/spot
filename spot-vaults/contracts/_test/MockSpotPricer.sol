// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IPerpetualTranche } from "../_interfaces/external/IPerpetualTranche.sol";

/**
 * @title MockSpotPricer
 *
 * @notice SpotPricer for bill broker testnet deployment.
 *
 */
contract MockSpotPricer {
    using Math for uint256;
    uint256 private constant DECIMALS = 18;
    uint256 private constant ONE = (10 ** DECIMALS);

    IPerpetualTranche public immutable SPOT;

    constructor(IPerpetualTranche spot) {
        SPOT = spot;
    }

    function decimals() external pure returns (uint8) {
        return uint8(DECIMALS);
    }

    function usdPrice() external pure returns (uint256, bool) {
        return (ONE, true);
    }

    function perpUsdPrice() external returns (uint256, bool) {
        return perpFmvUsdPrice();
    }

    function perpFmvUsdPrice() public returns (uint256, bool) {
        (uint256 targetPrice, bool targetPriceValid) = amplTargetUsdPrice();
        return (targetPrice.mulDiv(SPOT.getTVL(), SPOT.totalSupply()), targetPriceValid);
    }

    function amplTargetUsdPrice() public pure returns (uint256, bool) {
        return (ONE.mulDiv(121, 100), true);
    }
}
