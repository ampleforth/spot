// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.4;

/// @notice Expected item to not be `address(0)`.
error InvalidItem();

/// @notice Expected item to not be part of the queue.
/// @param item Item to be inserted into the address queue.
error DuplicateItem(address item);

/// @notice Expected queue to not be empty. 
error EmptyQueue();

/// @notice Expected accessed index to be within the queue's length bounds.
/// @param index Index of the item in the queue.
/// @param length Number of elements in the queue.
error IndexOutOfBounds(uint256 index, uint256 length);

/// @notice Expected item to not be `address(0)`.
error InvalidItem();

/// @notice Expected item to not be part of the queue.
/// @param item Item to be inserted into the address queue.
error DuplicateItem(address item);

/// @notice Expected queue to not be empty.
error EmptyQueue();

/// @notice Expected accessed index to be within the queue's length bounds.
/// @param index Index of the item in the queue.
/// @param length Number of elements in the queue.
error IndexOutOfBounds(uint256 index, uint256 length);

/*
 *  @title AddressQueueHelpers
 *
 *  @notice Library to handle a queue of unique addresses and basic operations like enqueue and dequeue.
 *          It also supports O(1) existence check, and head, tail retrieval.
 *
 *  @dev Original implementation: https://github.com/chriseth/solidity-examples/blob/master/queue.sol
 */
library AddressQueueHelpers {
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
        if (a == address(0)) {
            revert InvalidItem();
        }
        if (q.items[a]) {
            revert DuplicateItem(a);
        }
        q.last += 1;
        q.queue[q.last] = a;
        q.items[a] = true;
    }

    // @notice Removes the address at the tail of the queue.
    // @param q Queue storage.
    function dequeue(AddressQueue storage q) internal returns (address) {
        if (q.last < q.first) {
            revert EmptyQueue();
        }
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
        uint256 qLen = length(q);
        if (index >= qLen) {
            revert IndexOutOfBounds(index, qLen);
        }
        return q.queue[q.first + index];
    }
}
