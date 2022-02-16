import {IBondMinter} from "./IBondMinter.sol";
import {IBondController} from "./button-wood/IBondController.sol";

interface IYieldStrategy {
	function computeTrancheYield(IBondMinter minter, IBondController bond, uint256 seniorityIDX, uint256 trancheAmt) external view returns (uint256);

	function computeTranchePrice(IBondController bond, uint256 seniorityIDX) external view returns (uint256);
}
