interface IFeeStrategy {
    // amount of spot being mint
    function computeMintFee(uint256 amount) external view returns (int256);

    // amount of spot being burnt
    function computeBurnFee(uint256 amount) external view returns (int256);
}
