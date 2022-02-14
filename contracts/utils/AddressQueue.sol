//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

library AddressQueue {
    struct Queue {
        mapping(uint256 => address) queue;
        uint256 first;
        uint256 last;
    }

    function init(Queue storage q) internal {
        q.first = 1;
        q.last = 0;
    }
        
    function enqueue(Queue storage q, address a) internal {
        q.last += 1;
        q.queue[q.last] = a;
    }

    function dequeue(Queue storage q) internal returns (address) {
        require(q.last >= q.first);  // non-empty queue

        address a = q.queue[q.first];

        delete q.queue[q.first];
        q.first += 1;
        return a;
    }

    function head(Queue storage q) internal view returns (address) {
        return q.queue[q.first];
    }

    function tail(Queue storage q) internal view returns (address) {
        return q.queue[q.last];
    }

}
