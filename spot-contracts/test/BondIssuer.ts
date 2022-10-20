import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Signer } from "ethers";

import { TimeHelpers, setupBondFactory } from "./helpers";

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
    await issuer.init(86400, [200, 300, 500], 3600, 120);
  });

  describe("#setup", function () {
    it("should set storage parameters", async function () {
      expect(await issuer.owner()).to.eq(await deployer.getAddress());
      expect(await issuer.bondFactory()).to.eq(bondFactory.address);
      expect(await issuer.minIssueTimeIntervalSec()).to.eq(3600);
      expect(await issuer.issueWindowOffsetSec()).to.eq(120);
      expect(await issuer.maxMaturityDuration()).to.eq(86400);
      expect(await issuer.collateral()).to.eq(token.address);
      expect(await issuer.trancheRatios(0)).to.eq(200);
      expect(await issuer.trancheRatios(1)).to.eq(300);
      expect(await issuer.trancheRatios(2)).to.eq(500);
      expect(await issuer.lastIssueWindowTimestamp()).to.eq(0);
      expect(await issuer.issuedCount()).to.eq(0);
      await expect(issuer.issuedBondAt(0)).to.be.reverted;
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
        await expect(issuer.updateTrancheRatios([200, 300, 501])).to.be.revertedWith(
          "BondIssuer: Invalid tranche ratios",
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
        await TimeHelpers.setNextBlockTimestamp(2499998400);
        const tx = await issuer.issue();
        const txR = await tx.wait();
        const bondIssuedEvent = txR.events[txR.events.length - 1];
        const bond = bondIssuedEvent.args.bond;

        expect(tx).to.emit(issuer, "BondIssued");
        expect(await issuer.isInstance(bond)).to.eq(true);
        expect(await issuer.callStatic.getLatestBond()).to.eq(bond);
        expect(await issuer.lastIssueWindowTimestamp()).to.eq(2499998520);

        expect(await issuer.issuedCount()).to.eq(1);
        expect(await issuer.issuedBondAt(0)).to.eq(bond);
        await expect(issuer.issuedBondAt(1)).to.be.reverted;

        await TimeHelpers.setNextBlockTimestamp(2500002120);
        await expect(issuer.issue()).to.emit(issuer, "BondIssued");
        expect(await issuer.lastIssueWindowTimestamp()).to.eq(2500002120);

        expect(await issuer.issuedCount()).to.eq(2);
        await expect(issuer.issuedBondAt(1)).to.not.be.reverted;
      });
    });

    describe("when sufficient time has not passed", function () {
      it("should not issue a new bond", async function () {
        await TimeHelpers.setNextBlockTimestamp(2500005720);
        await expect(issuer.issue()).to.emit(issuer, "BondIssued");
        expect(await issuer.issuedCount()).to.eq(1);

        await TimeHelpers.setNextBlockTimestamp(2500009310);
        await expect(issuer.issue()).not.to.emit(issuer, "BondIssued");
        expect(await issuer.issuedCount()).to.eq(1);

        await TimeHelpers.setNextBlockTimestamp(2500009320);
        await expect(issuer.issue()).to.emit(issuer, "BondIssued");
        expect(await issuer.issuedCount()).to.eq(2);
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
});
