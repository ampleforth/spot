// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import { IPerpetualTranche, IERC20Upgradeable, ITranche } from "../../_interfaces/IPerpetualTranche.sol";
import { RolloverData } from "../../_interfaces/CommonTypes.sol";

contract MockVault {
    function getTVL() public pure returns (uint256) {
        return 0;
    }

    function rollover(
        IPerpetualTranche perp,
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmt
    ) public returns (RolloverData memory) {
        trancheIn.transferFrom(msg.sender, address(this), trancheInAmt);

        trancheIn.approve(address(perp), trancheInAmt);
        RolloverData memory r = perp.rollover(trancheIn, tokenOut, trancheInAmt);

        trancheIn.transfer(msg.sender, trancheIn.balanceOf(address(this)));
        tokenOut.transfer(msg.sender, tokenOut.balanceOf(address(this)));

        return r;
    }

    function callRollover(
        IPerpetualTranche perp,
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmt
    ) public {
        perp.rollover(trancheIn, tokenOut, trancheInAmt);
    }
}
