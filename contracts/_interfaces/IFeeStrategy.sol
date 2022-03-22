// SPDX-License-Identifier: GPL-3.0-or-later

// solhint-disable-next-line compiler-version
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IFeeStrategy {
    // @notice Address of the fee token.
    function feeToken() external view returns (IERC20);

    // @notice Computes the fee to mint given amount of perp tokens.
    // @dev Fee can be either positive or negative. When positive it's paid by the minting users to the system.
    //      When negative its paid to the minting users by the system.
    // @param amount The amount of perp tokens to be minted.
    // @return The mint fee in fee tokens.
    function computeMintFee(uint256 amount) external view returns (int256);

    // @notice Computes the fee to burn given amount of perp tokens.
    // @dev Fee can be either positive or negative. When positive it's paid by the burning users to the system.
    //      When negative its paid to the burning users by the system.
    // @param amount The amount of perp tokens to be burnt.
    // @return The burn fee in fee tokens.
    function computeBurnFee(uint256 amount) external view returns (int256);

    // @notice Computes the fee to rollover given amount of perp tokens.
    // @dev Fee can be either positive or negative. When positive it's paid by the users rolling over to the system.
    //      When negative its paid to the users rolling over by the system.
    // @param amount The Perp-denominated value of the tranches being rotated in.
    // @return The rollover fee in fee tokens.
    function computeRolloverFee(uint256 amount) external view returns (int256);
}
