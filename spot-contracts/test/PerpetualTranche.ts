import { expect } from "chai";
import { ethers } from "hardhat";
import { Contract, Transaction, Signer, constants } from "ethers";

import {
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toYieldFixedPtAmt,
  toPriceFixedPtAmt,
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
      expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(0);
    });

    it("should set hyper parameters", async function () {
      expect(await perp.minTrancheMaturiySec()).to.eq(1);
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
          "Expected new bond issuer to be set",
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

        const bond = await bondAt(await issuer.callStatic.getLatestBond());
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

  describe("#trancheClass", function () {
    let bondFactory: Contract, collateralToken: Contract, tranches: Contract[];
    beforeEach(async function () {
      bondFactory = await setupBondFactory();
      ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));
      const bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
      tranches = await getTranches(bond);
    });
    describe("given a tranche", function () {
      it("should compute the tranche hash", async function () {
        const types = ["address", "uint256[]", "uint256"];
        const abiCoder = ethers.utils.defaultAbiCoder;
        const c0 = await ethers.utils.keccak256(abiCoder.encode(types, [collateralToken.address, [200, 300, 500], 0]));
        const c1 = await ethers.utils.keccak256(abiCoder.encode(types, [collateralToken.address, [200, 300, 500], 1]));
        const c2 = await ethers.utils.keccak256(abiCoder.encode(types, [collateralToken.address, [200, 300, 500], 2]));
        expect(await perp.trancheClass(tranches[0].address)).to.eq(c0);
        expect(await perp.trancheClass(tranches[1].address)).to.eq(c1);
        expect(await perp.trancheClass(tranches[2].address)).to.eq(c2);
      });
    });

    describe("when 2 tranches from same class", function () {
      let tranchesOther: Contract[];
      beforeEach(async function () {
        const bondOther = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
        tranchesOther = await getTranches(bondOther);
      });
      it("should have the same class hash", async function () {
        expect(await perp.trancheClass(tranches[0].address)).to.eq(await perp.trancheClass(tranchesOther[0].address));
        expect(await perp.trancheClass(tranches[1].address)).to.eq(await perp.trancheClass(tranchesOther[1].address));
        expect(await perp.trancheClass(tranches[2].address)).to.eq(await perp.trancheClass(tranchesOther[2].address));
      });
    });

    describe("when 2 tranches from different classes", function () {
      let tranchesOther: Contract[];
      beforeEach(async function () {
        const bondOther = await createBondWithFactory(bondFactory, collateralToken, [201, 300, 499], 3600);
        tranchesOther = await getTranches(bondOther);
      });
      it("should NOT have the same class hash", async function () {
        expect(await perp.trancheClass(tranches[0].address)).not.to.eq(
          await perp.trancheClass(tranchesOther[0].address),
        );
        expect(await perp.trancheClass(tranches[1].address)).not.to.eq(
          await perp.trancheClass(tranchesOther[1].address),
        );
        expect(await perp.trancheClass(tranches[2].address)).not.to.eq(
          await perp.trancheClass(tranchesOther[2].address),
        );
      });
    });
  });

  describe("#trancheYield", function () {
    let bondFactory: Contract, collateralToken: Contract, bond: Contract, tranches: Contract[];
    beforeEach(async function () {
      bondFactory = await setupBondFactory();
      ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));

      bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
      tranches = await getTranches(bond);
      await issuer.setLatestBond(bond.address);

      await perp.updateTolerableTrancheMaturiy(1200, 3600);
      await perp.updateDefinedYield(await perp.trancheClass(tranches[0].address), toYieldFixedPtAmt("1"));
    });

    describe("when tranche instance is not in the system", function () {
      it("should return defined yield", async function () {
        expect(await perp.trancheYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("1"));
      });
      describe("when not defined", function () {
        it("should return 0", async function () {
          expect(await perp.trancheYield(tranches[1].address)).to.eq(toYieldFixedPtAmt("0"));
          expect(await perp.trancheYield(tranches[2].address)).to.eq(toYieldFixedPtAmt("0"));
        });
      });
      describe("when updated", function () {
        beforeEach(async function () {
          await perp.updateDefinedYield(await perp.trancheClass(tranches[0].address), toYieldFixedPtAmt("0.5"));
        });
        it("should return defined yield", async function () {
          expect(await perp.trancheYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("0.5"));
        });
      });
    });

    describe("when tranche instance is already in system", function () {
      beforeEach(async function () {
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));
      });
      it("should return applied yield", async function () {
        expect(await perp.trancheYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("1"));
      });
      describe("when updated", function () {
        beforeEach(async function () {
          await perp.updateDefinedYield(await perp.trancheClass(tranches[0].address), toYieldFixedPtAmt("0.5"));
        });
        it("should return applied yield", async function () {
          expect(await perp.trancheYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("1"));
        });
      });
    });

    describe("when a new tranche instance enters the system", function () {
      let tranchesNext: Contract[];
      beforeEach(async function () {
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

        const bondNext = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
        tranchesNext = await getTranches(bondNext);
        await issuer.setLatestBond(bondNext.address);
      });
      it("should return defined yield", async function () {
        expect(await perp.trancheYield(tranchesNext[0].address)).to.eq(toYieldFixedPtAmt("1"));
      });
      describe("when updated", function () {
        beforeEach(async function () {
          await perp.updateDefinedYield(await perp.trancheClass(tranches[0].address), toYieldFixedPtAmt("0.5"));
        });
        it("should return defined yield for new tranche", async function () {
          expect(await perp.trancheYield(tranchesNext[0].address)).to.eq(toYieldFixedPtAmt("0.5"));
        });
        it("should return applied yield for old tranche", async function () {
          expect(await perp.trancheYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("1"));
        });
      });
    });
  });

  describe("#tranchePrice", function () {
    beforeEach(async function () {
      expect(await perp.tranchePrice(constants.AddressZero)).not.to.eq(toPriceFixedPtAmt("0.33"));
      await pricingStrategy.setPrice(toPriceFixedPtAmt("0.33"));
    });
    it("should return the price from the strategy", async function () {
      expect(await perp.tranchePrice(constants.AddressZero)).to.eq(toPriceFixedPtAmt("0.33"));
    });
  });

  describe("#feeStrategy", function () {
    let feeToken: Contract;
    beforeEach(async function () {
      const ERC20 = await ethers.getContractFactory("MockERC20");
      feeToken = await ERC20.deploy("Mock token", "MOCK");
      expect(await perp.feeToken()).not.to.eq(feeToken.address);
      await feeStrategy.setFeeToken(feeToken.address);
    });

    it("should return the fee token from the strategy", async function () {
      expect(await perp.feeToken()).to.eq(feeToken.address);
    });
  });

  describe("#tranchesToPerps", function () {
    let tranche: Contract, trancheClass: string;
    beforeEach(async function () {
      const bondFactory = await setupBondFactory();
      const { collateralToken } = await setupCollateralToken("Bitcoin", "BTC");
      const bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
      tranche = (await getTranches(bond))[0];
      trancheClass = await perp.trancheClass(tranche.address);

      await perp.updateDefinedYield(trancheClass, toYieldFixedPtAmt("1"));
      await pricingStrategy.setPrice(toPriceFixedPtAmt("1"));
    });

    describe("when yield = 1 and price = 1", async function () {
      it("should return 1", async function () {
        expect(await perp.tranchesToPerps(tranche.address, toFixedPtAmt("1"))).to.eq(toFixedPtAmt("1"));
      });
    });

    describe("when yield is zero", async function () {
      beforeEach(async function () {
        await perp.updateDefinedYield(trancheClass, toYieldFixedPtAmt("0"));
      });
      it("should return zero", async function () {
        expect(await perp.tranchesToPerps(tranche.address, toFixedPtAmt("1"))).to.eq(0);
      });
    });

    describe("when price is zero", async function () {
      beforeEach(async function () {
        await pricingStrategy.setPrice(toPriceFixedPtAmt("0"));
      });
      it("should return zero", async function () {
        expect(await perp.tranchesToPerps(tranche.address, toFixedPtAmt("1"))).to.eq(0);
      });
    });

    describe("when yield = 0.5 and price = 0.5", async function () {
      beforeEach(async function () {
        await perp.updateDefinedYield(trancheClass, toYieldFixedPtAmt("0.5"));
        await pricingStrategy.setPrice(toPriceFixedPtAmt("0.5"));
      });
      it("should return 0.25", async function () {
        expect(await perp.tranchesToPerps(tranche.address, toFixedPtAmt("1"))).to.eq(toFixedPtAmt("0.25"));
      });
    });

    describe("when unit amount", async function () {
      it("should return perp amount", async function () {
        expect(await perp.tranchesToPerps(tranche.address, "1")).to.eq("1");
      });
    });

    describe("when amount is very large", async function () {
      it("should return perp amount", async function () {
        const largestTrancheAmt = constants.MaxUint256.div(toYieldFixedPtAmt("1"));
        expect(await perp.tranchesToPerps(tranche.address, largestTrancheAmt)).to.eq(largestTrancheAmt);
      });
    });
  });

  describe("#perpsToTranches", function () {
    let tranche: Contract, trancheClass: string;
    beforeEach(async function () {
      const bondFactory = await setupBondFactory();
      const { collateralToken } = await setupCollateralToken("Bitcoin", "BTC");
      const bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
      tranche = (await getTranches(bond))[0];
      trancheClass = await perp.trancheClass(tranche.address);

      await perp.updateDefinedYield(trancheClass, toYieldFixedPtAmt("1"));
      await pricingStrategy.setPrice(toPriceFixedPtAmt("1"));
    });

    describe("when yield = 1 and price = 1", async function () {
      it("should return 1", async function () {
        expect(await perp.perpsToTranches(tranche.address, toFixedPtAmt("1"))).to.eq(toFixedPtAmt("1"));
      });
    });

    describe("when yield is zero", async function () {
      beforeEach(async function () {
        await perp.updateDefinedYield(trancheClass, toYieldFixedPtAmt("0"));
      });
      it("should return zero", async function () {
        expect(await perp.perpsToTranches(tranche.address, toFixedPtAmt("1"))).to.eq(0);
      });
    });

    describe("when price is zero", async function () {
      beforeEach(async function () {
        await pricingStrategy.setPrice(toPriceFixedPtAmt("0"));
      });
      it("should return zero", async function () {
        expect(await perp.perpsToTranches(tranche.address, toFixedPtAmt("1"))).to.eq(0);
      });
    });

    describe("when yield = 0.5 and price = 0.5", async function () {
      beforeEach(async function () {
        await perp.updateDefinedYield(trancheClass, toYieldFixedPtAmt("0.5"));
        await pricingStrategy.setPrice(toPriceFixedPtAmt("0.5"));
      });
      it("should return tranche amount", async function () {
        expect(await perp.perpsToTranches(tranche.address, toFixedPtAmt("1"))).to.eq(toFixedPtAmt("4"));
      });
    });

    describe("when yield = 1 and price = 0.3", async function () {
      beforeEach(async function () {
        await pricingStrategy.setPrice(toPriceFixedPtAmt("0.3"));
      });
      it("should return tranche amount", async function () {
        expect(await perp.perpsToTranches(tranche.address, toFixedPtAmt("1"))).to.eq("3333333333");
      });
    });

    describe("when unit amount", async function () {
      it("should return tranche amount", async function () {
        expect(await perp.perpsToTranches(tranche.address, "1")).to.eq("1");
      });
    });

    describe("when amount is very large", async function () {
      it("should return tranche amount", async function () {
        const largestPerpAmount = constants.MaxUint256.div(toYieldFixedPtAmt("1"));
        expect(await perp.perpsToTranches(tranche.address, largestPerpAmount)).to.eq(largestPerpAmount);
      });
    });
  });

  describe("#perpsToCoveredTranches", function () {
    let tranche: Contract, trancheClass: string;
    beforeEach(async function () {
      const bondFactory = await setupBondFactory();
      const { collateralToken } = await setupCollateralToken("Bitcoin", "BTC");
      const bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);

      tranche = (await getTranches(bond))[0];
      trancheClass = await perp.trancheClass(tranche.address);

      await perp.updateDefinedYield(trancheClass, toYieldFixedPtAmt("1"));
      await pricingStrategy.setPrice(toPriceFixedPtAmt("1"));
    });

    describe("when tranche balance is 0", function () {
      it("should return the 0 tranche amount and remainders", async function () {
        const r = await perp.perpsToCoveredTranches(tranche.address, toFixedPtAmt("200"), constants.MaxUint256);
        expect(r[0]).to.eq(toFixedPtAmt("0"));
        expect(r[1]).to.eq(toFixedPtAmt("200"));
      });
    });

    describe("when tranche balance is > 0", function () {
      beforeEach(async function () {
        await tranche.transfer(perp.address, toFixedPtAmt("200"));
      });

      describe("when requested amount is covered", async function () {
        it("should return the tranche amount and remainders", async function () {
          const r = await perp.perpsToCoveredTranches(tranche.address, toFixedPtAmt("33"), constants.MaxUint256);
          expect(r[0]).to.eq(toFixedPtAmt("33"));
          expect(r[1]).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("when requested amount is covered", async function () {
        it("should return the tranche amount and remainders", async function () {
          const r = await perp.perpsToCoveredTranches(tranche.address, toFixedPtAmt("200"), constants.MaxUint256);
          expect(r[0]).to.eq(toFixedPtAmt("200"));
          expect(r[1]).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("when requested amount is NOT covered", async function () {
        it("should return the tranche amount and remainders", async function () {
          const r = await perp.perpsToCoveredTranches(
            tranche.address,
            toFixedPtAmt("200").add("1"),
            constants.MaxUint256,
          );
          expect(r[0]).to.eq(toFixedPtAmt("200"));
          expect(r[1]).to.eq("1");
        });
      });

      describe("when requested amount is NOT covered", async function () {
        it("should return the tranche amount and remainders", async function () {
          const r = await perp.perpsToCoveredTranches(tranche.address, toFixedPtAmt("1000"), constants.MaxUint256);
          expect(r[0]).to.eq(toFixedPtAmt("200"));
          expect(r[1]).to.eq(toFixedPtAmt("800"));
        });
      });

      describe("when max covered is less than the balance", function () {
        it("should return the tranche amount and remainders", async function () {
          const r = await perp.perpsToCoveredTranches(tranche.address, toFixedPtAmt("200"), toFixedPtAmt("33"));
          expect(r[0]).to.eq(toFixedPtAmt("33"));
          expect(r[1]).to.eq(toFixedPtAmt("167"));
        });
      });
    });
  });
});
