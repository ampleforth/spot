// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { IPerpetualTranche, IERC20Upgradeable, ITranche } from "../../_interfaces/IPerpetualTranche.sol";

contract MockVault {
    function getTVL() public pure returns (uint256) {
        return 0;
    }

    function mintPerps(
        IPerpetualTranche perp,
        ITranche trancheIn,
        uint256 trancheInAmt
    ) public {
        trancheIn.transferFrom(msg.sender, address(this), trancheInAmt);

        trancheIn.approve(address(perp), trancheInAmt);
        perp.deposit(trancheIn, trancheInAmt);

        perp.transfer(msg.sender, perp.balanceOf(address(this)));
    }

    function computePerpMintAmt(
        IPerpetualTranche perp,
        ITranche trancheIn,
        uint256 trancheInAmt
    ) public returns (uint256) {
        return perp.computeMintAmt(trancheIn, trancheInAmt);
    }

    function redeemPerps(IPerpetualTranche perp, uint256 perpAmt) public {
        perp.transferFrom(msg.sender, address(this), perpAmt);
        (IERC20Upgradeable[] memory tokensOut, ) = perp.redeem(perpAmt);
        for (uint256 i = 0; i < tokensOut.length; i++) {
            tokensOut[i].transfer(msg.sender, tokensOut[i].balanceOf(address(this)));
        }
    }

    function computePerpRedemptionAmts(IPerpetualTranche perp, uint256 perpAmt)
        public
        returns (IERC20Upgradeable[] memory, uint256[] memory)
    {
        return perp.computeRedemptionAmts(perpAmt);
    }

    function rollover(
        IPerpetualTranche perp,
        ITranche trancheIn,
        IERC20Upgradeable tokenOut,
        uint256 trancheInAmt
    ) public {
        trancheIn.transferFrom(msg.sender, address(this), trancheInAmt);

        trancheIn.approve(address(perp), trancheInAmt);
        perp.rollover(trancheIn, tokenOut, trancheInAmt);

        trancheIn.transfer(msg.sender, trancheIn.balanceOf(address(this)));
        tokenOut.transfer(msg.sender, tokenOut.balanceOf(address(this)));
    }
}
