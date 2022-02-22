import { ITranche } from "./button-wood/ITranche.sol";

interface IPricingStrategy {
    function getBuyPrice(ITranche tranche, uint256 trancheAmt) external view returns (uint256);

    function getSellPrice(ITranche tranche, uint256 spotAmt) external view returns (uint256);

    function getRolloverPrice(
        ITranche trancheIn,
        ITranche trancheOut,
        uint256 trancheInAmt
    ) external view returns (uint256);
}
