// SPDX-License-Identifier: GPL-3.0-or-later
// solhint-disable-next-line compiler-version
pragma solidity ^0.7.6;

import { FullMath } from "@uniswap/v3-core/contracts/libraries/FullMath.sol";
import { TickMath } from "@uniswap/v3-core/contracts/libraries/TickMath.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/**
 *  @title UniswapV3PoolHelpers
 *
 *  @notice Library with helper functions for a UniswapV3Pool.
 *
 */
library UniswapV3PoolHelpers {
    /// @notice Calculates the Time-Weighted Average Price (TWAP) given the TWAP tick and unit token amounts.
    /// @param twapTick The Time-Weighted Average Price tick.
    /// @param token0UnitAmt The fixed-point amount of token0 equivalent to 1.0.
    /// @param token1UnitAmt The fixed-point amount of token1 equivalent to 1.0.
    /// @param one 1.0 represented in the same fixed point denomination as calculated TWAP.
    /// @return The computed TWAP price.
    function calculateTwap(
        int24 twapTick,
        uint256 token0UnitAmt,
        uint256 token1UnitAmt,
        uint256 one
    ) internal pure returns (uint256) {
        uint160 sqrtPriceX96 = TickMath.getSqrtRatioAtTick(twapTick);
        uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
        uint256 twapPrice = FullMath.mulDiv(one, (1 << 192), ratioX192);
        return FullMath.mulDiv(twapPrice, token1UnitAmt, token0UnitAmt);
    }

    /// @notice Retrieves the Time-Weighted Average Price (TWAP) tick from a Uniswap V3 pool over a given duration.
    /// @param pool The Uniswap V3 pool.
    /// @param twapDuration The TWAP duration.
    /// @return The TWAP tick.
    function getTwapTick(
        IUniswapV3Pool pool,
        uint32 twapDuration
    ) internal view returns (int24) {
        uint32[] memory secondsAgo = new uint32[](2);
        secondsAgo[0] = twapDuration;
        secondsAgo[1] = 0;
        (int56[] memory tickCumulatives, ) = pool.observe(secondsAgo);
        return int24((tickCumulatives[1] - tickCumulatives[0]) / twapDuration);
    }
}
