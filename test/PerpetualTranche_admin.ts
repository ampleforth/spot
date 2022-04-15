import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Transaction, Signer, constants } from "ethers";

import {
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  depositIntoBond,
  getTranches,
  toFixedPtAmt,
  toYieldFixedPtAmt,
} from "./helpers";

let perp: Contract,
  issuer: Contract,
  feeStrategy: Contract,
  pricingStrategy: Contract,
  deployer: Signer,
  otherUser: Signer;
describe("PerpetualTranche", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    const BondIssuer = await ethers.getContractFactory("MockBondIssuer");
    issuer = await BondIssuer.deploy();

    const FeeStrategy = await ethers.getContractFactory("MockFeeStrategy");
    feeStrategy = await FeeStrategy.deploy();

    const PricingStrategy = await ethers.getContractFactory("MockPricingStrategy");
    pricingStrategy = await PricingStrategy.deploy();

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await PerpetualTranche.deploy("PerpetualTranche", "PERP", 9);
    await perp.init(issuer.address, feeStrategy.address, pricingStrategy.address);
  });

  describe("#init", function () {
    it("should set erc20 parameters", async function () {
      expect(await perp.name()).to.eq("PerpetualTranche");
      expect(await perp.symbol()).to.eq("PERP");
      expect(await perp.decimals()).to.eq(9);
    });

    it("should set owner", async function () {
      expect(await perp.owner()).to.eq(await deployer.getAddress());
    });

    it("should set ext service references", async function () {
      expect(await perp.bondIssuer()).to.eq(issuer.address);
      expect(await perp.feeStrategy()).to.eq(feeStrategy.address);
      expect(await perp.pricingStrategy()).to.eq(pricingStrategy.address);
    });

    it("should set fund pool references", async function () {
      expect(await perp.reserve()).to.eq(perp.address);
      expect(await perp.feeCollector()).to.eq(perp.address);
    });

    it("should initialize lists", async function () {
      expect(await perp.reserveCount()).to.eq(0);
      expect(await perp.redemptionQueueCount()).to.eq(0);
    });

    it("should set hyper parameters", async function () {
      expect(await perp.minTrancheMaturiySec()).to.eq(0);
      expect(await perp.maxTrancheMaturiySec()).to.eq(constants.MaxUint256);
    });
  });

  describe("#updateBondIssuer", function () {
    let newIssuer: Contract, tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updateBondIssuer(constants.AddressZero)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set address is NOT valid", function () {
      it("should revert", async function () {
        await expect(perp.updateBondIssuer(constants.AddressZero)).to.be.revertedWith(
          "Expected new bond minter to be set",
        );
      });
    });

    describe("when set address is valid", function () {
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("MockBondIssuer");
        newIssuer = await BondIssuer.deploy();
        tx = perp.updateBondIssuer(newIssuer.address);
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.bondIssuer()).to.eq(newIssuer.address);
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(perp, "UpdatedBondIssuer").withArgs(newIssuer.address);
      });
    });
  });

  describe("#updateFeeStrategy", function () {
    let newFeeStrategy: Contract, tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updateFeeStrategy(constants.AddressZero)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set address is NOT valid", function () {
      it("should revert", async function () {
        await expect(perp.updateFeeStrategy(constants.AddressZero)).to.be.revertedWith(
          "Expected new fee strategy to be set",
        );
      });
    });

    describe("when set address is valid", function () {
      beforeEach(async function () {
        const FeeStrategy = await ethers.getContractFactory("MockFeeStrategy");
        newFeeStrategy = await FeeStrategy.deploy();
        tx = perp.updateFeeStrategy(newFeeStrategy.address);
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.feeStrategy()).to.eq(newFeeStrategy.address);
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(perp, "UpdatedFeeStrategy").withArgs(newFeeStrategy.address);
      });
    });
  });

  describe("#updatePricingStrategy", function () {
    let newPricingStrategy: Contract, tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updatePricingStrategy(constants.AddressZero)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set address is NOT valid", function () {
      it("should revert", async function () {
        await expect(perp.updatePricingStrategy(constants.AddressZero)).to.be.revertedWith(
          "Expected new pricing strategy to be set",
        );
      });
    });

    describe("when new strategy has different decimals", function () {
      beforeEach(async function () {
        const PricingStrategy = await ethers.getContractFactory("MockPricingStrategy");
        newPricingStrategy = await PricingStrategy.deploy();
        await newPricingStrategy.setDecimals(18);
      });
      it("should revert", async function () {
        await expect(perp.updatePricingStrategy(newPricingStrategy.address)).to.be.revertedWith(
          "Expected new pricing strategy to use same decimals",
        );
      });
    });

    describe("when set address is valid", function () {
      beforeEach(async function () {
        const PricingStrategy = await ethers.getContractFactory("MockPricingStrategy");
        newPricingStrategy = await PricingStrategy.deploy();
        tx = perp.updatePricingStrategy(newPricingStrategy.address);
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.pricingStrategy()).to.eq(newPricingStrategy.address);
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(perp, "UpdatedPricingStrategy").withArgs(newPricingStrategy.address);
      });
    });
  });

  describe("#updateTolerableTrancheMaturiy", function () {
    let tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updateTolerableTrancheMaturiy(0, 0)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set values are not valid", function () {
      it("should revert", async function () {
        await expect(perp.updateTolerableTrancheMaturiy(86400, 3600)).to.be.revertedWith(
          "Expected max to be greater than min",
        );
      });
    });

    describe("when set values are valid", function () {
      beforeEach(async function () {
        tx = perp.updateTolerableTrancheMaturiy(3600, 86400);
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.minTrancheMaturiySec()).to.eq(3600);
        expect(await perp.maxTrancheMaturiySec()).to.eq(86400);
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(perp, "UpdatedTolerableTrancheMaturiy").withArgs(3600, 86400);
      });
    });
  });

  describe("#updateDefinedYield", function () {
    let tx: Transaction, tranche: Contract, classHash: string;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updateDefinedYield(constants.HashZero, 0)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when triggered by owner", function () {
      beforeEach(async function () {
        const bondFactory = await setupBondFactory();
        const { collateralToken } = await setupCollateralToken("Bitcoin", "BTC");
        const bond = await createBondWithFactory(bondFactory, collateralToken, [1000], 86400);
        const tranches = await getTranches(bond);
        tranche = tranches[0];

        classHash = await perp.trancheClass(tranche.address);
        tx = perp.updateDefinedYield(classHash, toYieldFixedPtAmt("1"));
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.trancheYield(tranche.address)).to.eq(toYieldFixedPtAmt("1"));
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(perp, "UpdatedDefinedTrancheYields").withArgs(classHash, toYieldFixedPtAmt("1"));
      });
    });
  });

  describe("#transferERC20", function () {
    let transferToken: Contract, toAddress: string;

    beforeEach(async function () {
      const Token = await ethers.getContractFactory("MockERC20");
      transferToken = await Token.deploy("Mock Token", "MOCK");
      await transferToken.mint(perp.address, "100");
      toAddress = await deployer.getAddress();
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).transferERC20(transferToken.address, toAddress, "100")).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when non reserve asset", function () {
      it("should transfer", async function () {
        await expect(() => perp.transferERC20(transferToken.address, toAddress, "100")).to.changeTokenBalance(
          transferToken,
          deployer,
          "100",
        );
      });
    });

    describe("when reserve asset", function () {
      beforeEach(async function () {
        const bondFactory = await setupBondFactory();
        const { collateralToken } = await setupCollateralToken("Bitcoin", "BTC");
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        const issuer = await BondIssuer.deploy(
          bondFactory.address,
          3600,
          120,
          86400,
          collateralToken.address,
          [200, 300, 500],
        );
        await issuer.issue();
        await perp.updateBondIssuer(issuer.address);
        await perp.updateTolerableTrancheMaturiy(0, constants.MaxUint256);

        const BondController = await ethers.getContractFactory("BondController");
        const bond = await BondController.attach(await issuer.callStatic.getLatestBond());
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        const tranche = (await getTranches(bond))[0];

        await perp.updateDefinedYield(await perp.trancheClass(tranche.address), toYieldFixedPtAmt("1"));
        await tranche.approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranche.address, toFixedPtAmt("200"));

        transferToken = tranche;
        expect(await perp.inReserve(transferToken.address)).to.eq(true);
      });

      it("should revert", async function () {
        await expect(perp.transferERC20(transferToken.address, toAddress, toFixedPtAmt("100"))).to.be.revertedWith(
          "Expected token to NOT be reserve asset",
        );
      });
    });
  });
});
