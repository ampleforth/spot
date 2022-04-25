import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, constants, utils } from "ethers";

const ADDRESSES = [
  "0x09750ad360fdb7a2ee23669c4503c974d86d8694",
  "0xc915eC7f4CFD1C0A8Aba090F03BfaAb588aEF9B4",
  "0xecb6ffaC05D8b4660b99B475B359FE454c77D153",
  "0x7F85A82a2da50540412F6E526F1D00A0690a77B8",
  "0xBc8b85b1515E45Fb2d74333310A1d37B879732c0",
  "0xBBF84F9b823c42896c9723C0BE4D5f5eDe257b52",
  "0xD5cE086A9d4987Adf088889A520De98299E10bb5",
  "0x6B5C35d525D2d94c68Ab5c5AF9729092fc8771Dd",
  "0x4541c7745c82DF8c10bD4A58e28161534B353064",
  "0x0a00Fb2e074Ffaaf6c561164C6458b5C448120FC",
].map(utils.getAddress);

let queue: Contract;
describe("QueueTester", function () {
  beforeEach(async function () {
    const QueueTester = await ethers.getContractFactory("QueueTester");
    queue = await QueueTester.deploy();
    await queue.deployed();
  });

  describe("initialization", function () {
    it("should setup the queue storage", async function () {
      expect(await queue.length()).to.eq(0);
      expect(await queue.head()).to.eq(constants.AddressZero);
      expect(await queue.tail()).to.eq(constants.AddressZero);
    });
  });

  describe("enqueue & dequeue", function () {
    it("should update the storage", async function () {
      await expect(queue.enqueue(constants.AddressZero)).to.be.revertedWith("AddressQueueHelpers: Expected valid item");

      // Adding 3 elements, removing all of them and
      // then 1 element and removing it.
      await queue.enqueue(ADDRESSES[0]);
      expect(await queue.length()).to.eq(1);
      expect(await queue.head()).to.eq(ADDRESSES[0]);
      expect(await queue.tail()).to.eq(ADDRESSES[0]);

      // attempting to add duplicate element
      await expect(queue.enqueue(ADDRESSES[0])).to.be.revertedWith(
        "AddressQueueHelpers: Expected item to NOT be in queue",
      );

      await queue.enqueue(ADDRESSES[1]);
      expect(await queue.length()).to.eq(2);
      expect(await queue.head()).to.eq(ADDRESSES[0]);
      expect(await queue.tail()).to.eq(ADDRESSES[1]);

      await queue.enqueue(ADDRESSES[2]);
      expect(await queue.length()).to.eq(3);
      expect(await queue.head()).to.eq(ADDRESSES[0]);
      expect(await queue.tail()).to.eq(ADDRESSES[2]);

      expect(await queue.callStatic.dequeue()).to.eq(ADDRESSES[0]);
      await queue.dequeue();
      expect(await queue.length()).to.eq(2);
      expect(await queue.head()).to.eq(ADDRESSES[1]);
      expect(await queue.tail()).to.eq(ADDRESSES[2]);

      expect(await queue.callStatic.dequeue()).to.eq(ADDRESSES[1]);
      await queue.dequeue();
      expect(await queue.length()).to.eq(1);
      expect(await queue.head()).to.eq(ADDRESSES[2]);
      expect(await queue.tail()).to.eq(ADDRESSES[2]);

      expect(await queue.callStatic.dequeue()).to.eq(ADDRESSES[2]);
      await queue.dequeue();
      expect(await queue.length()).to.eq(0);
      expect(await queue.head()).to.eq(constants.AddressZero);
      expect(await queue.tail()).to.eq(constants.AddressZero);

      await expect(queue.dequeue()).to.be.revertedWith("AddressQueueHelpers: Expected non-empty queue");

      await queue.enqueue(ADDRESSES[3]);
      expect(await queue.length()).to.eq(1);
      expect(await queue.head()).to.eq(ADDRESSES[3]);
      expect(await queue.tail()).to.eq(ADDRESSES[3]);

      expect(await queue.callStatic.dequeue()).to.eq(ADDRESSES[3]);
      await queue.dequeue();
      expect(await queue.length()).to.eq(0);
      expect(await queue.head()).to.eq(constants.AddressZero);
      expect(await queue.tail()).to.eq(constants.AddressZero);
    });
  });

  describe("iteration", function () {
    it("fetch items in order", async function () {
      // Inserting list of 10 addresses and iterating through them (0:9)
      for (const a in ADDRESSES) {
        expect(await queue.contains(ADDRESSES[a])).to.eq(false);
        await queue.enqueue(ADDRESSES[a]);
        expect(await queue.contains(ADDRESSES[a])).to.eq(true);
      }
      expect(await queue.length()).to.eq(ADDRESSES.length);
      for (const a in ADDRESSES) {
        expect(await queue.at(a)).to.eq(ADDRESSES[a]);
      }
      await expect(queue.at(ADDRESSES.length)).to.be.revertedWith(
        "AddressQueueHelpers: Expected index to be in bounds",
      );

      // Removing first 5 addresses and then iterating through them (0:4)
      for (const a in ADDRESSES) {
        if (parseInt(a) < 5) {
          await queue.dequeue();
        } else {
          const newIdx = parseInt(a) - 5;
          expect(await queue.at(newIdx)).to.eq(ADDRESSES[a]);
        }
      }
      await expect(queue.at(5)).to.be.revertedWith("AddressQueueHelpers: Expected index to be in bounds");
    });
  });
});
