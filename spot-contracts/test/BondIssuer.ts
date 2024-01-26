import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Contract, Transaction, Signer } from "ethers";

import { TimeHelpers, setupBondFactory, bondAt } from "./helpers";

const START_TIME = 2499998400;
const mockTime = (x: number) => START_TIME + x;

let bondFactory: Contract, token: Contract, issuer: Contract, deployer: Signer, otherUser: Signer;
describe("BondIssuer", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];
    bondFactory = await setupBondFactory();
    const Token = await ethers.getContractFactory("MockERC20");
    token = await Token.deploy();
    await token.init("Test token", "TEST");
    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await BondIssuer.deploy(bondFactory.address, token.address);
    await issuer.init(86400, [200, 300, 500], 3600, 900);
    await TimeHelpers.setNextBlockTimestamp(mockTime(0));
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#setup", function () {
    it("should set storage parameters", async function () {
      expect(await issuer.owner()).to.eq(await deployer.getAddress());
      expect(await issuer.bondFactory()).to.eq(bondFactory.address);
      expect(await issuer.minIssueTimeIntervalSec()).to.eq(3600);
      expect(await issuer.issueWindowOffsetSec()).to.eq(900);
      expect(await issuer.maxMaturityDuration()).to.eq(86400);
      expect(await issuer.collateral()).to.eq(token.address);
      expect(await issuer.trancheRatios(0)).to.eq(200);
      expect(await issuer.trancheRatios(1)).to.eq(300);
      expect(await issuer.trancheRatios(2)).to.eq(500);
      expect(await issuer.lastIssueWindowTimestamp()).to.eq(0);
      expect(await issuer.issuedCount()).to.eq(0);
      await expect(issuer.issuedBondAt(0)).to.be.reverted;
      expect(await issuer.activeCount()).to.eq(0);
      await expect(issuer.activeBondAt(0)).to.be.reverted;
    });
  });

  describe("#updateMaxMaturityDuration", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(issuer.connect(otherUser).updateMaxMaturityDuration(86400)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    it("should update the bond duration", async function () {
      await issuer.updateMaxMaturityDuration(864000);
      expect(await issuer.maxMaturityDuration()).to.eq(864000);
    });
  });

  describe("#updateTrancheRatios", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(issuer.connect(otherUser).updateTrancheRatios([200, 300, 500])).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when tranche ratios are improper", function () {
      it("should revert", async function () {
        await expect(issuer.updateTrancheRatios([200, 300, 501])).to.be.revertedWithCustomError(
          issuer,
          "UnacceptableTrancheRatios",
        );
      });
    });

    it("should update the tranche ratios", async function () {
      await issuer.updateTrancheRatios([300, 700]);
      expect(await issuer.trancheRatios(0)).to.eq(300);
      expect(await issuer.trancheRatios(1)).to.eq(700);
    });
  });

  describe("#updateIssuanceTimingConfig", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(issuer.connect(otherUser).updateIssuanceTimingConfig(7200, 240)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    it("should update the timing config", async function () {
      await issuer.updateIssuanceTimingConfig(7200, 240);
      expect(await issuer.minIssueTimeIntervalSec()).to.eq(7200);
      expect(await issuer.issueWindowOffsetSec()).to.eq(240);
    });
  });

  describe("#issue", function () {
    describe("when sufficient time has passed", function () {
      it("should issue a new bond", async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(901));
        const tx = await issuer.issue();
        const txR = await tx.wait();
        const bondIssuedEvent = txR.events[txR.events.length - 1];
        const bond = bondIssuedEvent.args.bond;

        expect(tx).to.emit(issuer, "BondIssued");
        expect(await issuer.isInstance(bond)).to.eq(true);
        expect(await issuer.callStatic.getLatestBond()).to.eq(bond);
        expect(await issuer.lastIssueWindowTimestamp()).to.eq(mockTime(900));

        expect(await issuer.issuedCount()).to.eq(1);
        expect(await issuer.issuedBondAt(0)).to.eq(bond);
        await expect(issuer.issuedBondAt(1)).to.be.reverted;

        expect(await issuer.activeCount()).to.eq(1);
        expect(await issuer.activeBondAt(0)).to.eq(bond);
        await expect(issuer.activeBondAt(1)).to.be.reverted;

        await TimeHelpers.setNextBlockTimestamp(mockTime(4495));
        await expect(issuer.issue()).not.to.emit(issuer, "BondIssued");
        expect(await issuer.lastIssueWindowTimestamp()).to.eq(mockTime(900));

        await TimeHelpers.setNextBlockTimestamp(mockTime(4501));
        await expect(issuer.issue()).to.emit(issuer, "BondIssued");
        expect(await issuer.lastIssueWindowTimestamp()).to.eq(mockTime(4500));

        expect(await issuer.issuedCount()).to.eq(2);
        await expect(issuer.issuedBondAt(2)).to.be.reverted;
        expect(await issuer.activeCount()).to.eq(2);
        await expect(issuer.activeBondAt(2)).to.be.reverted;

        await TimeHelpers.setNextBlockTimestamp(mockTime(4505));
        await expect(issuer.issue()).not.to.emit(issuer, "BondIssued");
        expect(await issuer.lastIssueWindowTimestamp()).to.eq(mockTime(4500));
      });
    });

    describe("for various elapsed times lastIssueWindowTimestamp", function () {
      beforeEach(async function () {
        expect(await issuer.lastIssueWindowTimestamp()).to.eq("0");
      });

      it("should should snap down", async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(3500));
        await expect(issuer.issue()).to.emit(issuer, "BondIssued");
        expect(await issuer.lastIssueWindowTimestamp()).to.eq(mockTime(900));
      });

      it("should should snap down", async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(3595));
        await expect(issuer.issue()).to.emit(issuer, "BondIssued");
        expect(await issuer.lastIssueWindowTimestamp()).to.eq(mockTime(900));
      });

      it("should should snap down", async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(3600));
        await expect(issuer.issue()).to.emit(issuer, "BondIssued");
        expect(await issuer.lastIssueWindowTimestamp()).to.eq(mockTime(900));
      });

      it("should should snap down", async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(4495));
        await expect(issuer.issue()).to.emit(issuer, "BondIssued");
        expect(await issuer.lastIssueWindowTimestamp()).to.eq(mockTime(900));
      });

      it("should should snap down", async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(4500));
        await expect(issuer.issue()).to.emit(issuer, "BondIssued");
        expect(await issuer.lastIssueWindowTimestamp()).to.eq(mockTime(4500));
      });

      it("should should snap down", async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(4501));
        await expect(issuer.issue()).to.emit(issuer, "BondIssued");
        expect(await issuer.lastIssueWindowTimestamp()).to.eq(mockTime(4500));
      });

      it("should should snap down", async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(4600));
        await expect(issuer.issue()).to.emit(issuer, "BondIssued");
        expect(await issuer.lastIssueWindowTimestamp()).to.eq(mockTime(4500));
      });
    });
  });

  describe("#getLatestBond", function () {
    describe("when a new bond is up to be issued", function () {
      it("should issue a new bond and return the new bond", async function () {
        const bond = await issuer.callStatic.getLatestBond();
        await expect(issuer.getLatestBond()).to.emit(issuer, "BondIssued").withArgs(bond);
      });
    });

    describe("when a new bond has been issued", function () {
      it("should return the last bond", async function () {
        const tx = await issuer.issue();
        const txR = await tx.wait();
        const bondIssuedEvent = txR.events[txR.events.length - 1];
        const bond = bondIssuedEvent.args.bond;
        expect(await issuer.callStatic.getLatestBond()).to.eq(bond);
        await expect(issuer.getLatestBond()).to.not.emit(issuer, "BondIssued");
      });
    });
  });

  describe("#matureActive", function () {
    describe("active set has one bond and it is NOT up for maturity", function () {
      beforeEach(async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(900));
        await issuer.issue();
        await TimeHelpers.setNextBlockTimestamp(mockTime(87295));
      });

      it("should revert", async function () {
        await expect(issuer.matureActive()).to.be.revertedWithCustomError(issuer, "NoMaturedBonds");
      });
    });

    describe("active set has one bond and it is up for maturity", function () {
      let lastBond: Contract, tx: Transaction;
      beforeEach(async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(900));
        await issuer.issue();
        lastBond = await bondAt(await issuer.callStatic.getLatestBond());
        expect(await issuer.issuedCount()).to.eq(1);
        expect(await issuer.issuedBondAt(0)).to.eq(lastBond.address);
        expect(await issuer.activeCount()).to.eq(1);
        expect(await issuer.activeBondAt(0)).to.eq(lastBond.address);

        await TimeHelpers.setNextBlockTimestamp(mockTime(87301));
        tx = issuer.matureActive();
        await tx;
      });
      it("should emit mature", async function () {
        await expect(tx).to.emit(issuer, "BondMature").withArgs(lastBond.address);
        await expect(tx).to.emit(lastBond, "Mature");
      });
      it("should keep track of active and mature bonds", async function () {
        expect(await issuer.issuedCount()).to.eq(1);
        expect(await issuer.issuedBondAt(0)).to.eq(lastBond.address);
        expect(await issuer.activeCount()).to.eq(0);
        await expect(issuer.activeBondAt(0)).to.be.reverted;
      });
    });

    describe("active set has one bond and it is up for maturity by `mature` was already invoked", function () {
      let lastBond: Contract, tx: Transaction;
      beforeEach(async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(900));
        await issuer.issue();
        lastBond = await bondAt(await issuer.callStatic.getLatestBond());
        expect(await issuer.issuedCount()).to.eq(1);
        expect(await issuer.issuedBondAt(0)).to.eq(lastBond.address);

        await TimeHelpers.setNextBlockTimestamp(mockTime(87301));
        await lastBond.mature();
        tx = issuer.matureActive();
        await tx;
      });
      it("should NOT emit mature", async function () {
        await expect(tx).to.emit(issuer, "BondMature");
        await expect(tx).not.to.emit(lastBond, "Mature");
      });
      it("should keep track of active and mature bonds", async function () {
        expect(await issuer.issuedCount()).to.eq(1);
        expect(await issuer.issuedBondAt(0)).to.eq(lastBond.address);
        expect(await issuer.activeCount()).to.eq(0);
        await expect(issuer.activeBondAt(0)).to.be.reverted;
      });
    });

    describe("active set has many bonds and one is up for maturity", function () {
      let b1: Contract, b2: Contract, b3: Contract, tx: Transaction;
      beforeEach(async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(900));
        await issuer.issue();
        b1 = await bondAt(await issuer.callStatic.getLatestBond());

        await TimeHelpers.setNextBlockTimestamp(mockTime(83700));
        await issuer.issue();
        b2 = await bondAt(await issuer.callStatic.getLatestBond());

        await TimeHelpers.setNextBlockTimestamp(mockTime(87300));
        await issuer.issue();
        b3 = await bondAt(await issuer.callStatic.getLatestBond());

        expect(await issuer.issuedCount()).to.eq(3);
        expect(await issuer.issuedBondAt(0)).to.eq(b1.address);
        expect(await issuer.issuedBondAt(1)).to.eq(b2.address);
        expect(await issuer.issuedBondAt(2)).to.eq(b3.address);

        expect(await issuer.activeCount()).to.eq(3);
        expect(await issuer.activeBondAt(0)).to.eq(b1.address);
        expect(await issuer.activeBondAt(1)).to.eq(b2.address);
        expect(await issuer.activeBondAt(2)).to.eq(b3.address);

        tx = issuer.matureActive();
        await tx;
      });
      it("should emit mature on the oldest bond", async function () {
        await expect(tx).to.emit(b1, "Mature");
        await expect(tx).to.emit(issuer, "BondMature").withArgs(b1.address);
      });
      it("should keep track of active and mature bonds", async function () {
        expect(await issuer.issuedCount()).to.eq(3);
        expect(await issuer.issuedBondAt(0)).to.eq(b1.address);
        expect(await issuer.issuedBondAt(1)).to.eq(b2.address);
        expect(await issuer.issuedBondAt(2)).to.eq(b3.address);
        expect(await issuer.activeCount()).to.eq(2);
        expect(await issuer.activeBondAt(0)).to.eq(b3.address);
        expect(await issuer.activeBondAt(1)).to.eq(b2.address);
        await expect(issuer.activeBondAt(2)).to.be.reverted;
      });
    });

    describe("active set has many bonds and many are up for maturity", function () {
      let b1: Contract, b2: Contract, b3: Contract, tx: Transaction;
      beforeEach(async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(900));
        await issuer.issue();
        b1 = await bondAt(await issuer.callStatic.getLatestBond());

        await TimeHelpers.setNextBlockTimestamp(mockTime(83700));
        await issuer.issue();
        b2 = await bondAt(await issuer.callStatic.getLatestBond());

        await TimeHelpers.setNextBlockTimestamp(mockTime(87300));
        await issuer.issue();
        b3 = await bondAt(await issuer.callStatic.getLatestBond());

        await TimeHelpers.setNextBlockTimestamp(mockTime(170100));

        expect(await issuer.issuedCount()).to.eq(3);
        expect(await issuer.issuedBondAt(0)).to.eq(b1.address);
        expect(await issuer.issuedBondAt(1)).to.eq(b2.address);
        expect(await issuer.issuedBondAt(2)).to.eq(b3.address);

        expect(await issuer.activeCount()).to.eq(3);
        expect(await issuer.activeBondAt(0)).to.eq(b1.address);
        expect(await issuer.activeBondAt(1)).to.eq(b2.address);
        expect(await issuer.activeBondAt(2)).to.eq(b3.address);

        tx = issuer.matureActive();
        await tx;
      });
      it("should emit mature", async function () {
        await expect(tx).to.emit(b1, "Mature");
        await expect(tx).to.emit(issuer, "BondMature").withArgs(b1.address);
        await expect(tx).to.emit(b2, "Mature");
        await expect(tx).to.emit(issuer, "BondMature").withArgs(b2.address);
      });
      it("should keep track of active and mature bonds", async function () {
        expect(await issuer.issuedCount()).to.eq(3);
        expect(await issuer.issuedBondAt(0)).to.eq(b1.address);
        expect(await issuer.issuedBondAt(1)).to.eq(b2.address);
        expect(await issuer.issuedBondAt(2)).to.eq(b3.address);
        expect(await issuer.activeCount()).to.eq(1);
        expect(await issuer.activeBondAt(0)).to.eq(b3.address);
        await expect(issuer.activeBondAt(1)).to.be.reverted;
      });
    });

    describe("active set has many bonds and all are up for maturity", function () {
      let b1: Contract, b2: Contract, b3: Contract, tx: Transaction;
      beforeEach(async function () {
        await TimeHelpers.setNextBlockTimestamp(mockTime(900));
        await issuer.issue();
        b1 = await bondAt(await issuer.callStatic.getLatestBond());

        await TimeHelpers.setNextBlockTimestamp(mockTime(83700));
        await issuer.issue();
        b2 = await bondAt(await issuer.callStatic.getLatestBond());

        await TimeHelpers.setNextBlockTimestamp(mockTime(87300));
        await issuer.issue();
        b3 = await bondAt(await issuer.callStatic.getLatestBond());

        await TimeHelpers.setNextBlockTimestamp(mockTime(260100));

        expect(await issuer.issuedCount()).to.eq(3);
        expect(await issuer.issuedBondAt(0)).to.eq(b1.address);
        expect(await issuer.issuedBondAt(1)).to.eq(b2.address);
        expect(await issuer.issuedBondAt(2)).to.eq(b3.address);

        expect(await issuer.activeCount()).to.eq(3);
        expect(await issuer.activeBondAt(0)).to.eq(b1.address);
        expect(await issuer.activeBondAt(1)).to.eq(b2.address);
        expect(await issuer.activeBondAt(2)).to.eq(b3.address);

        tx = issuer.matureActive();
        await tx;
      });
      it("should emit mature", async function () {
        await expect(tx).to.emit(b1, "Mature");
        await expect(tx).to.emit(issuer, "BondMature").withArgs(b1.address);
        await expect(tx).to.emit(b2, "Mature");
        await expect(tx).to.emit(issuer, "BondMature").withArgs(b2.address);
        await expect(tx).to.emit(b3, "Mature");
        await expect(tx).to.emit(issuer, "BondMature").withArgs(b3.address);
      });
      it("should keep track of active and mature bonds", async function () {
        expect(await issuer.issuedCount()).to.eq(3);
        expect(await issuer.issuedBondAt(0)).to.eq(b1.address);
        expect(await issuer.issuedBondAt(1)).to.eq(b2.address);
        expect(await issuer.issuedBondAt(2)).to.eq(b3.address);
        expect(await issuer.activeCount()).to.eq(0);
        await expect(issuer.activeBondAt(0)).to.be.reverted;
      });
    });
  });
});
