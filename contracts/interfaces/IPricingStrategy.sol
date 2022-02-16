import {IBondMinter} from "./IBondMinter.sol";
import {IBondController} from "./button-wood/IBondController.sol";

interface IPricingStrategy {
	function getTranchePrice(
		IBondMinter minter, 
		IBondController bond, 
		uint256 seniorityIDX, 
		uint256 trancheAmt
	) external view returns (uint256);
}
