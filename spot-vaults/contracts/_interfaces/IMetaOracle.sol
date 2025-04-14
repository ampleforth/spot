// SPDX-License-Identifier: BUSL-1.1

/// @notice Oracle adapter for AMPL and its family of assets.
// solhint-disable-next-line compiler-version
interface IMetaOracle {
    /// @return Number of decimals representing the prices returned.
    function decimals() external pure returns (uint8);

    /// @return price The price of USDC tokens in dollars.
    /// @return isValid True if the returned price is valid.
    function usdcPrice() external returns (uint256 price, bool isValid);

    /// @notice Computes the deviation between SPOT's market price and FMV price.
    /// @return deviation The computed deviation factor.
    /// @return isValid True if the returned deviation is valid.
    function spotPriceDeviation() external returns (uint256 deviation, bool isValid);

    /// @notice Computes the deviation between AMPL's market price and price target.
    /// @return deviation The computed deviation factor.
    /// @return isValid True if the returned deviation is valid.
    function amplPriceDeviation() external returns (uint256 deviation, bool isValid);

    /// @return price The price of SPOT in dollars.
    /// @return isValid True if the returned price is valid.
    function spotUsdPrice() external returns (uint256 price, bool isValid);

    /// @return price The price of AMPL in dollars.
    /// @return isValid True if the returned price is valid.
    function amplUsdPrice() external returns (uint256 price, bool isValid);

    /// @return price The SPOT FMV price in dollars.
    /// @return isValid True if the returned price is valid.
    function spotFmvUsdPrice() external returns (uint256 price, bool isValid);

    /// @return price The AMPL target price in dollars.
    /// @return isValid True if the returned price is valid.
    function amplTargetUsdPrice() external returns (uint256 price, bool isValid);

    /// @return price The WAMPL price in dollars.
    /// @return isValid True if the returned price is valid.
    function wamplUsdPrice() external returns (uint256 price, bool isValid);

    /// @return price The ETH price in dollars.
    /// @return isValid True if the returned price is valid.
    function ethUsdPrice() external returns (uint256 price, bool isValid);
}
