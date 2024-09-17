// SPDX-License-Identifier: BUSL-1.1

/// @notice Oracle contract to price perps and its underlying token.
// solhint-disable-next-line compiler-version
interface IPerpPricer {
    /// @return Number of decimals representing the prices returned.
    function decimals() external pure returns (uint8);

    /// @return price The price of reference USD tokens.
    /// @return isValid True if the returned price is valid.
    function usdPrice() external returns (uint256 price, bool isValid);

    /// @return price The price of perp tokens in dollars.
    /// @return isValid True if the returned price is valid.
    function perpUsdPrice() external returns (uint256 price, bool isValid);

    /// @return price The price of underlying tokens (which back perp) in dollars.
    /// @return isValid True if the returned price is valid.
    function underlyingUsdPrice() external returns (uint256 price, bool isValid);

    /// @return price Perp's fmv price in dollars.
    /// @return isValid True if the returned price is valid.
    function perpFmvUsdPrice() external returns (uint256 price, bool isValid);

    /// @return beta Perp's volatility measure.
    /// @return isValid True if the returned measure is valid.
    function perpBeta() external returns (uint256, bool);
}
