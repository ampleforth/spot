import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ITranche is IERC20 {
    struct TrancheData {
        ITranche token;
        uint256 ratio;
    }

    function collateralToken() external view returns (address);

    // TODO: wait till this is merged
    // https://github.com/buttonwood-protocol/tranche/pull/30
    function bondController() external view returns (address);

    function mint(address to, uint256 amount) external;

    function burn(address from, uint256 amount) external;

    function redeem(
        address from,
        address to,
        uint256 amount
    ) external;
}
