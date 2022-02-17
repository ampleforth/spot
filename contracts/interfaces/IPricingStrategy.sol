import { ITranche } from "./button-wood/ITranche.sol";

interface IPricingStrategy {
    function getTranchePrice(ITranche tranche, uint256 trancheAmt) external view returns (uint256);
}
