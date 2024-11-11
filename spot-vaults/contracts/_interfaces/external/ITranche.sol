// SPDX-License-Identifier: GPL-3.0-or-later
// solhint-disable-next-line compiler-version
interface ITranche {
    function bond() external view returns (address);
    function totalSupply() external view returns (uint256);
}
