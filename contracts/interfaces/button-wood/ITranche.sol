import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ITranche is IERC20 {
    function collateralToken() external view returns (address);

    // TODO: wait till these have been merged
    function bond() external view returns (address);

    function seniority() external view returns (uint256);
}
