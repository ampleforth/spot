// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import { AddressQueueHelpers } from "../_utils/AddressQueueHelpers.sol";

contract QueueTester {
    using AddressQueueHelpers for AddressQueueHelpers.AddressQueue;
    AddressQueueHelpers.AddressQueue private _queue;

    constructor() {
        _queue.init();
    }

    function enqueue(address a) public {
        _queue.enqueue(a);
    }

    function dequeue() public returns (address) {
        return _queue.dequeue();
    }

    function head() public view returns (address) {
        return _queue.head();
    }

    function tail() public view returns (address) {
        return _queue.tail();
    }

    function at(uint256 i) public view returns (address) {
        return _queue.at(i);
    }

    function length() public view returns (uint256) {
        return _queue.length();
    }

    function contains(address a) public view returns (bool) {
        return _queue.contains(a);
    }
}
