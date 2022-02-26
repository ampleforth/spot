// solhint-disable-next-line compiler-version
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ITranche is IERC20 {
    function collateralToken() external view returns (address);

    function bond() external view returns (address);
}
