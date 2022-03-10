// SPDX-License-Identifier: GPL-3.0-or-later

// solhint-disable-next-line compiler-version
import { IBondController } from "./button-wood/IBondController.sol";

interface IBondIssuer {
    struct BondConfig {
        address collateralToken;
        uint256[] trancheRatios;
    }

    event BondIssued(address bond);

    function issue() external;

    function isInstance(IBondController bond) external view returns (bool);
}
