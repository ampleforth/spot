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
  toYieldFixedPtAmt,
  toPriceFixedPtAmt,
  advancePerpQueue,
  bondAt,
  checkReserveComposition,
  TimeHelpers,
  rebase,
} from "./helpers";

let perp: Contract,
  collateralToken: Contract,
  rebaseOracle: Contract,
  issuer: Contract,
  feeStrategy: Contract,
  pricingStrategy: Contract,
  yieldStrategy: Contract,
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
    issuer = await BondIssuer.deploy();

    const FeeStrategy = await ethers.getContractFactory("MockFeeStrategy");
    feeStrategy = await FeeStrategy.deploy();

    const PricingStrategy = await ethers.getContractFactory("MockPricingStrategy");
    pricingStrategy = await PricingStrategy.deploy();

    const YieldStrategy = await ethers.getContractFactory("MockYieldStrategy");
    yieldStrategy = await YieldStrategy.deploy();

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
        yieldStrategy.address,
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
      expect(await perp.yieldStrategy()).to.eq(yieldStrategy.address);
    });

    it("should set collateral reference", async function () {
      expect(await perp.collateral()).to.eq(collateralToken.address);
    });

    it("should set collateral yield", async function () {
      expect(await perp.computeYield(collateralToken.address)).to.eq(toYieldFixedPtAmt("1"));
    });

    it("should set fund pool references", async function () {
      expect(await perp.reserve()).to.eq(perp.address);
      expect(await perp.feeCollector()).to.eq(perp.address);
    });

    it("should initialize lists", async function () {
      expect(await perp.reserveCount()).to.eq(1);
    });

    it("should set hyper parameters", async function () {
      expect(await perp.minTrancheMaturiySec()).to.eq(1);
      expect(await perp.maxTrancheMaturiySec()).to.eq(constants.MaxUint256);
      expect(await perp.maxSupply()).to.eq(toFixedPtAmt("1000000"));
      expect(await perp.maxMintAmtPerTranche()).to.eq(toFixedPtAmt("200000"));
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
        await expect(perp.updateBondIssuer(constants.AddressZero)).to.be.revertedWith("UnacceptableBondIssuer");
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
        await expect(perp.updateFeeStrategy(constants.AddressZero)).to.be.revertedWith("UnacceptableFeeStrategy");
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
          "UnacceptablePricingStrategy",
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
          "InvalidPricingStrategyDecimals",
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
          "InvalidTrancheMaturityBounds",
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

  describe("#updateSkimPerc", function () {
    let tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updateSkimPerc("1")).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set skim perc is NOT valid", function () {
      it("should revert", async function () {
        await expect(perp.updateSkimPerc("100000001")).to.be.revertedWith("UnacceptableSkimPerc");
      });
    });

    describe("when set skim perc is valid", function () {
      beforeEach(async function () {
        tx = perp.updateSkimPerc("50000000");
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.skimPerc()).to.eq("50000000");
      });
      it("should emit event", async function () {
        await expect(tx).to.emit(perp, "UpdatedSkimPerc").withArgs("50000000");
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
        expect(await perp.isReserveToken(collateralToken.address)).to.eq(true);
        await expect(perp.transferERC20(collateralToken.address, toAddress, toFixedPtAmt("100"))).to.be.revertedWith(
          "UnauthorizedTransferOut",
        );
      });
    });
  });

  describe("#computeYield", function () {
    let bondFactory: Contract, bond: Contract, tranches: Contract[];
    beforeEach(async function () {
      bondFactory = await setupBondFactory();

      bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
      tranches = await getTranches(bond);
      await issuer.setLatestBond(bond.address);

      await yieldStrategy.setTrancheYield(tranches[0].address, toYieldFixedPtAmt("1"));
    });

    describe("when tranche instance is not in the system", function () {
      it("should return defined yield", async function () {
        expect(await perp.computeYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("1"));
      });
      describe("when not defined", function () {
        it("should return 0", async function () {
          expect(await perp.computeYield(tranches[1].address)).to.eq(toYieldFixedPtAmt("0"));
          expect(await perp.computeYield(tranches[2].address)).to.eq(toYieldFixedPtAmt("0"));
        });
      });
      describe("when updated", function () {
        beforeEach(async function () {
          expect(await perp.computeYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("1"));
          await yieldStrategy.setTrancheYield(tranches[0].address, toYieldFixedPtAmt("0.5"));
        });
        it("should return defined yield", async function () {
          expect(await perp.computeYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("0.5"));
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
        expect(await perp.computeYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("1"));
      });
      describe("when updated", function () {
        beforeEach(async function () {
          await yieldStrategy.setTrancheYield(tranches[0].address, toYieldFixedPtAmt("0.5"));
        });
        it("should return applied yield", async function () {
          expect(await perp.computeYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("1"));
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

        await yieldStrategy.setTrancheYield(tranchesNext[0].address, toYieldFixedPtAmt("1"));
      });
      it("should return defined yield", async function () {
        expect(await perp.computeYield(tranchesNext[0].address)).to.eq(toYieldFixedPtAmt("1"));
      });
      describe("when updated", function () {
        beforeEach(async function () {
          await yieldStrategy.setTrancheYield(tranchesNext[0].address, toYieldFixedPtAmt("0.5"));
        });
        it("should return defined yield for new tranche", async function () {
          expect(await perp.computeYield(tranchesNext[0].address)).to.eq(toYieldFixedPtAmt("0.5"));
        });
        it("should return applied yield for old tranche", async function () {
          expect(await perp.computeYield(tranches[0].address)).to.eq(toYieldFixedPtAmt("1"));
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
      it("should calculate the reserve value", async function () {
        expect(await perp.reserveValue()).to.eq(0);
      });
    });

    describe("when reserve has one tranche", function () {
      beforeEach(async function () {
        bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
        tranches = await getTranches(bond);
        await issuer.setLatestBond(bond.address);

        await yieldStrategy.setTrancheYield(tranches[0].address, toYieldFixedPtAmt("1"));

        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));
      });

      it("should have expected reserve composition", async function () {
        await checkReserveComposition(perp, [collateralToken, tranches[0]], [toFixedPtAmt("0"), toFixedPtAmt("200")]);
      });
      it("should calculate the reserve value", async function () {
        expect(await perp.reserveValue()).to.eq(toFixedPtAmt("200").mul(toPriceFixedPtAmt("1")));
      });
    });

    describe("when reserve has many tranches", function () {
      beforeEach(async function () {
        bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
        tranches = await getTranches(bond);
        await issuer.setLatestBond(bond.address);

        await yieldStrategy.setTrancheYield(tranches[0].address, toYieldFixedPtAmt("1"));

        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

        bondNext = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 3600);
        tranchesNext = await getTranches(bondNext);
        await issuer.setLatestBond(bondNext.address);

        await yieldStrategy.setTrancheYield(tranchesNext[0].address, toYieldFixedPtAmt("0.5"));
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
      it("should calculate the reserve value", async function () {
        expect(await perp.reserveValue()).to.eq(toFixedPtAmt("225").mul(toPriceFixedPtAmt("1")));
      });
    });

    describe("when reserve has only mature collateral", function () {
      let issuer: Contract;
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await BondIssuer.deploy(bondFactory.address, 1200, 0, 3600, collateralToken.address, [200, 300, 500]);
        await perp.updateBondIssuer(issuer.address);

        await advancePerpQueue(perp, 1200);
        bond = await bondAt(await perp.callStatic.getDepositBond());
        tranches = await getTranches(bond);

        await yieldStrategy.setTrancheYield(tranches[0].address, toYieldFixedPtAmt("1"));
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

        await advancePerpQueue(perp, 1200);
        bondNext = await bondAt(await perp.callStatic.getDepositBond());
        tranchesNext = await getTranches(bondNext);

        await yieldStrategy.setTrancheYield(tranchesNext[0].address, toYieldFixedPtAmt("1"));
        await pricingStrategy.setTranchePrice(tranchesNext[0].address, toPriceFixedPtAmt("1"));
        await depositIntoBond(bondNext, toFixedPtAmt("1000"), deployer);
        await tranchesNext[0].approve(perp.address, toFixedPtAmt("100"));
        await perp.deposit(tranchesNext[0].address, toFixedPtAmt("100"));

        await advancePerpQueue(perp, 36000);
      });

      it("should have expected reserve composition", async function () {
        await checkReserveComposition(perp, [collateralToken], [toFixedPtAmt("300")]);
      });
      it("should calculate the reserve value", async function () {
        expect(await perp.reserveValue()).to.eq(toFixedPtAmt("300").mul(toPriceFixedPtAmt("1")));
      });
    });

    describe("when reserve has mature collateral and tranches", function () {
      let issuer: Contract;
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await BondIssuer.deploy(bondFactory.address, 1200, 0, 3600, collateralToken.address, [200, 300, 500]);
        await perp.updateBondIssuer(issuer.address);

        await advancePerpQueue(perp, 3600);
        bond = await bondAt(await perp.callStatic.getDepositBond());
        tranches = await getTranches(bond);

        await yieldStrategy.setTrancheYield(tranches[0].address, toYieldFixedPtAmt("1"));
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

        await advancePerpQueue(perp, 1200);
        bondNext = await bondAt(await perp.callStatic.getDepositBond());
        tranchesNext = await getTranches(bondNext);

        await yieldStrategy.setTrancheYield(tranchesNext[0].address, toYieldFixedPtAmt("1"));
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
      it("should calculate the reserve value", async function () {
        expect(await perp.reserveValue()).to.eq(toFixedPtAmt("300").mul(toPriceFixedPtAmt("1")));
      });
    });
  });

  describe("updateState", async function () {
    let bond: Contract, bondFactory: Contract;
    beforeEach(async function () {
      bondFactory = await setupBondFactory();
      await perp.updateTolerableTrancheMaturiy(1200, 7200);
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
          await perp.updateTolerableTrancheMaturiy(1200, 7200);
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
          await perp.updateTolerableTrancheMaturiy(1200, 7200);
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
          await perp.updateTolerableTrancheMaturiy(1200, 7200);
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
        issuer = await BondIssuer.deploy(bondFactory.address, 1200, 0, 10800, collateralToken.address, [500, 500]);
        await perp.updateBondIssuer(issuer.address);
        await perp.updateTolerableTrancheMaturiy(0, 10800);
        await advancePerpQueue(perp, 10900);
        for (let i = 0; i < 5; i++) {
          const depositBond = await bondAt(await perp.callStatic.getDepositBond());
          const tranches = await getTranches(depositBond);
          await pricingStrategy.setTranchePrice(tranches[0].address, toPriceFixedPtAmt("1"));
          await yieldStrategy.setTrancheYield(tranches[0].address, toYieldFixedPtAmt("1"));
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

        expect(await perp.reserveCount()).to.eq("6");
        expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(toFixedPtAmt("2500"));
        expect((await perp.callStatic.getStdTrancheBalances())[1]).to.eq("0");
        expect(await perp.reserveBalance(collateralToken.address)).to.eq("0");

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
        expect(await perp.reserveCount()).to.eq("6");
      });

      it("should NOT change tranche balances", async function () {
        expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(toFixedPtAmt("2500"));
        expect((await perp.callStatic.getStdTrancheBalances())[1]).to.eq("0");
      });

      it("should emit ReserveSynced", async function () {
        await expect(tx).to.emit(perp, "ReserveSynced").withArgs(collateralToken.address, toFixedPtAmt("0"));
      });

      it("should NOT update the reserve balance", async function () {
        expect(await perp.reserveBalance(collateralToken.address)).to.eq("0");
      });
    });

    describe("when some reserve tranches are mature", async function () {
      let issuer: Contract;
      let tx: Transaction;
      const reserveTranches: Contract[] = [];
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await BondIssuer.deploy(bondFactory.address, 1200, 0, 10800, collateralToken.address, [500, 500]);
        await perp.updateBondIssuer(issuer.address);
        await perp.updateTolerableTrancheMaturiy(0, 10800);
        await advancePerpQueue(perp, 10900);
        for (let i = 0; i < 5; i++) {
          const depositBond = await bondAt(await perp.callStatic.getDepositBond());
          const tranches = await getTranches(depositBond);
          await pricingStrategy.setTranchePrice(tranches[0].address, toPriceFixedPtAmt("1"));
          await yieldStrategy.setTrancheYield(tranches[0].address, toYieldFixedPtAmt("1"));
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
        expect(await perp.reserveCount()).to.eq("6");
        expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(toFixedPtAmt("2500"));
        expect((await perp.callStatic.getStdTrancheBalances())[1]).to.eq("0");
        expect(await perp.reserveBalance(collateralToken.address)).to.eq("0");

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
        expect(await perp.reserveCount()).to.eq("4");
      });

      it("should change mature tranche balances", async function () {
        expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(toFixedPtAmt("2500"));
        expect((await perp.callStatic.getStdTrancheBalances())[1]).to.eq(toFixedPtAmt("1000"));
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
        expect(await perp.reserveBalance(collateralToken.address)).to.eq(toFixedPtAmt("1000"));
      });
    });

    describe("when some reserve tranches are mature and rebases down", async function () {
      let issuer: Contract;
      let tx: Transaction;
      const reserveTranches: Contract[] = [];
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await BondIssuer.deploy(bondFactory.address, 1200, 0, 10800, collateralToken.address, [500, 500]);
        await perp.updateBondIssuer(issuer.address);
        await perp.updateTolerableTrancheMaturiy(0, 10800);
        await advancePerpQueue(perp, 10900);
        for (let i = 0; i < 5; i++) {
          const depositBond = await bondAt(await perp.callStatic.getDepositBond());
          const tranches = await getTranches(depositBond);
          await pricingStrategy.setTranchePrice(tranches[0].address, toPriceFixedPtAmt("1"));
          await yieldStrategy.setTrancheYield(tranches[0].address, toYieldFixedPtAmt("1"));
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
        expect(await perp.reserveCount()).to.eq("6");
        expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(toFixedPtAmt("2500"));
        expect((await perp.callStatic.getStdTrancheBalances())[1]).to.eq("0");
        expect(await perp.reserveBalance(collateralToken.address)).to.eq("0");

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
        expect(await perp.reserveCount()).to.eq("4");
      });

      it("should change mature tranche balances", async function () {
        expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(toFixedPtAmt("2500"));
        expect((await perp.callStatic.getStdTrancheBalances())[1]).to.eq(toFixedPtAmt("1000"));
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
        expect(await perp.reserveBalance(collateralToken.address)).to.eq("553710919999999999999");
      });
    });

    describe("when some reserve tranches are mature and yields are different", async function () {
      let issuer: Contract;
      let tx: Transaction;
      const reserveTranches: Contract[] = [];
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await BondIssuer.deploy(bondFactory.address, 1200, 0, 10800, collateralToken.address, [500, 500]);
        await perp.updateBondIssuer(issuer.address);
        await perp.updateTolerableTrancheMaturiy(0, 10800);
        await advancePerpQueue(perp, 10900);
        for (let i = 0; i < 5; i++) {
          const depositBond = await bondAt(await perp.callStatic.getDepositBond());
          const tranches = await getTranches(depositBond);
          await pricingStrategy.setTranchePrice(tranches[0].address, toPriceFixedPtAmt("1"));
          if (i === 0) {
            await yieldStrategy.setTrancheYield(tranches[0].address, toYieldFixedPtAmt("0.5"));
          } else {
            await yieldStrategy.setTrancheYield(tranches[0].address, toYieldFixedPtAmt("1"));
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
        expect(await perp.reserveCount()).to.eq("6");
        expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(toFixedPtAmt("2250"));
        expect((await perp.callStatic.getStdTrancheBalances())[1]).to.eq("0");
        expect(await perp.reserveBalance(collateralToken.address)).to.eq("0");

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
        expect(await perp.reserveCount()).to.eq("4");
      });

      it("should change mature tranche balances", async function () {
        expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(toFixedPtAmt("2250"));
        expect((await perp.callStatic.getStdTrancheBalances())[1]).to.eq(toFixedPtAmt("750"));
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
        expect(await perp.reserveBalance(collateralToken.address)).to.eq(toFixedPtAmt("1000"));
      });
    });
  });
});
