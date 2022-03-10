// solhint-disable-next-line compiler-version
interface IBondFactory {
    function createBond(
        address _collateralToken,
        uint256[] memory trancheRatios,
        uint256 maturityDate
    ) external returns (address);
}
