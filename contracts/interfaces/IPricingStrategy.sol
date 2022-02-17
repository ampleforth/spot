import { IBondIssuer } from "./IBondIssuer.sol";
import { IBondController } from "./button-wood/IBondController.sol";

interface IPricingStrategy {
    function getTranchePrice(
        IBondIssuer minter,
        IBondController bond,
        uint256 seniorityIDX,
        uint256 trancheAmt
    ) external view returns (uint256);
}
