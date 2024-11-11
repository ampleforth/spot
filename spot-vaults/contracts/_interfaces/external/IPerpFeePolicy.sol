// SPDX-License-Identifier: GPL-3.0-or-later
// solhint-disable-next-line compiler-version
interface IPerpFeePolicy {
    function decimals() external returns (uint8);
    function deviationRatio() external returns (uint256);
    function computePerpRolloverFeePerc(uint256 dr) external returns (int256);
}
