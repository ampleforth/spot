interface IBondIssuer {
    struct BondConfig {
        address collateralToken;
        uint256[] trancheRatios;
        uint256 duration;
    }

    event BondConfigAdded(BondConfig config);

    event BondIssued(address bond);

    function issue() external;

    function isInstance(address bond) external view returns (bool);
}
