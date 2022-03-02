import { ITranche } from "./button-wood/ITranche.sol";

interface IPricingStrategy {
    function computeTranchePrice(ITranche t) external view returns (uint256);

    function decimals() external view returns (uint8);
}
