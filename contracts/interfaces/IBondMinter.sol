/**
 * @title BondMinter Interface
 * @notice Interface for canonically minting bonds according to a stored vaults of configurations
 */
interface IBondMinter{
    struct BondConfig {
        address collateralToken;
        uint256[] trancheRatios;
        uint256 duration;
    }

    /**
     * @notice Event emitted when a new BondConfig is added
     * @param collateralToken address of the contract for the collateral
     * @param trancheRatios Tranching ratios for the bonds. Must sum up to 1000.
     * @param duration Duration of the bond in seconds
     */
    event BondConfigAdded(address collateralToken, uint256[] trancheRatios, uint256 duration);

    /**
     * @notice Event emitted when a BondConfig is removed
     * @param collateralToken address of the contract for the collateral
     * @param trancheRatios Tranching ratios for the bonds. Must sum up to 1000.
     * @param duration Duration of the bond in seconds
     */
    event BondConfigRemoved(address collateralToken, uint256[] trancheRatios, uint256 duration);

    /**
     * @notice Adds new bond configuration to internal list. Emits BondConfigAdded on successful add
     * @param collateralToken address of the contract for the collateral
     * @param trancheRatios Tranching ratios for the bonds. Must sum up to 1000.
     * @param duration Duration of the bond in seconds
     * @return true if the bondConfig was added, that is if it wasn't already present.
     */
    function addBondConfig(
        address collateralToken,
        uint256[] memory trancheRatios,
        uint256 duration
    ) external returns (bool);

    /**
     * @notice Removes bond configuration to internal list
     * @param collateralToken address of the contract for the collateral
     * @param trancheRatios Tranching ratios for the bonds. Must sum up to 1000.
     * @param duration Duration of the bond in seconds
     * @return true if the bondConfig was removed, that is if it was present.
     */
    function removeBondConfig(
        address collateralToken,
        uint256[] memory trancheRatios,
        uint256 duration
    ) external returns (bool);

    /**
     * @notice The number of configs stored in the vault
     */
    function numConfigs() external view returns (uint256);

    /**
     * @notice Returns the bondConfig stored at `index`
     */
    function bondConfigAt(uint256 index) external view returns (BondConfig memory);

    /**
     * @notice Sets the bondFactory
     * @param _bondFactory The bondFactory that will be used mint the bonds
     */
    function setBondFactory(address _bondFactory) external;

    /**
     * @notice Sets the waitingPeriod required between minting periods
     * @param _waitingPeriod The minimum waiting period (in seconds) between mints
     */
    function setWaitingPeriod(uint256 _waitingPeriod) external;

    /**
     * @notice Iterates over configurations and mints bonds for each using the bondFactory
     */
    function mintBonds() external;
}
