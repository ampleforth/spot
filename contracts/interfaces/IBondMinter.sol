interface IBondMinter {
    struct BondConfig {
        address collateralToken;
        uint256[] trancheRatios;
        uint256 duration;
    }

    event BondConfigAdded(BondConfig config);

    event BondConfigRemoved(BondConfig config);

    event BondMinted(address bond, bytes32 configHash);

    function mintBonds() external;

    function isInstance(address bond) external view returns (bool);

    function getConfigHash(address bond) external view returns (bytes32);

    function getConfig(address bond) external view returns (BondConfig memory);

    function numConfigs() external view returns (uint256);

    function bondConfigAt(uint256 index) external view returns (BondConfig memory);
}
