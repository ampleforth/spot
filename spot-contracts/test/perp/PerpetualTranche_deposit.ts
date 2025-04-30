import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Transaction, Signer } from "ethers";
import {
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toPercFixedPtAmt,
  toFixedPtAmt,
  advancePerpQueue,
  checkPerpComposition,
  rebase,
  mintCollteralToken,
  DMock,
} from "../helpers";

let perp: Contract,
  bondFactory: Contract,
  rebaseOracle: Contract,
  collateralToken: Contract,
  issuer: Contract,
  feePolicy: Contract,
  deployer: Signer,
  deployerAddress: string,
  depositBond: Contract,
  depositTrancheA: Contract,
  depositTrancheZ: Contract;
describe("PerpetualTranche", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    deployerAddress = await deployer.getAddress();

    bondFactory = await setupBondFactory();
    ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));

    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await upgrades.deployProxy(
      BondIssuer.connect(deployer),
      [bondFactory.target, collateralToken.target, 3600, [500, 500], 1200, 0],
      {
        initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
      },
    );

    feePolicy = new DMock(await ethers.getContractFactory("FeePolicy"));
    await feePolicy.deploy();
    await feePolicy.mockMethod("decimals()", [8]);
    await feePolicy.mockMethod("computeDeviationRatio((uint256,uint256,uint256))", [toPercFixedPtAmt("1")]);
    await feePolicy.mockMethod("computeFeePerc(uint256,uint256)", [0]);

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await upgrades.deployProxy(
      PerpetualTranche.connect(deployer),
      ["PerpetualTranche", "PERP", collateralToken.target, issuer.target, feePolicy.target],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );
    await advancePerpQueue(perp, 3600);

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

    depositBond = await bondAt(await perp.getDepositBond.staticCall());
    [depositTrancheA, depositTrancheZ] = await getTranches(depositBond);

    await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
    await depositTrancheA.approve(perp.target, toFixedPtAmt("500"));
    await depositTrancheZ.approve(perp.target, toFixedPtAmt("500"));
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#deposit", function () {
    describe("when paused", function () {
      beforeEach(async function () {
        await perp.updateKeeper(deployerAddress);
        await perp.pause();
      });

      it("should revert", async function () {
        await expect(perp.deposit(depositTrancheA.target, toFixedPtAmt("500"))).to.revertedWith("Pausable: paused");
      });
    });

    describe("when bond issuer is NOT set correctly", function () {
      let bond: Contract;
      beforeEach(async function () {
        bond = await createBondWithFactory(bondFactory, perp, [200, 300, 500], 3600);
        const newIssuer = new DMock(await ethers.getContractFactory("BondIssuer"));
        await newIssuer.deploy();
        await newIssuer.mockMethod("collateral()", [collateralToken.target]);
        await newIssuer.mockMethod("getLatestBond()", [bond.target]);
        await perp.updateBondIssuer(newIssuer.target);
      });
      it("should not update the deposit bond", async function () {
        await depositTrancheA.approve(perp.target, toFixedPtAmt("500"));
        await expect(perp.deposit(depositTrancheA.target, toFixedPtAmt("500"))).to.not.be.reverted;
        expect(await perp.getDepositBond.staticCall()).to.not.eq(bond.target);
      });
    });

    describe("when the trancheIn is not of deposit bond", function () {
      beforeEach(async function () {
        const bond = await createBondWithFactory(bondFactory, collateralToken, [500, 500], 3600);
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        depositTrancheA = (await getTranches(bond))[0];
      });
      it("should revert", async function () {
        await depositTrancheA.approve(perp.target, toFixedPtAmt("500"));
        await expect(perp.deposit(depositTrancheA.target, toFixedPtAmt("500"))).to.revertedWithCustomError(
          perp,
          "UnexpectedAsset",
        );
      });
    });

    describe("when the malicious trancheIn is deposited which points to the deposit bond", function () {
      it("should revert", async function () {
        const ERC20 = await ethers.getContractFactory("MockTranche");
        const maliciousTranche = await ERC20.deploy();
        await maliciousTranche.init("Tranche", "TRA");
        await maliciousTranche.mint(deployerAddress, toFixedPtAmt("500"));
        await maliciousTranche.setBond(await perp.getDepositBond.staticCall());
        await maliciousTranche.approve(perp.target, toFixedPtAmt("500"));
        await expect(perp.deposit(maliciousTranche.target, toFixedPtAmt("500"))).to.revertedWithCustomError(
          perp,
          "UnexpectedAsset",
        );
      });
    });

    describe("when user has not approved sufficient tranche tokens", function () {
      beforeEach(async function () {
        await depositTrancheA.approve(perp.target, "0");
      });
      it("should revert", async function () {
        await expect(perp.deposit(depositTrancheA.target, toFixedPtAmt("500"))).to.revertedWith(
          "ERC20: transfer amount exceeds allowance",
        );
      });
    });

    describe("when user has insufficient balance", function () {
      beforeEach(async function () {
        await depositTrancheA.transfer(perp.target, toFixedPtAmt("500"));
      });
      it("should revert", async function () {
        expect(await depositTrancheA.balanceOf(deployerAddress)).to.eq("0");
        await expect(perp.deposit(depositTrancheA.target, toFixedPtAmt("500"))).to.revertedWith(
          "ERC20: transfer amount exceeds balance",
        );
      });
    });

    describe("when the supply cap is exceeded", function () {
      beforeEach(async function () {
        await perp.updateMaxSupply(toFixedPtAmt("499"));
      });

      it("should revert", async function () {
        await expect(perp.deposit(depositTrancheA.target, toFixedPtAmt("500"))).to.revertedWithCustomError(
          perp,
          "ExceededMaxSupply",
        );
      });
    });

    describe("when the supply cap is exceeded and existing supply > 0", function () {
      beforeEach(async function () {
        await perp.deposit(depositTrancheA.target, toFixedPtAmt("400"));
        await perp.updateMaxSupply(toFixedPtAmt("499"));
      });

      it("should revert", async function () {
        await expect(perp.deposit(depositTrancheA.target, toFixedPtAmt("100"))).to.revertedWithCustomError(
          perp,
          "ExceededMaxSupply",
        );
      });
    });

    describe("when the existing supply is zero", function () {
      beforeEach(async function () {
        await perp.updateMaxDepositTrancheValuePerc(toPercFixedPtAmt("0.5"));
      });
      it("should not revert", async function () {
        await expect(perp.deposit(depositTrancheA.target, toFixedPtAmt("100"))).to.revertedWithCustomError(
          perp,
          "ExceededMaxMintPerTranche",
        );
      });
    });

    describe("when the tranche mint limit has not exceeded and existing supply > 0", function () {
      beforeEach(async function () {
        await perp.deposit(depositTrancheA.target, toFixedPtAmt("250"));
        await advancePerpQueue(perp, 1200);
        await perp.updateTolerableTrancheMaturity(1, ethers.MaxUint256);
        await perp.updateMaxDepositTrancheValuePerc(toPercFixedPtAmt("0.5"));
      });

      it("should NOT revert", async function () {
        await mintCollteralToken(collateralToken, toFixedPtAmt("50"), deployer);
        await collateralToken.transfer(perp.target, toFixedPtAmt("10"));
        const newBond = await bondAt(await perp.getDepositBond.staticCall());
        await depositIntoBond(newBond, toFixedPtAmt("2000"), deployer);
        const tranches = await getTranches(newBond);
        const newTranche = tranches[0];
        await newTranche.approve(perp.target, toFixedPtAmt("500"));
        await perp.deposit(newTranche.target, toFixedPtAmt("200"));
        await expect(perp.deposit(newTranche.target, toFixedPtAmt("1"))).not.to.reverted;
      });
    });

    describe("when the tranche mint limit has exceeded and existing supply > 0", function () {
      beforeEach(async function () {
        await perp.deposit(depositTrancheA.target, toFixedPtAmt("250"));
        await advancePerpQueue(perp, 1200);
        await perp.updateTolerableTrancheMaturity(1, ethers.MaxUint256);
        await perp.updateMaxDepositTrancheValuePerc(toPercFixedPtAmt("0.5"));
      });

      it("should revert", async function () {
        await mintCollteralToken(collateralToken, toFixedPtAmt("50"), deployer);
        await collateralToken.transfer(perp.target, toFixedPtAmt("50"));
        const newBond = await bondAt(await perp.getDepositBond.staticCall());
        await depositIntoBond(newBond, toFixedPtAmt("2000"), deployer);
        const tranches = await getTranches(newBond);
        const newTranche = tranches[0];
        await newTranche.approve(perp.target, toFixedPtAmt("500"));
        await perp.deposit(newTranche.target, toFixedPtAmt("200"));
        await expect(perp.deposit(newTranche.target, toFixedPtAmt("1"))).to.reverted;
      });
    });

    describe("when the tranche mint limit is exceeded and existing supply > 0", function () {
      beforeEach(async function () {
        await perp.deposit(depositTrancheA.target, toFixedPtAmt("250"));
        await advancePerpQueue(perp, 1200);
        await perp.updateTolerableTrancheMaturity(1, ethers.MaxUint256);
        await perp.updateMaxDepositTrancheValuePerc(toPercFixedPtAmt("0.5"));
      });

      it("should revert", async function () {
        const newBond = await bondAt(await perp.getDepositBond.staticCall());
        await depositIntoBond(newBond, toFixedPtAmt("2000"), deployer);
        const tranches = await getTranches(newBond);
        const newTranche = tranches[0];
        await newTranche.approve(perp.target, toFixedPtAmt("500"));
        await perp.deposit(newTranche.target, toFixedPtAmt("250"));
        await expect(perp.deposit(newTranche.target, toFixedPtAmt("1"))).to.revertedWithCustomError(
          perp,
          "ExceededMaxMintPerTranche",
        );
      });
    });

    describe("when tranche amount is zero", function () {
      it("should return without minting", async function () {
        expect(await perp.deposit.staticCall(depositTrancheA.target, "0")).to.eq("0");
      });
    });

    describe("when depositing a junior", function () {
      it("should return without minting", async function () {
        await expect(perp.deposit(depositTrancheZ.target, toFixedPtAmt("500"))).to.revertedWithCustomError(
          perp,
          "UnexpectedAsset",
        );
      });
    });

    describe("when total supply is zero", function () {
      describe("when tranche price is 1", function () {
        it("should mint the correct amount", async function () {
          const r = await perp.computeMintAmt.staticCall(depositTrancheA.target, toFixedPtAmt("500"));
          expect(r).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when tranche price is 0.5", function () {
        beforeEach(async function () {
          await rebase(collateralToken, rebaseOracle, -0.75);
        });

        it("should mint the correct amount", async function () {
          const r = await perp.computeMintAmt.staticCall(depositTrancheA.target, toFixedPtAmt("500"));
          expect(r).to.eq(toFixedPtAmt("250"));
        });
      });
    });

    describe("when total supply > zero", function () {
      let newBond: Contract, newTranche: Contract;
      beforeEach(async function () {
        await perp.deposit(depositTrancheA.target, toFixedPtAmt("200"));

        await advancePerpQueue(perp, 1200);
        newBond = await bondAt(await perp.getDepositBond.staticCall());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newTranche = tranches[0];
        await newTranche.approve(perp.target, toFixedPtAmt("250"));
      });

      describe("when price is eql to avg reserve price", function () {
        it("should mint the correct amount", async function () {
          const r = await perp.computeMintAmt.staticCall(newTranche.target, toFixedPtAmt("250"));
          expect(r).to.eq(toFixedPtAmt("250"));
        });
      });

      describe("when price is < avg reserve price", function () {
        beforeEach(async function () {
          await mintCollteralToken(collateralToken, toFixedPtAmt("500"), deployer);
          await collateralToken.transfer(perp.target, toFixedPtAmt("200"));
        });

        it("should mint the correct amount", async function () {
          const r = await perp.computeMintAmt.staticCall(newTranche.target, toFixedPtAmt("250"));
          expect(r).to.eq(toFixedPtAmt("125"));
        });
      });

      describe("when price is > avg reserve price", function () {
        beforeEach(async function () {
          await rebase(collateralToken, rebaseOracle, -0.75);

          await advancePerpQueue(perp, 1200);
          newBond = await bondAt(await perp.getDepositBond.staticCall());
          await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
          const tranches = await getTranches(newBond);
          newTranche = tranches[0];
          await newTranche.approve(perp.target, toFixedPtAmt("250"));
        });

        it("should mint the correct amount", async function () {
          const r = await perp.computeMintAmt.staticCall(newTranche.target, toFixedPtAmt("250"));
          expect(r).to.eq(toFixedPtAmt("500"));
        });
      });
    });

    describe("on successful deposit", function () {
      it("should mint perp tokens", async function () {
        await expect(() => perp.deposit(depositTrancheA.target, toFixedPtAmt("500"))).to.changeTokenBalance(
          perp,
          deployer,
          toFixedPtAmt("500"),
        );
      });
      it("should NOT withhold any fee amount", async function () {
        await expect(() => perp.deposit(depositTrancheA.target, toFixedPtAmt("500"))).to.changeTokenBalance(
          perp,
          perp,
          "0",
        );
      });
      it("should transfer the tranches in", async function () {
        await expect(() => perp.deposit(depositTrancheA.target, toFixedPtAmt("500"))).to.changeTokenBalances(
          depositTrancheA,
          [deployer, perp],
          [toFixedPtAmt("-500"), toFixedPtAmt("500")],
        );
      });
      it("should return the mintAmt", async function () {
        const r = await perp.computeMintAmt.staticCall(depositTrancheA.target, toFixedPtAmt("500"));
        expect(r).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when the reserve has no tranches", function () {
      let tx: Transaction;
      beforeEach(async function () {
        expect(await perp.getDepositBond.staticCall()).to.eq(depositBond.target);

        await checkPerpComposition(perp, [collateralToken], ["0"]);
        expect(await perp.totalSupply()).to.eq(0);

        tx = perp.deposit(depositTrancheA.target, toFixedPtAmt("500"));
        await tx;
      });

      it("should NOT update the deposit bond", async function () {
        expect(await perp.getDepositBond.staticCall()).to.eq(depositBond.target);
      });

      it("should emit reserve synced", async function () {
        await expect(tx).to.emit(perp, "ReserveSynced").withArgs(depositTrancheA.target, toFixedPtAmt("500"));
      });
      it("should update the reserve", async function () {
        await checkPerpComposition(perp, [collateralToken, depositTrancheA], ["0", toFixedPtAmt("500")]);
      });
      it("should update the total supply", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when the reserve has tranches", function () {
      beforeEach(async function () {
        await perp.deposit(depositTrancheA.target, toFixedPtAmt("200"));

        expect(await perp.getDepositBond.staticCall()).to.eq(depositBond.target);
        await checkPerpComposition(perp, [collateralToken, depositTrancheA], ["0", toFixedPtAmt("200")]);

        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("200"));
      });

      describe("when inserting the an existing tranche", async function () {
        let tx: Transaction;
        beforeEach(async function () {
          tx = perp.deposit(depositTrancheA.target, toFixedPtAmt("300"));
          await tx;
        });

        it("should NOT update the deposit bond", async function () {
          expect(await perp.getDepositBond.staticCall()).to.eq(depositBond.target);
        });
        it("should emit reserve synced", async function () {
          await expect(tx).to.emit(perp, "ReserveSynced").withArgs(depositTrancheA.target, toFixedPtAmt("500"));
        });
        it("should update the reserve", async function () {
          await checkPerpComposition(perp, [collateralToken, depositTrancheA], ["0", toFixedPtAmt("500")]);
        });
        it("should update the total supply", async function () {
          expect(await perp.totalSupply()).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when inserting a new tranche", function () {
        let newBond: Contract, newTranche: Contract, tx: Transaction;
        beforeEach(async function () {
          await advancePerpQueue(perp, 1200);

          newBond = await bondAt(await perp.getDepositBond.staticCall());
          await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
          const tranches = await getTranches(newBond);
          newTranche = tranches[0];
          await checkPerpComposition(perp, [collateralToken, depositTrancheA], ["0", toFixedPtAmt("200")]);
          expect(await perp.totalSupply()).to.eq(toFixedPtAmt("200"));
          await newTranche.approve(perp.target, toFixedPtAmt("250"));
          tx = perp.deposit(newTranche.target, toFixedPtAmt("250"));
          await tx;
        });

        it("should update the deposit bond", async function () {
          expect(await perp.getDepositBond.staticCall()).to.eq(newBond.target);
        });
        it("should emit reserve synced", async function () {
          await expect(tx).to.emit(perp, "ReserveSynced").withArgs(newTranche.target, toFixedPtAmt("250"));
        });
        it("should update the reserve", async function () {
          await checkPerpComposition(
            perp,
            [collateralToken, depositTrancheA, newTranche],
            ["0", toFixedPtAmt("200"), toFixedPtAmt("250")],
          );
        });
        it("should update the total supply", async function () {
          expect(await perp.totalSupply()).to.eq(toFixedPtAmt("450"));
        });
      });
    });

    describe("when fee is set", function () {
      beforeEach(async function () {
        await feePolicy.clearMockMethod("computeDeviationRatio((uint256,uint256,uint256))");
        await feePolicy.mockCall(
          "computeDeviationRatio((uint256,uint256,uint256))",
          [[toFixedPtAmt("0"), toFixedPtAmt("0"), "500"]],
          [toPercFixedPtAmt("1")],
        );
        await feePolicy.mockCall(
          "computeDeviationRatio((uint256,uint256,uint256))",
          [[toFixedPtAmt("500"), toFixedPtAmt("0"), "500"]],
          [toPercFixedPtAmt("1")],
        );
        await feePolicy.mockMethod("computeFeePerc(uint256,uint256)", [toPercFixedPtAmt("0.01")]);
      });
      it("should mint perp tokens", async function () {
        await expect(() => perp.deposit(depositTrancheA.target, toFixedPtAmt("500"))).to.changeTokenBalance(
          perp,
          deployer,
          toFixedPtAmt("495"),
        );
      });
      it("should transfer the tranches in", async function () {
        await expect(() => perp.deposit(depositTrancheA.target, toFixedPtAmt("500"))).to.changeTokenBalances(
          depositTrancheA,
          [deployer, perp],
          [toFixedPtAmt("-500"), toFixedPtAmt("500")],
        );
      });
      it("should return the mintAmt", async function () {
        const r = await perp.computeMintAmt.staticCall(depositTrancheA.target, toFixedPtAmt("500"));
        expect(r).to.eq(toFixedPtAmt("495"));
      });

      it("should update the total supply", async function () {
        await perp.deposit(depositTrancheA.target, toFixedPtAmt("500"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("500"));
      });

      it("should mint fees to perp", async function () {
        await expect(() => perp.deposit(depositTrancheA.target, toFixedPtAmt("500"))).to.changeTokenBalances(
          perp,
          [perp],
          [toFixedPtAmt("5")],
        );
      });
    });

    describe("when fee is set and caller is the vault", function () {
      let mockVault: Contract;
      beforeEach(async function () {
        const MockVault = await ethers.getContractFactory("MockVault");
        mockVault = await MockVault.deploy();
        await perp.updateVault(mockVault.target);
        await depositTrancheA.approve(mockVault.target, toFixedPtAmt("500"));
        await feePolicy.mockMethod("computeFeePerc(uint256,uint256)", [toPercFixedPtAmt("11")]);
      });
      it("should mint perp tokens", async function () {
        await expect(() =>
          mockVault.mintPerps(perp.target, depositTrancheA.target, toFixedPtAmt("500")),
        ).to.changeTokenBalance(perp, deployer, toFixedPtAmt("500"));
      });
      it("should transfer the tranches in", async function () {
        await expect(() =>
          mockVault.mintPerps(perp.target, depositTrancheA.target, toFixedPtAmt("500")),
        ).to.changeTokenBalances(depositTrancheA, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
      });
      it("should return the mintAmt", async function () {
        const r = await mockVault.computePerpMintAmt.staticCall(
          perp.target,
          depositTrancheA.target,
          toFixedPtAmt("500"),
        );
        expect(r).to.eq(toFixedPtAmt("500"));
      });
    });
  });
});
