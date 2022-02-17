interface IBondIssuer {
    struct BondConfig {
        address collateralToken;
        uint256[] trancheRatios;
        uint256 duration;
    }

    event BondConfigAdded(BondConfig config);

    event BondMinted(address bond);

    function issue() external;

    function isInstance(address bond) external view returns (bool);

    function getConfigHash(address bond) external view returns (bytes32);
}
