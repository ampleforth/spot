import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ITranche is IERC20 {
    function collateralToken() external view returns (address);

    // TODO: wait till this is merged
    // https://github.com/buttonwood-protocol/tranche/pull/30
    function bondController() external view returns (address);
}
