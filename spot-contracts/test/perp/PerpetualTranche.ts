import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Transaction, Signer } from "ethers";
import {
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  depositIntoBond,
  getTranches,
  toFixedPtAmt,
  advancePerpQueue,
  bondAt,
  checkPerpComposition,
  TimeHelpers,
  rebase,
  advancePerpQueueToRollover,
  toPercFixedPtAmt,
  DMock,
} from "../helpers";

let perp: Contract,
  collateralToken: Contract,
  rebaseOracle: Contract,
  issuer: Contract,
  feePolicy: Contract,
  deployer: Signer,
  otherUser: Signer;
describe("PerpetualTranche", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));

    issuer = new DMock(await ethers.getContractFactory("BondIssuer"));
    await issuer.deploy();
    await issuer.mockMethod("collateral()", [collateralToken.target]);
    await issuer.mockMethod("getLatestBond()", [ethers.ZeroAddress]);

    feePolicy = new DMock(await ethers.getContractFactory("FeePolicy"));
    await feePolicy.deploy();
    await feePolicy.mockMethod("decimals()", [8]);
    await feePolicy.mockMethod("computeDeviationRatio((uint256,uint256))", [toPercFixedPtAmt("1")]);
    await feePolicy.mockMethod("computeFeePerc(uint256,uint256)", [0]);

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await upgrades.deployProxy(
      PerpetualTranche.connect(deployer),
      ["PerpetualTranche", "PERP", collateralToken.target, issuer.target, feePolicy.target],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );

    const TrancheManager = await ethers.getContractFactory("TrancheManager");
    const trancheManager = await TrancheManager.deploy();
    const RolloverVault = await ethers.getContractFactory("RolloverVault", {
      libraries: {
        TrancheManager: trancheManager.target,
      },
    });
    const vault = new DMock(RolloverVault);
    await vault.deploy();
    await vault.mockMethod("getTVL()", [0]);
    await perp.updateVault(vault.target);
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
      expect(await perp.bondIssuer()).to.eq(issuer.target);
      expect(await perp.feePolicy()).to.eq(feePolicy.target);
    });

    it("should set underlying collateral reference", async function () {
      expect(await perp.underlying()).to.eq(collateralToken.target);
    });

    it("should initialize lists", async function () {
      expect(await perp.getReserveCount.staticCall()).to.eq(1);
    });

    it("should set hyper parameters", async function () {
      expect(await perp.minTrancheMaturitySec()).to.eq(86400 * 7);
      expect(await perp.maxTrancheMaturitySec()).to.eq(86400 * 31);
      expect(await perp.maxSupply()).to.eq(ethers.MaxUint256);
      expect(await perp.maxDepositTrancheValuePerc()).to.eq(toPercFixedPtAmt("1"));
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
        await expect(perp.connect(deployer).pause()).to.be.revertedWithCustomError(perp, "UnauthorizedCall");
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
        await expect(perp.connect(deployer).unpause()).to.be.revertedWithCustomError(perp, "UnauthorizedCall");
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
        await expect(perp.connect(otherUser).updateKeeper(ethers.ZeroAddress)).to.be.revertedWith(
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
    });
  });

  describe("#updateVault", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updateVault(ethers.ZeroAddress)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when vault reference is set", function () {
      let tx: Transaction, vault: Contract;
      beforeEach(async function () {
        const TrancheManager = await ethers.getContractFactory("TrancheManager");
        const trancheManager = await TrancheManager.deploy();
        const RolloverVault = await ethers.getContractFactory("RolloverVault", {
          libraries: {
            TrancheManager: trancheManager.target,
          },
        });
        vault = new DMock(RolloverVault);
        await vault.deploy();
        await vault.mockMethod("getTVL()", [0]);

        tx = perp.connect(deployer).updateVault(vault.target);
        await tx;
      });
      it("should update vault reference", async function () {
        expect(await perp.vault()).to.eq(vault.target);
      });
    });
  });

  describe("#updateBondIssuer", function () {
    let newIssuer: Contract, tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updateBondIssuer(ethers.ZeroAddress)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set address is valid", function () {
      beforeEach(async function () {
        newIssuer = new DMock(await ethers.getContractFactory("BondIssuer"));
        await newIssuer.deploy();
        await newIssuer.mockMethod("collateral()", [collateralToken.target]);

        tx = perp.updateBondIssuer(newIssuer.target);
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.bondIssuer()).to.eq(newIssuer.target);
      });
    });

    describe("when collateral is NOT valid", function () {
      beforeEach(async function () {
        newIssuer = new DMock(await ethers.getContractFactory("BondIssuer"));
        await newIssuer.deploy();
        await newIssuer.mockMethod("collateral()", [ethers.ZeroAddress]);
      });
      it("should revert", async function () {
        await expect(perp.updateBondIssuer(newIssuer.target)).to.be.revertedWithCustomError(perp, "UnexpectedAsset");
      });
    });
  });

  describe("#updateFeePolicy", function () {
    let newFeePolicy: Contract, tx: Transaction;

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updateFeePolicy(ethers.ZeroAddress)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set strategy decimals dont match", function () {
      it("should revert", async function () {
        newFeePolicy = new DMock(await ethers.getContractFactory("FeePolicy"));
        await newFeePolicy.deploy();
        await newFeePolicy.mockMethod("decimals()", [7]);
        await expect(perp.updateFeePolicy(newFeePolicy.target)).to.be.revertedWithCustomError(
          perp,
          "UnexpectedDecimals",
        );
      });
    });

    describe("when set address is valid", function () {
      beforeEach(async function () {
        newFeePolicy = new DMock(await ethers.getContractFactory("FeePolicy"));
        await newFeePolicy.deploy();
        await newFeePolicy.mockMethod("decimals()", [8]);
        tx = perp.updateFeePolicy(newFeePolicy.target);
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.feePolicy()).to.eq(newFeePolicy.target);
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
        await expect(perp.updateTolerableTrancheMaturity(86400, 3600)).to.be.revertedWithCustomError(
          perp,
          "UnacceptableParams",
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
    });
  });

  describe("#updateMaxSupply", function () {
    let tx: Transaction;

    describe("when triggered by non-keeper", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).updateMaxSupply(ethers.MaxUint256)).to.be.revertedWithCustomError(
          perp,
          "UnauthorizedCall",
        );
      });
    });

    describe("when triggered by owner", function () {
      beforeEach(async function () {
        await perp.updateKeeper(await otherUser.getAddress());
        tx = perp.connect(otherUser).updateMaxSupply(toFixedPtAmt("100"));
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.maxSupply()).to.eq(toFixedPtAmt("100"));
      });
    });
  });

  describe("#updateMaxDepositTrancheValuePerc", function () {
    let tx: Transaction;

    describe("when triggered by non-keeper", function () {
      it("should revert", async function () {
        await expect(
          perp.connect(otherUser).updateMaxDepositTrancheValuePerc(toPercFixedPtAmt("0.33")),
        ).to.be.revertedWithCustomError(perp, "UnauthorizedCall");
      });
    });

    describe("when invalid perc", function () {
      it("should revert", async function () {
        await perp.updateKeeper(await otherUser.getAddress());
        await expect(
          perp.connect(otherUser).updateMaxDepositTrancheValuePerc(toPercFixedPtAmt("1.01")),
        ).to.be.revertedWithCustomError(perp, "InvalidPerc");
      });
    });

    describe("when triggered by owner", function () {
      beforeEach(async function () {
        await perp.updateKeeper(await otherUser.getAddress());
        tx = perp.connect(otherUser).updateMaxDepositTrancheValuePerc(toPercFixedPtAmt("0.33"));
        await tx;
      });
      it("should update reference", async function () {
        expect(await perp.maxDepositTrancheValuePerc()).to.eq(toPercFixedPtAmt("0.33"));
      });
    });
  });

  describe("#transferERC20", function () {
    let transferToken: Contract, toAddress: string;

    beforeEach(async function () {
      const Token = await ethers.getContractFactory("MockERC20");
      transferToken = await Token.deploy();
      await transferToken.init("Mock Token", "MOCK");
      await transferToken.mint(perp.target, "100");
      toAddress = await deployer.getAddress();
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(perp.connect(otherUser).transferERC20(transferToken.target, toAddress, "100")).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when non reserve asset", function () {
      it("should transfer", async function () {
        await expect(() => perp.transferERC20(transferToken.target, toAddress, "100")).to.changeTokenBalance(
          transferToken,
          deployer,
          "100",
        );
      });
    });

    describe("when reserve asset", function () {
      it("should revert", async function () {
        expect(await perp.inReserve.staticCall(collateralToken.target)).to.eq(true);
        await expect(
          perp.transferERC20(collateralToken.target, toAddress, toFixedPtAmt("100")),
        ).to.be.revertedWithCustomError(perp, "UnauthorizedTransferOut");
      });
    });

    describe("when withdrawing perp", function () {
      it("should NOT revert", async function () {
        const bondFactory = await setupBondFactory();
        const bond = await createBondWithFactory(bondFactory, collateralToken, [200, 800], 3600);
        const tranches = await getTranches(bond);
        await issuer.mockMethod("getLatestBond()", [bond.target]);

        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.target, toFixedPtAmt("100"));
        await perp.deposit(tranches[0].target, toFixedPtAmt("100"));
        await perp.transfer(perp.target, toFixedPtAmt("100"));
        await expect(perp.transferERC20(perp.target, toAddress, toFixedPtAmt("100"))).not.to.be.reverted;
      });
    });
  });

  describe("#reserve", function () {
    let bondFactory: Contract, bond: Contract, tranches: Contract[], bondNext: Contract, tranchesNext: Contract[];
    beforeEach(async function () {
      bondFactory = await setupBondFactory();
    });

    describe("when reserve has no tranches", function () {
      it("should have expected reserve composition", async function () {
        await checkPerpComposition(perp, [collateralToken], ["0"]);
      });
      it("should calculate the tvl", async function () {
        expect(await perp.getTVL.staticCall()).to.eq(0);
      });
    });

    describe("when reserve has one tranche", function () {
      beforeEach(async function () {
        bond = await createBondWithFactory(bondFactory, collateralToken, [200, 800], 3600);
        tranches = await getTranches(bond);
        await issuer.mockMethod("getLatestBond()", [bond.target]);

        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.target, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].target, toFixedPtAmt("200"));
      });

      it("should have expected reserve composition", async function () {
        await checkPerpComposition(perp, [collateralToken, tranches[0]], ["0", toFixedPtAmt("200")]);
      });
      it("should calculate the tvl", async function () {
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("200"));
      });
    });

    describe("when reserve has many tranches", function () {
      beforeEach(async function () {
        bond = await createBondWithFactory(bondFactory, collateralToken, [200, 800], 3600);
        tranches = await getTranches(bond);
        await issuer.mockMethod("getLatestBond()", [bond.target]);

        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.target, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].target, toFixedPtAmt("200"));

        await rebase(collateralToken, rebaseOracle, -0.9);

        bondNext = await createBondWithFactory(bondFactory, collateralToken, [200, 800], 3600);
        tranchesNext = await getTranches(bondNext);
        await issuer.mockMethod("getLatestBond()", [bondNext.target]);

        await depositIntoBond(bondNext, toFixedPtAmt("1000"), deployer);
        await tranchesNext[0].approve(perp.target, toFixedPtAmt("100"));
        await perp.deposit(tranchesNext[0].target, toFixedPtAmt("100"));
      });

      it("should have expected reserve composition", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, tranches[0], tranchesNext[0]],
          ["0", toFixedPtAmt("200"), toFixedPtAmt("100")],
        );
      });
      it("should calculate the tvl", async function () {
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("200"));
      });
    });

    describe("when reserve has only mature collateral", function () {
      let issuer: Contract;
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await upgrades.deployProxy(
          BondIssuer.connect(deployer),
          [bondFactory.target, collateralToken.target, 3600, [200, 800], 1200, 0],
          {
            initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
          },
        );
        await perp.updateBondIssuer(issuer.target);

        await advancePerpQueue(perp, 1200);
        bond = await bondAt(await perp.getDepositBond.staticCall());
        tranches = await getTranches(bond);

        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.target, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].target, toFixedPtAmt("200"));

        await advancePerpQueue(perp, 1200);
        bondNext = await bondAt(await perp.getDepositBond.staticCall());
        tranchesNext = await getTranches(bondNext);

        await depositIntoBond(bondNext, toFixedPtAmt("1000"), deployer);
        await tranchesNext[0].approve(perp.target, toFixedPtAmt("100"));
        await perp.deposit(tranchesNext[0].target, toFixedPtAmt("100"));

        await advancePerpQueue(perp, 36000);
      });

      it("should have expected reserve composition", async function () {
        await checkPerpComposition(perp, [collateralToken], [toFixedPtAmt("300")]);
      });
      it("should calculate the tvl", async function () {
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("300"));
      });
    });

    describe("when reserve has mature collateral and tranches", function () {
      let issuer: Contract;
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await upgrades.deployProxy(
          BondIssuer.connect(deployer),
          [bondFactory.target, collateralToken.target, 3600, [200, 800], 1200, 0],
          {
            initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
          },
        );
        await perp.updateBondIssuer(issuer.target);

        await advancePerpQueue(perp, 3600);
        bond = await bondAt(await perp.getDepositBond.staticCall());
        tranches = await getTranches(bond);

        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.target, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].target, toFixedPtAmt("200"));

        await advancePerpQueue(perp, 1200);
        bondNext = await bondAt(await perp.getDepositBond.staticCall());
        tranchesNext = await getTranches(bondNext);

        await depositIntoBond(bondNext, toFixedPtAmt("1000"), deployer);
        await tranchesNext[0].approve(perp.target, toFixedPtAmt("100"));
        await perp.deposit(tranchesNext[0].target, toFixedPtAmt("100"));

        await advancePerpQueue(perp, 2400);
      });

      it("should have expected reserve composition", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, tranchesNext[0]],
          [toFixedPtAmt("200"), toFixedPtAmt("100")],
        );
      });
      it("should calculate the tvl", async function () {
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("300"));
      });
    });

    describe("when reserve has mature collateral which has rebased up and tranches", function () {
      let issuer: Contract;
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await upgrades.deployProxy(
          BondIssuer.connect(deployer),
          [bondFactory.target, collateralToken.target, 3600, [200, 800], 1200, 0],
          {
            initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
          },
        );
        await perp.updateBondIssuer(issuer.target);
        await advancePerpQueue(perp, 3600);
        bond = await bondAt(await perp.getDepositBond.staticCall());
        tranches = await getTranches(bond);

        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.target, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].target, toFixedPtAmt("200"));

        await advancePerpQueue(perp, 1200);
        bondNext = await bondAt(await perp.getDepositBond.staticCall());
        tranchesNext = await getTranches(bondNext);

        await depositIntoBond(bondNext, toFixedPtAmt("1000"), deployer);
        await tranchesNext[0].approve(perp.target, toFixedPtAmt("100"));
        await perp.deposit(tranchesNext[0].target, toFixedPtAmt("100"));

        await advancePerpQueue(perp, 2400);

        await rebase(collateralToken, rebaseOracle, 0.1);
      });

      it("should have expected reserve composition", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, tranchesNext[0]],
          [toFixedPtAmt("220"), toFixedPtAmt("100")],
        );
      });
      it("should calculate the tvl", async function () {
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("320"));
      });
    });

    describe("when reserve has mature collateral which has rebased down and tranches", function () {
      let issuer: Contract;
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await upgrades.deployProxy(
          BondIssuer.connect(deployer),
          [bondFactory.target, collateralToken.target, 3600, [200, 800], 1200, 0],
          {
            initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
          },
        );
        await perp.updateBondIssuer(issuer.target);

        await advancePerpQueue(perp, 3600);
        bond = await bondAt(await perp.getDepositBond.staticCall());
        tranches = await getTranches(bond);

        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.target, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].target, toFixedPtAmt("200"));

        await advancePerpQueue(perp, 1200);
        bondNext = await bondAt(await perp.getDepositBond.staticCall());
        tranchesNext = await getTranches(bondNext);

        await depositIntoBond(bondNext, toFixedPtAmt("1000"), deployer);
        await tranchesNext[0].approve(perp.target, toFixedPtAmt("100"));
        await perp.deposit(tranchesNext[0].target, toFixedPtAmt("100"));

        await advancePerpQueue(perp, 2400);

        await rebase(collateralToken, rebaseOracle, -0.1);
      });

      it("should have expected reserve composition", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, tranchesNext[0]],
          [toFixedPtAmt("180"), toFixedPtAmt("100")],
        );
      });
      it("should calculate the tvl", async function () {
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("280"));
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
      describe("when deposit bond matures too late", async function () {
        beforeEach(async function () {
          await perp.updateTolerableTrancheMaturity(1200, 7200);
          bond = await createBondWithFactory(bondFactory, collateralToken, [200, 800], 7210);
          await issuer.mockMethod("getLatestBond()", [bond.target]);
          await perp.updateState();
        });

        it("should NOT update the deposit bond", async function () {
          expect(await perp.getDepositBond.staticCall()).to.not.eq(bond.target);
        });
      });

      describe("when deposit bond belongs to a different collateral token", async function () {
        beforeEach(async function () {
          await perp.updateTolerableTrancheMaturity(1200, 7200);
          const r = await setupCollateralToken("Ethereum", "ETH");
          bond = await createBondWithFactory(bondFactory, r.collateralToken, [200, 800], 3600);
          await issuer.mockMethod("getLatestBond()", [bond.target]);
          await perp.updateState();
        });

        it("should NOT update the deposit bond", async function () {
          expect(await perp.getDepositBond.staticCall()).to.not.eq(bond.target);
        });
      });

      describe("when deposit bond is acceptable", async function () {
        let tx: Transaction;
        beforeEach(async function () {
          await perp.updateTolerableTrancheMaturity(1200, 7200);
          bond = await createBondWithFactory(bondFactory, collateralToken, [200, 800], 3600);
          await issuer.mockMethod("getLatestBond()", [bond.target]);
          tx = perp.updateState();
          await tx;
        });

        it("should update the deposit bond", async function () {
          expect(await perp.getDepositBond.staticCall()).to.eq(bond.target);
        });

        it("should emit event", async function () {
          await expect(tx).to.emit(perp, "UpdatedDepositBond").withArgs(bond.target);
        });
      });
    });

    describe("when no reserve tranche is mature", async function () {
      let issuer: Contract, tx: Transaction;
      const reserveTranches: Contract[] = [];
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await upgrades.deployProxy(
          BondIssuer.connect(deployer),
          [bondFactory.target, collateralToken.target, 10800, [500, 500], 1200, 0],
          {
            initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
          },
        );

        await perp.updateBondIssuer(issuer.target);
        await perp.updateTolerableTrancheMaturity(0, 10800);
        await advancePerpQueue(perp, 10900);
        for (let i = 0; i < 5; i++) {
          const depositBond = await bondAt(await perp.getDepositBond.staticCall());
          const tranches = await getTranches(depositBond);
          await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
          await tranches[0].approve(perp.target, toFixedPtAmt("500"));
          await perp.deposit(tranches[0].target, toFixedPtAmt("500"));
          reserveTranches[i] = tranches[0];
          await advancePerpQueue(perp, 1200);
        }

        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches],
          [
            "0",
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
          ],
        );

        expect(await perp.getReserveCount.staticCall()).to.eq("6");
        expect(await collateralToken.balanceOf(perp.target)).to.eq("0");

        await TimeHelpers.increaseTime(1200);
        tx = await perp.updateState();
        await tx;
      });

      it("should have expected reserve composition", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches],
          [
            "0",
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
          ],
        );
      });

      it("should NOT change reserveCount", async function () {
        expect(await perp.getReserveCount.staticCall()).to.eq("6");
      });

      it("should NOT change tranche balances", async function () {});

      it("should emit ReserveSynced", async function () {
        await expect(tx).to.emit(perp, "ReserveSynced").withArgs(collateralToken.target, "0");
      });

      it("should NOT update the reserve balance", async function () {
        expect(await collateralToken.balanceOf(perp.target)).to.eq("0");
      });
    });

    describe("when some reserve tranches are mature", async function () {
      let issuer: Contract;
      let tx: Transaction;
      const reserveTranches: Contract[] = [];
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await upgrades.deployProxy(
          BondIssuer.connect(deployer),
          [bondFactory.target, collateralToken.target, 10800, [500, 500], 1200, 0],
          {
            initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
          },
        );
        await perp.updateBondIssuer(issuer.target);
        await perp.updateTolerableTrancheMaturity(0, 10800);
        await advancePerpQueue(perp, 10900);
        for (let i = 0; i < 5; i++) {
          const depositBond = await bondAt(await perp.getDepositBond.staticCall());
          const tranches = await getTranches(depositBond);
          await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
          await tranches[0].approve(perp.target, toFixedPtAmt("500"));
          await perp.deposit(tranches[0].target, toFixedPtAmt("500"));
          reserveTranches[i] = tranches[0];
          await advancePerpQueue(perp, 1200);
        }

        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches],
          [
            "0",
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
          ],
        );
        expect(await perp.getReserveCount.staticCall()).to.eq("6");
        expect(await collateralToken.balanceOf(perp.target)).to.eq("0");

        await TimeHelpers.increaseTime(6000);
        // NOTE: invoking mature on reserveTranches[0],
        // updateState invokes mature on reserveTranches[1]
        await (await bondAt(await reserveTranches[0].bond())).mature();

        tx = perp.updateState();
        await tx;
      });

      it("should have expected reserve composition", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, reserveTranches[3], reserveTranches[4], reserveTranches[2]],
          [toFixedPtAmt("1000"), toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
      });

      it("should change reserveCount", async function () {
        expect(await perp.getReserveCount.staticCall()).to.eq("4");
      });

      it("should call mature if not already called", async function () {
        await expect(tx)
          .to.emit(await bondAt(await reserveTranches[1].bond()), "Mature")
          .withArgs(perp.target);
      });

      it("should emit ReserveSynced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.target, toFixedPtAmt("1000"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranches[0].target, "0")
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranches[1].target, "0");
      });

      it("should update the reserve balance", async function () {
        expect(await collateralToken.balanceOf(perp.target)).to.eq(toFixedPtAmt("1000"));
      });
    });

    describe("when some reserve tranches are mature and rebases down", async function () {
      let issuer: Contract;
      let tx: Transaction;
      const reserveTranches: Contract[] = [];
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await upgrades.deployProxy(
          BondIssuer.connect(deployer),
          [bondFactory.target, collateralToken.target, 10800, [500, 500], 1200, 0],
          {
            initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
          },
        );
        await perp.updateBondIssuer(issuer.target);
        await perp.updateTolerableTrancheMaturity(0, 10800);
        await advancePerpQueue(perp, 10900);
        for (let i = 0; i < 5; i++) {
          const depositBond = await bondAt(await perp.getDepositBond.staticCall());
          const tranches = await getTranches(depositBond);
          await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
          await tranches[0].approve(perp.target, toFixedPtAmt("500"));
          await perp.deposit(tranches[0].target, toFixedPtAmt("500"));
          reserveTranches[i] = tranches[0];
          await advancePerpQueue(perp, 1200);
          await rebase(collateralToken, rebaseOracle, -0.25);
        }

        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches],
          [
            "0",
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
          ],
        );
        expect(await perp.getReserveCount.staticCall()).to.eq("6");
        expect(await collateralToken.balanceOf(perp.target)).to.eq("0");

        await TimeHelpers.increaseTime(6000);
        tx = perp.updateState();
        await tx;
      });

      it("should have expected reserve composition", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, reserveTranches[3], reserveTranches[4], reserveTranches[2]],
          [toFixedPtAmt("553.710919999999999999"), toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
      });

      it("should change reserveCount", async function () {
        expect(await perp.getReserveCount.staticCall()).to.eq("4");
      });

      it("should call mature if not already called", async function () {
        await expect(tx)
          .to.emit(await bondAt(await reserveTranches[0].bond()), "Mature")
          .withArgs(perp.target)
          .to.emit(await bondAt(await reserveTranches[1].bond()), "Mature")
          .withArgs(perp.target);
      });

      it("should emit ReserveSynced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.target, "553710919999999999999")
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranches[0].target, "0")
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranches[1].target, "0");
      });

      it("should update the reserve balance", async function () {
        expect(await collateralToken.balanceOf(perp.target)).to.eq("553710919999999999999");
      });
    });

    describe("when some reserve tranches are mature", async function () {
      let issuer: Contract;
      let tx: Transaction;
      const reserveTranches: Contract[] = [];
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await upgrades.deployProxy(
          BondIssuer.connect(deployer),
          [bondFactory.target, collateralToken.target, 10800, [500, 500], 1200, 0],
          {
            initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
          },
        );
        await perp.updateBondIssuer(issuer.target);
        await perp.updateTolerableTrancheMaturity(0, 10800);
        await advancePerpQueue(perp, 10900);
        for (let i = 0; i < 5; i++) {
          const depositBond = await bondAt(await perp.getDepositBond.staticCall());
          const tranches = await getTranches(depositBond);
          await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
          await tranches[0].approve(perp.target, toFixedPtAmt("500"));
          await perp.deposit(tranches[0].target, toFixedPtAmt("500"));
          reserveTranches[i] = tranches[0];
          await advancePerpQueue(perp, 1200);
        }

        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches],
          [
            "0",
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
          ],
        );
        expect(await perp.getReserveCount.staticCall()).to.eq("6");
        expect(await collateralToken.balanceOf(perp.target)).to.eq("0");

        await TimeHelpers.increaseTime(6000);
        tx = perp.updateState();
        await tx;
      });

      it("should have expected reserve composition", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, reserveTranches[3], reserveTranches[4], reserveTranches[2]],
          [toFixedPtAmt("1000"), toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
      });

      it("should change reserveCount", async function () {
        expect(await perp.getReserveCount.staticCall()).to.eq("4");
      });

      it("should change mature tranche balances", async function () {});

      it("should call mature if not already called", async function () {
        await expect(tx)
          .to.emit(await bondAt(await reserveTranches[0].bond()), "Mature")
          .withArgs(perp.target)
          .to.emit(await bondAt(await reserveTranches[1].bond()), "Mature")
          .withArgs(perp.target);
      });

      it("should emit ReserveSynced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.target, toFixedPtAmt("1000"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranches[0].target, "0")
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranches[1].target, "0");
      });

      it("should update the reserve balance", async function () {
        expect(await collateralToken.balanceOf(perp.target)).to.eq(toFixedPtAmt("1000"));
      });
    });

    describe("when paused", async function () {
      let issuer: Contract;
      let tx: Transaction;
      const reserveTranches: Contract[] = [];
      beforeEach(async function () {
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        issuer = await upgrades.deployProxy(
          BondIssuer.connect(deployer),
          [bondFactory.target, collateralToken.target, 10800, [500, 500], 1200, 0],
          {
            initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
          },
        );
        await perp.updateBondIssuer(issuer.target);
        await perp.updateTolerableTrancheMaturity(0, 10800);
        await advancePerpQueue(perp, 10900);
        for (let i = 0; i < 5; i++) {
          const depositBond = await bondAt(await perp.getDepositBond.staticCall());
          const tranches = await getTranches(depositBond);
          await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
          await tranches[0].approve(perp.target, toFixedPtAmt("500"));
          await perp.deposit(tranches[0].target, toFixedPtAmt("500"));
          reserveTranches[i] = tranches[0];
          await advancePerpQueue(perp, 1200);
        }

        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches],
          [
            "0",
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
          ],
        );
        expect(await perp.getReserveCount.staticCall()).to.eq("6");
        expect(await collateralToken.balanceOf(perp.target)).to.eq("0");

        await TimeHelpers.increaseTime(6000);
        await perp.updateKeeper(await deployer.getAddress());
        await perp.pause();
        tx = perp.updateState();
        await tx;
      });

      it("should have not updated composition", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches],
          [
            "0",
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
          ],
        );
      });
    });
  });

  describe("#getReserveTokensUpForRollover", async function () {
    const depositTranches: Contract[] = [];
    beforeEach(async function () {
      const bondFactory = await setupBondFactory();
      const BondIssuer = await ethers.getContractFactory("BondIssuer");
      issuer = await upgrades.deployProxy(
        BondIssuer.connect(deployer),
        [bondFactory.target, collateralToken.target, 10800, [500, 500], 1200, 0],
        {
          initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
        },
      );
      await perp.updateBondIssuer(issuer.target);
      await perp.updateTolerableTrancheMaturity(600, 10800);
      await advancePerpQueue(perp, 10900);
      for (let i = 0; i < 5; i++) {
        const depositBond = await bondAt(await perp.getDepositBond.staticCall());
        const tranches = await getTranches(depositBond);
        await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.target, toFixedPtAmt("500"));
        await perp.deposit(tranches[0].target, toFixedPtAmt("500"));
        depositTranches[i] = tranches[0];
        await advancePerpQueue(perp, 1200);
      }
      await advancePerpQueueToRollover(perp, await bondAt(await depositTranches[2].bond()));
    });

    it("should get the rollover ready tranches", async function () {
      const r = await perp.getReserveTokensUpForRollover.staticCall();
      expect(r).to.include(collateralToken.target);
      expect(r).to.include(depositTranches[2].target);
      expect(r).not.to.include(depositTranches[0].target);
      expect(r).not.to.include(depositTranches[1].target);
      expect(r).not.to.include(depositTranches[3].target);
      expect(r).not.to.include(depositTranches[4].target);
    });
  });

  describe("#getReserveTokenBalance", async function () {
    const depositTranches: Contract[] = [];
    beforeEach(async function () {
      const bondFactory = await setupBondFactory();
      const BondIssuer = await ethers.getContractFactory("BondIssuer");
      issuer = await upgrades.deployProxy(
        BondIssuer.connect(deployer),
        [bondFactory.target, collateralToken.target, 10800, [500, 500], 1200, 0],
        {
          initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
        },
      );
      await perp.updateBondIssuer(issuer.target);
      await perp.updateTolerableTrancheMaturity(600, 10800);
      await advancePerpQueue(perp, 10900);
      for (let i = 0; i < 5; i++) {
        const depositBond = await bondAt(await perp.getDepositBond.staticCall());
        const tranches = await getTranches(depositBond);
        await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.target, toFixedPtAmt("500"));
        await perp.deposit(tranches[0].target, toFixedPtAmt("500"));
        depositTranches[i] = tranches[0];
        await advancePerpQueue(perp, 1200);
      }
      await advancePerpQueueToRollover(perp, await bondAt(await depositTranches[2].bond()));
    });

    it("should return the token balance", async function () {
      expect(await perp.getReserveTokenBalance.staticCall(perp.target)).to.eq("0");
      expect(await perp.getReserveTokenBalance.staticCall(collateralToken.target)).to.eq(toFixedPtAmt("1000"));
      expect(await perp.getReserveTokenBalance.staticCall(depositTranches[0].target)).to.eq("0");
      expect(await perp.getReserveTokenBalance.staticCall(depositTranches[1].target)).to.eq("0");
      expect(await perp.getReserveTokenBalance.staticCall(depositTranches[2].target)).to.eq(toFixedPtAmt("500"));
      expect(await perp.getReserveTokenBalance.staticCall(depositTranches[3].target)).to.eq(toFixedPtAmt("500"));
      expect(await perp.getReserveTokenBalance.staticCall(depositTranches[4].target)).to.eq(toFixedPtAmt("500"));
    });
  });

  describe("#getReserveTokenValue", async function () {
    const depositTranches: Contract[] = [];
    beforeEach(async function () {
      const bondFactory = await setupBondFactory();
      const BondIssuer = await ethers.getContractFactory("BondIssuer");
      issuer = await upgrades.deployProxy(
        BondIssuer.connect(deployer),
        [bondFactory.target, collateralToken.target, 10800, [500, 500], 1200, 0],
        {
          initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
        },
      );
      await perp.updateBondIssuer(issuer.target);
      await perp.updateTolerableTrancheMaturity(600, 10800);
      await advancePerpQueue(perp, 10900);
      for (let i = 0; i < 5; i++) {
        const depositBond = await bondAt(await perp.getDepositBond.staticCall());
        const tranches = await getTranches(depositBond);
        await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.target, toFixedPtAmt("500"));
        await perp.deposit(tranches[0].target, toFixedPtAmt("500"));
        depositTranches[i] = tranches[0];
        await advancePerpQueue(perp, 1200);
        await rebase(collateralToken, rebaseOracle, -0.5);
      }
      await advancePerpQueueToRollover(perp, await bondAt(await depositTranches[2].bond()));
    });

    it("should return the tranche value", async function () {
      expect(await perp.getReserveTokenValue.staticCall(perp.target)).to.eq("0");
      expect(await perp.getReserveTokenValue.staticCall(collateralToken.target)).to.eq(toFixedPtAmt("93.75"));
      expect(await perp.getReserveTokenValue.staticCall(depositTranches[0].target)).to.eq("0");
      expect(await perp.getReserveTokenValue.staticCall(depositTranches[1].target)).to.eq("0");
      expect(await perp.getReserveTokenValue.staticCall(depositTranches[2].target)).to.eq(toFixedPtAmt("125"));
      expect(await perp.getReserveTokenValue.staticCall(depositTranches[3].target)).to.eq(toFixedPtAmt("250"));
      expect(await perp.getReserveTokenValue.staticCall(depositTranches[4].target)).to.eq(toFixedPtAmt("500"));
    });
  });
});
