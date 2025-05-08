// SPDX-License-Identifier: GPL-3.0-or-later
// solhint-disable-next-line compiler-version
interface IAmpleforth {
    function getTargetRate() external returns (uint256, bool);
}
