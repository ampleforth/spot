// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.19;

import { ERC20Upgradeable } from "../../oz/ERC20Upgradeable.sol";

contract MockERC20 is ERC20Upgradeable {
    function init(string memory name_, string memory symbol_) external initializer {
        __ERC20_init(name_, symbol_);
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}
