import { ITranche } from "./button-wood/ITranche.sol";

interface IFeeStrategy {
    function feeToken() external view returns (address);

    // amount of spot being mint
    function computeMintFee(uint256 amount) external view returns (int256);

    // amount of spot being burnt
    function computeBurnFee(uint256 amount) external view returns (int256);

    // amount of tranche to be traded out for given amount of tranche in
    function computeRolloverReward(
        ITranche trancheIn,
        ITranche trancheOut,
        uint256 trancheInAmt,
        uint256 trancheOutAmt
    ) external view returns (int256);
}
