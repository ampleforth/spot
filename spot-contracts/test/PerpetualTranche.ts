import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Transaction, Signer, constants } from "ethers";

import {
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  depositIntoBond,
  getTranches,
  toFixedPtAmt,
  toDiscountFixedPtAmt,
  toPriceFixedPtAmt,
  advancePerpQueue,
  bondAt,
  checkReserveComposition,
  TimeHelpers,
  rebase,
  advancePerpQueueToRollover,
} from "./helpers";

let perp: Contract,
  collateralToken: Contract,
  rebaseOracle: Contract,
  issuer: Contract,
  feeStrategy: Contract,
  pricingStrategy: Contract,
  discountStrategy: Contract,
  deployer: Signer,
  otherUser: Signer;
describe("PerpetualTranche", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));

    const BondIssuer = await ethers.getContractFactory("MockBondIssuer");
    issuer = await BondIssuer.deploy(collateralToken.address);

    const FeeStrategy = await ethers.getContractFactory("MockFeeStrategy");
    feeStrategy = await FeeStrategy.deploy();

    const PricingStrategy = await ethers.getContractFactory("MockPricingStrategy");
    pricingStrategy = await PricingStrategy.deploy();

    const DiscountStrategy = await ethers.getContractFactory("MockDiscountStrategy");
    discountStrategy = await DiscountStrategy.deploy();

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await upgrades.deployProxy(
      PerpetualTranche.connect(deployer),
      [
        "PerpetualTranche",
        "PERP",
        collateralToken.address,
        issuer.address,
        feeStrategy.address,
        pricingStrategy.address,
        discountStrategy.address,
      ],
      {
        initializer: "init(string,string,address,address,address,address,address)",
      },
    );
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#init", function () {
    it("should set erc20 parameters", async function () {
      expect(await perp.name()).to.eq("PerpetualTranche");
      expect(await perp.symbol()).to.eq("PERP");
      expect(await perp.decimals()).to.eq(18);
    });

    it("should set owner", async function () {
      expect(await perp.owner()).to.eq(await deployer.getAddress());
    });

    it("should set ext service references", async function () {
      expect(await perp.bondIssuer()).to.eq(issuer.address);
      expect(await perp.feeStrategy()).to.eq(feeStrategy.address);
      expect(await perp.pricingStrategy()).to.eq(pricingStrategy.address);
      expect(await perp.discountStrategy()).to.eq(discountStrategy.address);
    });

    it("should set collateral reference", async function () {
      expect(await perp.collateral()).to.eq(collateralToken.address);
    });

    it("should set collateral discount", async function () {
      expect(await perp.computeDiscount(collateralToken.address)).to.eq(toDiscountFixedPtAmt("1"));
    });

    it("should set fund pool references", async function () {
      expect(await perp.reserve()).to.eq(perp.address);
      expect(await perp.protocolFeeCollector()).to.eq(await deployer.getAddress());
      expect(await perp.perpERC20()).to.eq(perp.address);
    });

    it("should initialize lists", async function () {
      expect(await perp.callStatic.getReserveCount()).to.eq(1);
    });

    it("should initialize tranche balances", async function () {
      expect(await perp.callStatic.getReserveTrancheBalance(collateralToken.address)).to.eq(0);
      expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(0);
    });

    it("should set hyper parameters", async function () {
      expect(await perp.minTrancheMaturitySec()).to.eq(1);
      expect(await perp.maxTrancheMaturitySec()).to.eq(constants.MaxUint256);
      expect(await perp.maxSupply()).to.eq(constants.MaxUint256);
      expect(await perp.maxMintAmtPerTranche()).to.eq(constants.MaxUint256);
      expect(await perp.matureValueTargetPerc()).to.eq(0);
    });

    it("should NOT be paused", async function () {
      expect(await perp.paused()).to.eq(false);
    });
  });

  describe("#pause", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await perp.connect(deployer).updateKeeper(await otherUser.getAddress());
    });

    describe("when triggered by non-keeper", function () {
      it("should revert", async function () {
        await expect(perp.connect(deployer).pause()).to.be.revertedWith("UnauthorizedCall");
      });
    });

    describe("when already paused", function () {
      beforeEach(async function () {
        await perp.connect(otherUser).pause();
      });
      it("should revert", async function () {
        await expect(perp.connect(otherUser).pause()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when valid", function () {
      beforeEach(async function () {
        tx = await perp.connect(otherUser).pause();
        await tx;
      });
      it("should pause", async function () {
        expect(await perp.paused()).to.eq(true);
      });
      it("should emit event", async function () {
        await expect(tx)
          .to.emit(perp, "Paused")
          .withArgs(await otherUser.getAddress());
      });
    });
  });

  describe("#unpause", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await perp.connect(deployer).updateKeeper(await otherUser.getAddress());
    });

    describe("when triggered by non-keeper", function () {
      beforeEach(async function () {
        await perp.connect(otherUser).pause();
      });

      it("should revert", async function () {
        await expect(perp.connect(deployer).unpause()).to.be.revertedWith("UnauthorizedCall");
      });
    });

    describe("when not paused", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).unpause()).to.be.revertedWith("Pausable: not paused");
      });
    });

    describe("when valid", function () {
      beforeEach(async function () {
        tx = await perp.connect(otherUser).pause();
        await tx;
        tx = await perp.connect(otherUser).unpause();
        await tx;
      });
      it("should unpause", async function () {
        expect(await perp.paused()).to.eq(false);
      });
      it("should emit event", async function () {
        await expect(tx)
          .to.emit(perp, "Unpaused")
          .withArgs(await otherUser.getAddress());
      });
    });
  });

  describe("#updateKeeper", function () {
    let tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updateKeeper(constants.AddressZero)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set address is valid", function () {
      beforeEach(async function () {
        tx = perp.updateKeeper(await otherUser.getAddress());
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.keeper()).to.eq(await otherUser.getAddress());
      });
      it("should emit event", async function () {
        await expect(tx)
          .to.emit(perp, "UpdatedKeeper")
          .withArgs(constants.AddressZero, await otherUser.getAddress());
      });
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
        await expect(perp.updateBondIssuer(constants.AddressZero)).to.be.revertedWith("UnacceptableReference");
      });
    });

    describe("when set address is valid", function () {
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("MockBondIssuer");
        newIssuer = await BondIssuer.deploy(collateralToken.address);
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

    describe("when collateral is NOT valid", function () {
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("MockBondIssuer");
        newIssuer = await BondIssuer.deploy(perp.address);
      });
      it("should revert", async function () {
        await expect(perp.updateBondIssuer(newIssuer.address)).to.be.revertedWith("InvalidCollateral");
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
        await expect(perp.updateFeeStrategy(constants.AddressZero)).to.be.revertedWith("UnacceptableReference");
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
        await expect(perp.updatePricingStrategy(constants.AddressZero)).to.be.revertedWith("UnacceptableReference");
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
          "InvalidStrategyDecimals",
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

  describe("#updateDiscountStrategy", function () {
    let newDiscountStrategy: Contract, tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updateDiscountStrategy(constants.AddressZero)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set address is NOT valid", function () {
      it("should revert", async function () {
        await expect(perp.updateDiscountStrategy(constants.AddressZero)).to.be.revertedWith("UnacceptableReference");
      });
    });

    describe("when new strategy has different decimals", function () {
      beforeEach(async function () {
        const DiscountStrategy = await ethers.getContractFactory("MockDiscountStrategy");
        newDiscountStrategy = await DiscountStrategy.deploy();
        await newDiscountStrategy.setDecimals(8);
      });
      it("should revert", async function () {
        await expect(perp.updateDiscountStrategy(newDiscountStrategy.address)).to.be.revertedWith(
          "InvalidStrategyDecimals",
        );
      });
    });

    describe("when set address is valid", function () {
      beforeEach(async function () {
        const DiscountStrategy = await ethers.getContractFactory("MockDiscountStrategy");
        newDiscountStrategy = await DiscountStrategy.deploy();
        tx = perp.updateDiscountStrategy(newDiscountStrategy.address);
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.discountStrategy()).to.eq(newDiscountStrategy.address);
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(perp, "UpdatedDiscountStrategy").withArgs(newDiscountStrategy.address);
      });
    });
  });

  describe("#updateTolerableTrancheMaturity", function () {
    let tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updateTolerableTrancheMaturity(0, 0)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set values are not valid", function () {
      it("should revert", async function () {
        await expect(perp.updateTolerableTrancheMaturity(86400, 3600)).to.be.revertedWith(
          "InvalidTrancheMaturityBounds",
        );
      });
    });

    describe("when set values are valid", function () {
      beforeEach(async function () {
        tx = perp.updateTolerableTrancheMaturity(3600, 86400);
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.minTrancheMaturitySec()).to.eq(3600);
        expect(await perp.maxTrancheMaturitySec()).to.eq(86400);
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(perp, "UpdatedTolerableTrancheMaturity").withArgs(3600, 86400);
      });
    });
  });

  describe("#updateMintingLimits", function () {
    let tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          perp.connect(otherUser).updateMintingLimits(constants.MaxUint256, constants.MaxUint256),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when triggered by owner", function () {
      beforeEach(async function () {
        tx = perp.updateMintingLimits(toFixedPtAmt("100"), toFixedPtAmt("20"));
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.maxSupply()).to.eq(toFixedPtAmt("100"));
        expect(await perp.maxMintAmtPerTranche()).to.eq(toFixedPtAmt("20"));
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(perp, "UpdatedMintingLimits").withArgs(toFixedPtAmt("100"), toFixedPtAmt("20"));
      });
    });
  });

  describe("#updateMatureValueTargetPerc", function () {
    let tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updateMatureValueTargetPerc("1000000")).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when NOT valid", function () {
      it("should revert", async function () {
        await expect(perp.updateMatureValueTargetPerc("100000001")).to.be.revertedWith("InvalidPerc");
      });
    });

    describe("when triggered by owner", function () {
      beforeEach(async function () {
        tx = perp.updateMatureValueTargetPerc("1000000");
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.matureValueTargetPerc()).to.eq("1000000");
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(perp, "UpdatedMatureValueTargetPerc").withArgs("1000000");
      });
    });
  });

  describe("#transferERC20", function () {
    let transferToken: Contract, toAddress: string;

    beforeEach(async function () {
      const Token = await ethers.getContractFactory("MockERC20");
      transferToken = await Token.deploy();
      await transferToken.init("Mock Token", "MOCK");
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
      it("should revert", async function () {
        expect(await perp.callStatic.inReserve(collateralToken.address)).to.eq(true);
        await expect(perp.transferERC20(collateralToken.address, toAddress, toFixedPtAmt("100"))).to.be.revertedWith(
          "UnauthorizedTransferOut",
        );
      });
    });

    describe("when fee token", function () {
      it("should revert", async function () {
        await expect(perp.transferERC20(await perp.feeToken(), toAddress, toFixedPtAmt("100"))).to.be.revertedWith(
          "UnauthorizedTransferOut",
        );
      });
    });
  });

  describe("#computeDiscount", function () {
    let bondFactory: Contract, bond: Contract, tranches: Contract[];
    beforeEach(async function () {
      bondFactory = await setupBondFactory();

      bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
      tranches = await getTranches(bond);
      await issuer.setLatestBond(bond.address);

      await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("1"));
    });

    describe("when tranche instance is not in the system", function () {
      it("should return defined discount", async function () {
        expect(await perp.computeDiscount(tranches[0].address)).to.eq(toDiscountFixedPtAmt("1"));
      });
      describe("when not defined", function () {
        it("should return 0", async function () {
          expect(await perp.computeDiscount(tranches[1].address)).to.eq(toDiscountFixedPtAmt("0"));
          expect(await perp.computeDiscount(tranches[2].address)).to.eq(toDiscountFixedPtAmt("0"));
        });
      });
      describe("when updated", function () {
        beforeEach(async function () {
          expect(await perp.computeDiscount(tranches[0].address)).to.eq(toDiscountFixedPtAmt("1"));
          await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("0.5"));
        });
        it("should return defined discount", async function () {
          expect(await perp.computeDiscount(tranches[0].address)).to.eq(toDiscountFixedPtAmt("0.5"));
        });
      });
    });

    describe("when tranche instance is already in system", function () {
      beforeEach(async function () {
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));
      });
      it("should return applied discount", async function () {
        expect(await perp.computeDiscount(tranches[0].address)).to.eq(toDiscountFixedPtAmt("1"));
      });
      describe("when updated", function () {
        beforeEach(async function () {
          await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("0.5"));
        });
        it("should return applied discount", async function () {
          expect(await perp.computeDiscount(tranches[0].address)).to.eq(toDiscountFixedPtAmt("1"));
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

        await discountStrategy.setTrancheDiscount(tranchesNext[0].address, toDiscountFixedPtAmt("1"));
      });
      it("should return defined discount", async function () {
        expect(await perp.computeDiscount(tranchesNext[0].address)).to.eq(toDiscountFixedPtAmt("1"));
      });
      describe("when updated", function () {
        beforeEach(async function () {
          await discountStrategy.setTrancheDiscount(tranchesNext[0].address, toDiscountFixedPtAmt("0.5"));
        });
        it("should return defined discount for new tranche", async function () {
          expect(await perp.computeDiscount(tranchesNext[0].address)).to.eq(toDiscountFixedPtAmt("0.5"));
        });
        it("should return applied discount for old tranche", async function () {
          expect(await perp.computeDiscount(tranches[0].address)).to.eq(toDiscountFixedPtAmt("1"));
        });
      });
    });
  });

  describe("#computePrice", function () {
    beforeEach(async function () {
      expect(await perp.computePrice(constants.AddressZero)).not.to.eq(toPriceFixedPtAmt("0.33"));
      await pricingStrategy.setPrice(toPriceFixedPtAmt("0.33"));
    });
    it("should return the price from the strategy", async function () {
      expect(await perp.computePrice(constants.AddressZero)).to.eq(toPriceFixedPtAmt("0.33"));
    });
  });

  describe("#feeToken", function () {
    let feeToken: Contract;
    beforeEach(async function () {
      const ERC20 = await ethers.getContractFactory("MockERC20");
      feeToken = await ERC20.deploy();
      await feeToken.init("Mock token", "MOCK");
      expect(await perp.feeToken()).not.to.eq(feeToken.address);
      await feeStrategy.setFeeToken(feeToken.address);
    });

    it("should return the fee token from the strategy", async function () {
      expect(await perp.feeToken()).to.eq(feeToken.address);
    });
  });

  describe("#reserve", function () {
    let bondFactory: Contract, bond: Contract, tranches: Contract[], bondNext: Contract, tranchesNext: Contract[];
    beforeEach(async function () {
      bondFactory = await setupBondFactory();
    });

    describe("when reserve has no tranches", function () {
      it("should have expected reserve composition", async function () {
        await checkReserveComposition(perp, [collateralToken], [toFixedPtAmt("0")]);
      });
      it("should calculate the avg. perp price", async function () {
        expect(await perp.callStatic.getAvgPrice()).to.eq(0);
      });
    });

    describe("when reserve has one tranche", function () {
      beforeEach(async function () {
        bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
        tranches = await getTranches(bond);
        await issuer.setLatestBond(bond.address);

        await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("1"));

        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));
      });

      it("should have expected reserve composition", async function () {
        await checkReserveComposition(perp, [collateralToken, tranches[0]], [toFixedPtAmt("0"), toFixedPtAmt("200")]);
      });
      it("should calculate the avg. perp price", async function () {
        expect(await perp.callStatic.getAvgPrice()).to.eq(toPriceFixedPtAmt("1"));
      });
    });

    describe("when reserve has many tranches", function () {
      beforeEach(async function () {
        bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
        tranches = await getTranches(bond);
        await issuer.setLatestBond(bond.address);

        await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("1"));

        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

        bondNext = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
        tranchesNext = await getTranches(bondNext);
        await issuer.setLatestBond(bondNext.address);

        await discountStrategy.setTrancheDiscount(tranchesNext[0].address, toDiscountFixedPtAmt("0.5"));
        await pricingStrategy.setTranchePrice(tranchesNext[0].address, toPriceFixedPtAmt("0.5"));
        await depositIntoBond(bondNext, toFixedPtAmt("1000"), deployer);
        await tranchesNext[0].approve(perp.address, toFixedPtAmt("100"));
        await perp.deposit(tranchesNext[0].address, toFixedPtAmt("100"));
      });

      it("should have expected reserve composition", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, tranches[0], tranchesNext[0]],
          [toFixedPtAmt("0"), toFixedPtAmt("200"), toFixedPtAmt("100")],
        );
      });
      it("should calculate the avg. perp price", async function () {
        expect(await perp.callStatic.getAvgPrice()).to.eq(toPriceFixedPtAmt("1"));
      });
    });

    describe("when reserve has only mature collateral", function () {
      let issuer: Contract;
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
        await issuer.init(3600, [200, 300, 500], 1200, 0);
        await perp.updateBondIssuer(issuer.address);

        await advancePerpQueue(perp, 1200);
        bond = await bondAt(await perp.callStatic.getDepositBond());
        tranches = await getTranches(bond);

        await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("1"));
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

        await advancePerpQueue(perp, 1200);
        bondNext = await bondAt(await perp.callStatic.getDepositBond());
        tranchesNext = await getTranches(bondNext);

        await discountStrategy.setTrancheDiscount(tranchesNext[0].address, toDiscountFixedPtAmt("1"));
        await pricingStrategy.setTranchePrice(tranchesNext[0].address, toPriceFixedPtAmt("1"));
        await depositIntoBond(bondNext, toFixedPtAmt("1000"), deployer);
        await tranchesNext[0].approve(perp.address, toFixedPtAmt("100"));
        await perp.deposit(tranchesNext[0].address, toFixedPtAmt("100"));

        await advancePerpQueue(perp, 36000);
      });

      it("should have expected reserve composition", async function () {
        await checkReserveComposition(perp, [collateralToken], [toFixedPtAmt("300")]);
      });
      it("should calculate the avg. perp price", async function () {
        expect(await perp.callStatic.getAvgPrice()).to.eq(toPriceFixedPtAmt("1"));
      });
    });

    describe("when reserve has mature collateral and tranches", function () {
      let issuer: Contract;
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
        await issuer.init(3600, [200, 300, 500], 1200, 0);
        await perp.updateBondIssuer(issuer.address);

        await advancePerpQueue(perp, 3600);
        bond = await bondAt(await perp.callStatic.getDepositBond());
        tranches = await getTranches(bond);

        await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("1"));
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

        await advancePerpQueue(perp, 1200);
        bondNext = await bondAt(await perp.callStatic.getDepositBond());
        tranchesNext = await getTranches(bondNext);

        await discountStrategy.setTrancheDiscount(tranchesNext[0].address, toDiscountFixedPtAmt("1"));
        await pricingStrategy.setTranchePrice(tranchesNext[0].address, toPriceFixedPtAmt("1"));
        await depositIntoBond(bondNext, toFixedPtAmt("1000"), deployer);
        await tranchesNext[0].approve(perp.address, toFixedPtAmt("100"));
        await perp.deposit(tranchesNext[0].address, toFixedPtAmt("100"));

        await advancePerpQueue(perp, 2400);
      });

      it("should have expected reserve composition", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, tranchesNext[0]],
          [toFixedPtAmt("200"), toFixedPtAmt("100")],
        );
      });
      it("should calculate the avg. perp price", async function () {
        expect(await perp.callStatic.getAvgPrice()).to.eq(toPriceFixedPtAmt("1"));
      });
    });

    describe("when reserve has mature collateral which has rebased up and tranches", function () {
      let issuer: Contract;
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
        await issuer.init(3600, [200, 300, 500], 1200, 0);
        await perp.updateBondIssuer(issuer.address);

        await advancePerpQueue(perp, 3600);
        bond = await bondAt(await perp.callStatic.getDepositBond());
        tranches = await getTranches(bond);

        await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("1"));
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

        await advancePerpQueue(perp, 1200);
        bondNext = await bondAt(await perp.callStatic.getDepositBond());
        tranchesNext = await getTranches(bondNext);

        await discountStrategy.setTrancheDiscount(tranchesNext[0].address, toDiscountFixedPtAmt("1"));
        await pricingStrategy.setTranchePrice(tranchesNext[0].address, toPriceFixedPtAmt("1"));
        await depositIntoBond(bondNext, toFixedPtAmt("1000"), deployer);
        await tranchesNext[0].approve(perp.address, toFixedPtAmt("100"));
        await perp.deposit(tranchesNext[0].address, toFixedPtAmt("100"));

        await advancePerpQueue(perp, 2400);

        await rebase(collateralToken, rebaseOracle, 0.1);
        await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("1.1"));
      });

      it("should have expected reserve composition", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, tranchesNext[0]],
          [toFixedPtAmt("220"), toFixedPtAmt("100")],
        );
      });
      it("should calculate the avg. perp price", async function () {
        expect(await perp.callStatic.getAvgPrice()).to.eq(toPriceFixedPtAmt("1.06666666"));
      });
    });

    describe("when reserve has mature collateral which has rebased down and tranches", function () {
      let issuer: Contract;
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
        await issuer.init(3600, [200, 300, 500], 1200, 0);
        await perp.updateBondIssuer(issuer.address);

        await advancePerpQueue(perp, 3600);
        bond = await bondAt(await perp.callStatic.getDepositBond());
        tranches = await getTranches(bond);

        await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("1"));
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

        await advancePerpQueue(perp, 1200);
        bondNext = await bondAt(await perp.callStatic.getDepositBond());
        tranchesNext = await getTranches(bondNext);

        await discountStrategy.setTrancheDiscount(tranchesNext[0].address, toDiscountFixedPtAmt("1"));
        await pricingStrategy.setTranchePrice(tranchesNext[0].address, toPriceFixedPtAmt("1"));
        await depositIntoBond(bondNext, toFixedPtAmt("1000"), deployer);
        await tranchesNext[0].approve(perp.address, toFixedPtAmt("100"));
        await perp.deposit(tranchesNext[0].address, toFixedPtAmt("100"));

        await advancePerpQueue(perp, 2400);

        await rebase(collateralToken, rebaseOracle, -0.1);
        await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("0.9"));
      });

      it("should have expected reserve composition", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, tranchesNext[0]],
          [toFixedPtAmt("180"), toFixedPtAmt("100")],
        );
      });
      it("should calculate the avg. perp price", async function () {
        expect(await perp.callStatic.getAvgPrice()).to.eq(toPriceFixedPtAmt("0.93333333"));
      });
    });
  });

  describe("updateState", async function () {
    let bond: Contract, bondFactory: Contract;
    beforeEach(async function () {
      bondFactory = await setupBondFactory();
      await perp.updateTolerableTrancheMaturity(1200, 7200);
      await advancePerpQueue(perp, 7300);
    });

    describe("when the deposit bond is not acceptable", function () {
      describe("when deposit bond matures too soon", async function () {
        beforeEach(async function () {
          bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 600);
          await issuer.setLatestBond(bond.address);
          await perp.updateState();
        });

        it("should NOT update the deposit bond", async function () {
          expect(await perp.callStatic.getDepositBond()).to.not.eq(bond.address);
        });
      });

      describe("when deposit bond matures too late", async function () {
        beforeEach(async function () {
          await perp.updateTolerableTrancheMaturity(1200, 7200);
          bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 7210);
          await issuer.setLatestBond(bond.address);
          await perp.updateState();
        });

        it("should NOT update the deposit bond", async function () {
          expect(await perp.callStatic.getDepositBond()).to.not.eq(bond.address);
        });
      });

      describe("when deposit bond belongs to a different collateral token", async function () {
        beforeEach(async function () {
          await perp.updateTolerableTrancheMaturity(1200, 7200);
          const r = await setupCollateralToken("Ethereum", "ETH");
          bond = await createBondWithFactory(bondFactory, r.collateralToken, [200, 300, 500], 3600);
          await issuer.setLatestBond(bond.address);
          await perp.updateState();
        });

        it("should NOT update the deposit bond", async function () {
          expect(await perp.callStatic.getDepositBond()).to.not.eq(bond.address);
        });
      });

      describe("when deposit bond is acceptable", async function () {
        let tx: Transaction;
        beforeEach(async function () {
          await perp.updateTolerableTrancheMaturity(1200, 7200);
          bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
          await issuer.setLatestBond(bond.address);
          tx = perp.updateState();
          await tx;
        });

        it("should update the deposit bond", async function () {
          expect(await perp.callStatic.getDepositBond()).to.eq(bond.address);
        });

        it("should emit event", async function () {
          await expect(tx).to.emit(perp, "UpdatedDepositBond").withArgs(bond.address);
        });
      });
    });

    describe("when no reserve tranche is mature", async function () {
      let issuer: Contract, tx: Transaction;
      const reserveTranches: Contract[] = [];
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
        await issuer.init(10800, [500, 500], 1200, 0);
        await perp.updateBondIssuer(issuer.address);
        await perp.updateTolerableTrancheMaturity(0, 10800);
        await advancePerpQueue(perp, 10900);
        for (let i = 0; i < 5; i++) {
          const depositBond = await bondAt(await perp.callStatic.getDepositBond());
          const tranches = await getTranches(depositBond);
          await pricingStrategy.setTranchePrice(tranches[0].address, toPriceFixedPtAmt("1"));
          await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("1"));
          await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
          await tranches[0].approve(perp.address, toFixedPtAmt("500"));
          await perp.deposit(tranches[0].address, toFixedPtAmt("500"));
          reserveTranches[i] = tranches[0];
          await advancePerpQueue(perp, 1200);
        }

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches],
          [
            toFixedPtAmt("0"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
          ],
        );

        expect(await perp.callStatic.getReserveCount()).to.eq("6");
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq("0");
        expect(await collateralToken.balanceOf(await perp.reserve())).to.eq("0");

        await TimeHelpers.increaseTime(1200);
        tx = await perp.updateState();
        await tx;
      });

      it("should have expected reserve composition", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches],
          [
            toFixedPtAmt("0"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
          ],
        );
      });

      it("should NOT change reserveCount", async function () {
        expect(await perp.callStatic.getReserveCount()).to.eq("6");
      });

      it("should NOT change tranche balances", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq("0");
      });

      it("should emit ReserveSynced", async function () {
        await expect(tx).to.emit(perp, "ReserveSynced").withArgs(collateralToken.address, toFixedPtAmt("0"));
      });

      it("should NOT update the reserve balance", async function () {
        expect(await collateralToken.balanceOf(await perp.reserve())).to.eq("0");
      });
    });

    describe("when some reserve tranches are mature", async function () {
      let issuer: Contract;
      let tx: Transaction;
      const reserveTranches: Contract[] = [];
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
        await issuer.init(10800, [500, 500], 1200, 0);
        await perp.updateBondIssuer(issuer.address);
        await perp.updateTolerableTrancheMaturity(0, 10800);
        await advancePerpQueue(perp, 10900);
        for (let i = 0; i < 5; i++) {
          const depositBond = await bondAt(await perp.callStatic.getDepositBond());
          const tranches = await getTranches(depositBond);
          await pricingStrategy.setTranchePrice(tranches[0].address, toPriceFixedPtAmt("1"));
          await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("1"));
          await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
          await tranches[0].approve(perp.address, toFixedPtAmt("500"));
          await perp.deposit(tranches[0].address, toFixedPtAmt("500"));
          reserveTranches[i] = tranches[0];
          await advancePerpQueue(perp, 1200);
        }

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches],
          [
            toFixedPtAmt("0"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
          ],
        );
        expect(await perp.callStatic.getReserveCount()).to.eq("6");
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq("0");
        expect(await collateralToken.balanceOf(await perp.reserve())).to.eq("0");

        await TimeHelpers.increaseTime(6000);
        // NOTE: invoking mature on reserveTranches[0],
        // updateState invokes mature on reserveTranches[1]
        await (await bondAt(await reserveTranches[0].bond())).mature();

        tx = perp.updateState();
        await tx;
      });

      it("should have expected reserve composition", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranches[3], reserveTranches[4], reserveTranches[2]],
          [toFixedPtAmt("1000"), toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
      });

      it("should change reserveCount", async function () {
        expect(await perp.callStatic.getReserveCount()).to.eq("4");
      });

      it("should emit tranche balance update", async function () {
        await expect(tx).to.emit(perp, "UpdatedMatureTrancheBalance").withArgs(toFixedPtAmt("1000"));
      });

      it("should change mature tranche balances", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("1000"));
      });

      it("should call mature if not already called", async function () {
        await expect(tx)
          .to.emit(await bondAt(await reserveTranches[0].bond()), "Mature")
          .withArgs(perp.address)
          .to.emit(await bondAt(await reserveTranches[1].bond()), "Mature")
          .withArgs(perp.address);
      });

      it("should emit ReserveSynced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("1000"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranches[0].address, "0")
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranches[1].address, "0");
      });

      it("should update the reserve balance", async function () {
        expect(await collateralToken.balanceOf(await perp.reserve())).to.eq(toFixedPtAmt("1000"));
      });
    });

    describe("when some reserve tranches are mature and rebases down", async function () {
      let issuer: Contract;
      let tx: Transaction;
      const reserveTranches: Contract[] = [];
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
        await issuer.init(10800, [500, 500], 1200, 0);
        await perp.updateBondIssuer(issuer.address);
        await perp.updateTolerableTrancheMaturity(0, 10800);
        await advancePerpQueue(perp, 10900);
        for (let i = 0; i < 5; i++) {
          const depositBond = await bondAt(await perp.callStatic.getDepositBond());
          const tranches = await getTranches(depositBond);
          await pricingStrategy.setTranchePrice(tranches[0].address, toPriceFixedPtAmt("1"));
          await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("1"));
          await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
          await tranches[0].approve(perp.address, toFixedPtAmt("500"));
          await perp.deposit(tranches[0].address, toFixedPtAmt("500"));
          reserveTranches[i] = tranches[0];
          await advancePerpQueue(perp, 1200);
          await rebase(collateralToken, rebaseOracle, -0.25);
        }

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches],
          [
            toFixedPtAmt("0"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
          ],
        );
        expect(await perp.callStatic.getReserveCount()).to.eq("6");
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq("0");
        expect(await collateralToken.balanceOf(await perp.reserve())).to.eq("0");

        await TimeHelpers.increaseTime(6000);
        tx = perp.updateState();
        await tx;
      });

      it("should have expected reserve composition", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranches[3], reserveTranches[4], reserveTranches[2]],
          [toFixedPtAmt("553.710919999999999999"), toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
      });

      it("should change reserveCount", async function () {
        expect(await perp.callStatic.getReserveCount()).to.eq("4");
      });

      it("should emit tranche balance update", async function () {
        await expect(tx).to.emit(perp, "UpdatedMatureTrancheBalance").withArgs(toFixedPtAmt("1000"));
      });

      it("should change mature tranche balances", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("1000"));
      });

      it("should call mature if not already called", async function () {
        await expect(tx)
          .to.emit(await bondAt(await reserveTranches[0].bond()), "Mature")
          .withArgs(perp.address)
          .to.emit(await bondAt(await reserveTranches[1].bond()), "Mature")
          .withArgs(perp.address);
      });

      it("should emit ReserveSynced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, "553710919999999999999")
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranches[0].address, "0")
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranches[1].address, "0");
      });

      it("should update the reserve balance", async function () {
        expect(await collateralToken.balanceOf(await perp.reserve())).to.eq("553710919999999999999");
      });
    });

    describe("when some reserve tranches are mature and discounts are different", async function () {
      let issuer: Contract;
      let tx: Transaction;
      const reserveTranches: Contract[] = [];
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
        await issuer.init(10800, [500, 500], 1200, 0);
        await perp.updateBondIssuer(issuer.address);
        await perp.updateTolerableTrancheMaturity(0, 10800);
        await advancePerpQueue(perp, 10900);
        for (let i = 0; i < 5; i++) {
          const depositBond = await bondAt(await perp.callStatic.getDepositBond());
          const tranches = await getTranches(depositBond);
          await pricingStrategy.setTranchePrice(tranches[0].address, toPriceFixedPtAmt("1"));
          if (i === 0) {
            await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("0.5"));
          } else {
            await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("1"));
          }
          await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
          await tranches[0].approve(perp.address, toFixedPtAmt("500"));
          await perp.deposit(tranches[0].address, toFixedPtAmt("500"));
          reserveTranches[i] = tranches[0];
          await advancePerpQueue(perp, 1200);
        }

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches],
          [
            toFixedPtAmt("0"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
          ],
        );
        expect(await perp.callStatic.getReserveCount()).to.eq("6");
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq("0");
        expect(await collateralToken.balanceOf(await perp.reserve())).to.eq("0");

        await TimeHelpers.increaseTime(6000);
        tx = perp.updateState();
        await tx;
      });

      it("should have expected reserve composition", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranches[3], reserveTranches[4], reserveTranches[2]],
          [toFixedPtAmt("1000"), toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
      });

      it("should change reserveCount", async function () {
        expect(await perp.callStatic.getReserveCount()).to.eq("4");
      });

      it("should emit tranche balance update", async function () {
        await expect(tx).to.emit(perp, "UpdatedMatureTrancheBalance").withArgs(toFixedPtAmt("750"));
      });

      it("should change mature tranche balances", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("750"));
      });

      it("should call mature if not already called", async function () {
        await expect(tx)
          .to.emit(await bondAt(await reserveTranches[0].bond()), "Mature")
          .withArgs(perp.address)
          .to.emit(await bondAt(await reserveTranches[1].bond()), "Mature")
          .withArgs(perp.address);
      });

      it("should emit ReserveSynced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("1000"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranches[0].address, "0")
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranches[1].address, "0");
      });

      it("should update the reserve balance", async function () {
        expect(await collateralToken.balanceOf(await perp.reserve())).to.eq(toFixedPtAmt("1000"));
      });
    });
  });

  describe("#getReserveTokensUpForRollover", async function () {
    const depositTranches: Contract[] = [];
    beforeEach(async function () {
      const bondFactory = await setupBondFactory();
      const BondIssuer = await ethers.getContractFactory("BondIssuer");
      const issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
      await issuer.init(10800, [500, 500], 1200, 0);
      await perp.updateBondIssuer(issuer.address);
      await perp.updateTolerableTrancheMaturity(600, 10800);
      await advancePerpQueue(perp, 10900);
      for (let i = 0; i < 5; i++) {
        const depositBond = await bondAt(await perp.callStatic.getDepositBond());
        const tranches = await getTranches(depositBond);
        await pricingStrategy.setTranchePrice(tranches[0].address, toPriceFixedPtAmt("1"));
        await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("1"));
        await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("500"));
        depositTranches[i] = tranches[0];
        await advancePerpQueue(perp, 1200);
      }
      await advancePerpQueueToRollover(perp, await bondAt(depositTranches[2].bond()));
    });

    it("should get the rollover ready tranches", async function () {
      const r = await perp.callStatic.getReserveTokensUpForRollover();
      expect(r).to.include(collateralToken.address);
      expect(r).to.include(depositTranches[2].address);
      expect(r).not.to.include(depositTranches[0].address);
      expect(r).not.to.include(depositTranches[1].address);
      expect(r).not.to.include(depositTranches[3].address);
      expect(r).not.to.include(depositTranches[4].address);
    });
  });

  describe("#getReserveTrancheBalance", async function () {
    const depositTranches: Contract[] = [];
    beforeEach(async function () {
      const bondFactory = await setupBondFactory();
      const BondIssuer = await ethers.getContractFactory("BondIssuer");
      const issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
      await issuer.init(10800, [500, 500], 1200, 0);
      await perp.updateBondIssuer(issuer.address);
      await perp.updateTolerableTrancheMaturity(600, 10800);
      await advancePerpQueue(perp, 10900);
      for (let i = 0; i < 5; i++) {
        const depositBond = await bondAt(await perp.callStatic.getDepositBond());
        const tranches = await getTranches(depositBond);
        await pricingStrategy.setTranchePrice(tranches[0].address, toPriceFixedPtAmt("1"));
        await discountStrategy.setTrancheDiscount(tranches[0].address, toDiscountFixedPtAmt("0.75"));
        await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("500"));
        depositTranches[i] = tranches[0];
        await advancePerpQueue(perp, 1200);
      }
      await advancePerpQueueToRollover(perp, await bondAt(depositTranches[2].bond()));
    });

    it("should return the tranche balance", async function () {
      expect(await perp.callStatic.getReserveTrancheBalance(perp.address)).to.eq("0");
      expect(await perp.callStatic.getReserveTrancheBalance(collateralToken.address)).to.eq(toFixedPtAmt("750"));
      expect(await perp.callStatic.getReserveTrancheBalance(depositTranches[0].address)).to.eq("0");
      expect(await perp.callStatic.getReserveTrancheBalance(depositTranches[1].address)).to.eq("0");
      expect(await perp.callStatic.getReserveTrancheBalance(depositTranches[2].address)).to.eq(toFixedPtAmt("500"));
      expect(await perp.callStatic.getReserveTrancheBalance(depositTranches[3].address)).to.eq(toFixedPtAmt("500"));
      expect(await perp.callStatic.getReserveTrancheBalance(depositTranches[4].address)).to.eq(toFixedPtAmt("500"));
    });
  });
});
