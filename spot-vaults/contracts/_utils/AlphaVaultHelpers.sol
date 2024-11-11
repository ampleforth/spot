// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IAlphaProVault } from "../_interfaces/external/IAlphaProVault.sol";
import { IUniswapV3Pool } from "@uniswap/v3-core/contracts/interfaces/IUniswapV3Pool.sol";

/**
 *  @title AlphaVaultHelpers
 *
 *  @notice Library with helper functions for Charm's Alpha Vaults.
 *
 */
library AlphaVaultHelpers {
    /// @dev Checks if the vault is underweight token0 (ie overweight token1).
    function isUnderweightToken0(IAlphaProVault vault) internal view returns (bool) {
        // `vault.getTwap()` returns the twap tick from the underlying univ3 pool.
        // https://learn.charm.fi/charm/technical-references/core/alphaprovault#gettwap
        int24 _priceTick = vault.getTwap();
        int24 _limitLower = vault.limitLower();
        int24 _limitUpper = vault.limitUpper();
        int24 _limitPriceTick = (_limitLower + _limitUpper) / 2;
        // The limit range has more token1 than token0 if `_priceTick >= _limitPriceTick`,
        // so the vault looks to sell token1.
        return (_priceTick >= _limitPriceTick);
    }

    /// @dev Removes the vault's limit range liquidity completely.
    function removeLimitLiquidity(IAlphaProVault vault, IUniswapV3Pool pool) internal {
        int24 _limitLower = vault.limitLower();
        int24 _limitUpper = vault.limitUpper();
        uint128 limitLiquidity = getLiquidity(vault, pool, _limitLower, _limitUpper);
        // docs: https://learn.charm.fi/charm/technical-references/core/alphaprovault#emergencyburn
        vault.emergencyBurn(_limitLower, _limitUpper, limitLiquidity);
    }

    /// @dev Removes a percentage of the base and full range liquidity.
    function trimLiquidity(
        IAlphaProVault vault,
        IUniswapV3Pool pool,
        uint256 percToRemove,
        uint256 one
    ) internal {
        if (percToRemove <= 0) {
            return;
        }

        int24 _fullLower = vault.fullLower();
        int24 _fullUpper = vault.fullUpper();
        int24 _baseLower = vault.baseLower();
        int24 _baseUpper = vault.baseUpper();
        uint128 fullLiquidity = getLiquidity(vault, pool, _fullLower, _fullUpper);
        uint128 baseLiquidity = getLiquidity(vault, pool, _baseLower, _baseUpper);
        // Calculated baseLiquidityToBurn, baseLiquidityToBurn will be lesser than fullLiquidity, baseLiquidity
        // Thus, there's no risk of overflow.
        uint128 fullLiquidityToBurn = uint128(
            Math.mulDiv(uint256(fullLiquidity), percToRemove, one)
        );
        uint128 baseLiquidityToBurn = uint128(
            Math.mulDiv(uint256(baseLiquidity), percToRemove, one)
        );
        // docs: https://learn.charm.fi/charm/technical-references/core/alphaprovault#emergencyburn
        // We remove the calculated percentage of base and full range liquidity.
        vault.emergencyBurn(_fullLower, _fullUpper, fullLiquidityToBurn);
        vault.emergencyBurn(_baseLower, _baseUpper, baseLiquidityToBurn);
    }

    /// @dev A low-level method, which interacts directly with the vault and executes
    ///      a rebalance even when enough time hasn't elapsed since the last rebalance.
    function forceRebalance(IAlphaProVault vault) internal {
        uint32 _period = vault.period();
        vault.setPeriod(0);
        vault.rebalance();
        vault.setPeriod(_period);
    }

    /// @dev Wrapper around `IUniswapV3Pool.positions()`.
    function getLiquidity(
        IAlphaProVault vault,
        IUniswapV3Pool pool,
        int24 tickLower,
        int24 tickUpper
    ) internal view returns (uint128) {
        bytes32 positionKey = keccak256(
            abi.encodePacked(address(vault), tickLower, tickUpper)
        );
        (uint128 liquidity, , , , ) = pool.positions(positionKey);
        return liquidity;
    }
}
