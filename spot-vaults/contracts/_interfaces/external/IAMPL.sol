// SPDX-License-Identifier: GPL-3.0-or-later
// solhint-disable-next-line compiler-version
import { IAmpleforth } from "./IAmpleforth.sol";
interface IAMPL {
    function monetaryPolicy() external view returns (IAmpleforth);
}
