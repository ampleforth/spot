// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.15;

import { ERC20Upgradeable } from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

contract MockERC20 is ERC20Upgradeable {
    function init(string memory name_, string memory symbol_) external initializer {
        __ERC20_init(name_, symbol_);
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}
