interface IBondMinter {
    struct BondConfig {
        address collateralToken;
        uint256[] trancheRatios;
        uint256 duration;
    }

    event BondConfigAdded(BondConfig config);

    event BondMinted(address bond);

    function mintBonds() external;

    function isInstance(address bond) external view returns (bool);

    function configHash() external view returns (bytes32);
}
