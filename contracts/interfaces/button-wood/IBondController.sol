import { ITranche } from "./ITranche.sol";

interface IBondController {
    function collateralToken() external view returns (address);

    function maturityDate() external view returns (uint256);

    function tranches(uint256 i) external view returns (ITranche token, uint256 ratio);

    function trancheCount() external view returns (uint256 count);

    function deposit(uint256 amount) external;

    // immature redemption
    function redeem(uint256[] memory amounts) external;

    function mature() external;

    // redemption after maturity
    function redeemMature(address tranche, uint256 amount) external;
}
