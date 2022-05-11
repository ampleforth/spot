// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

struct AddressQueue {
    // @notice Mapping between queue index and address.
    mapping(uint256 => address) queue;
    // @notice Mapping to check address existence.
    mapping(address => bool) items;
    // @notice Index of the first address.
    uint256 first;
    // @notice Index of the last address.
    uint256 last;
}

/*
 *  @title AddressQueueHelpers
 *
 *  @notice Library to handle a queue of unique addresses and basic operations like enqueue and dequeue.
 *          It also supports O(1) existence check, and head, tail retrieval.
 *
 *  @dev Original implementation: https://github.com/chriseth/solidity-examples/blob/master/queue.sol
 */
library AddressQueueHelpers {
    // @notice Initialize the queue storage.
    // @param q Queue storage.
    function init(AddressQueue storage q) internal {
        q.first = 1;
        q.last = 0;
    }

    // @notice Add address to the queue.
    // @param q Queue storage.
    // @param a Address to be added to the queue.
    function enqueue(AddressQueue storage q, address a) internal {
        require(!q.items[a], "AddressQueueHelpers: Expected item to NOT be in queue");
        require(a != address(0), "AddressQueueHelpers: Expected valid item");
        q.last += 1;
        q.queue[q.last] = a;
        q.items[a] = true;
    }

    // @notice Removes the address at the tail of the queue.
    // @param q Queue storage.
    function dequeue(AddressQueue storage q) internal returns (address) {
        require(q.last >= q.first, "AddressQueueHelpers: Expected non-empty queue");
        address a = q.queue[q.first];
        delete q.queue[q.first];
        delete q.items[a];
        q.first += 1;
        return a;
    }

    // @notice Fetches the address at the head of the queue.
    // @param q Queue storage.
    // @return The address at the head of the queue.
    function head(AddressQueue storage q) internal view returns (address) {
        return q.queue[q.first]; // at(0)
    }

    // @notice Fetches the address at the tail of the queue.
    // @param q Queue storage.
    // @return The address at the tail of the queue.
    function tail(AddressQueue storage q) internal view returns (address) {
        return q.queue[q.last]; // at(length-1)
    }

    // @notice Checks if the given address is in the queue.
    // @param q Queue storage.
    // @param a The address to check.
    // @return True if address is present and False if not.
    function contains(AddressQueue storage q, address a) internal view returns (bool) {
        return q.items[a];
    }

    // @notice Calculates the number of items in the queue.
    // @param q Queue storage.
    // @return The queue size.
    function length(AddressQueue storage q) internal view returns (uint256) {
        return q.last >= q.first ? q.last - q.first + 1 : 0;
    }

    // @notice Fetches the item at a given index (indexed from 0 to length-1).
    // @param q Queue storage.
    // @param i Index to look up.
    // @return The item at given index.
    function at(AddressQueue storage q, uint256 index) internal view returns (address) {
        require(index < length(q), "AddressQueueHelpers: Expected index to be in bounds");
        return q.queue[q.first + index];
    }
}
