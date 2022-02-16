interface IFeeStrategy {
    function computeMintFee(uint256 amount) external view returns (int256);

    function computeBurnFee(uint256 amount) external view returns (int256);
}
