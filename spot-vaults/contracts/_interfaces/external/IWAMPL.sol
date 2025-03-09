// SPDX-License-Identifier: GPL-3.0-or-later
// solhint-disable-next-line compiler-version
interface IWAMPL {
    function wrapperToUnderlying(uint256 wamples) external view returns (uint256);
}
