// SPDX-License-Identifier: GPL-3.0-or-later
// solhint-disable-next-line compiler-version
interface IPerpetualTranche {
    function underlying() external view returns (address);
    function getTVL() external returns (uint256);
    function totalSupply() external returns (uint256);
    function getReserveCount() external returns (uint256);
    function getReserveAt(uint256 index) external returns (address);
    function deviationRatio() external returns (uint256);
    function getReserveTokenValue(address t) external returns (uint256);
    function getReserveTokenBalance(address t) external returns (uint256);
    function feePolicy() external returns (address);
}
