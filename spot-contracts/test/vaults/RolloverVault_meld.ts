import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer, constants, Transaction, BigNumber } from "ethers";
import { smock } from "@defi-wonderland/smock";

import {
  setupCollateralToken,
  mintCollteralToken,
  createBondWithFactory,
  setupBondFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toDiscountFixedPtAmt,
  toPriceFixedPtAmt,
  getDepositBond,
  advancePerpQueue,
  advancePerpQueueUpToBondMaturity,
  advancePerpQueueToBondMaturity,
  checkReserveComposition,
  checkVaultAssetComposition,
  timeToMaturity,
  getContractFactoryFromExternalArtifacts,
  rebase,
  TimeHelpers,
} from "../helpers";
use(smock.matchers);

let vault: Contract;
let perp: Contract;
let bondFactory: Contract;
let collateralToken: Contract;
let rebaseOracle: Contract;
let issuer: Contract;
let feeStrategy: Contract;
let pricingStrategy: Contract;
let discountStrategy: Contract;
let deployer: Signer;
let reserveTranches: Contract[][] = [];
let rolloverInBond: Contract;
let rolloverInTranches: Contract;
let currentBondIn: Contract;
let currentTranchesIn: Contract[];

describe("RolloverVault", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];

    bondFactory = await setupBondFactory();
    ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));
    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
    await issuer.init(4800, [200, 300, 500], 1200, 0);

    const FeeStrategy = await ethers.getContractFactory("BasicFeeStrategy");
    feeStrategy = await smock.fake(FeeStrategy);
    await feeStrategy.computeMintFees.returns(["0", "0"]);
    await feeStrategy.computeBurnFees.returns(["0", "0"]);
    await feeStrategy.computeRolloverFees.returns(["0", "0"]);

    const PricingStrategy = await ethers.getContractFactory("UnitPricingStrategy");
    pricingStrategy = await smock.fake(PricingStrategy);
    await pricingStrategy.decimals.returns(8);
    await pricingStrategy.computeMatureTranchePrice.returns(toPriceFixedPtAmt("1"));
    await pricingStrategy.computeTranchePrice.returns(toPriceFixedPtAmt("1"));

    const DiscountStrategy = await ethers.getContractFactory("TrancheClassDiscountStrategy");
    discountStrategy = await smock.fake(DiscountStrategy);
    await discountStrategy.decimals.returns(18);
    await discountStrategy.computeTrancheDiscount
      .whenCalledWith(collateralToken.address)
      .returns(toDiscountFixedPtAmt("1"));

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

    await feeStrategy.feeToken.returns(perp.address);

    await perp.updateTolerableTrancheMaturity(1200, 4800);
    await advancePerpQueueToBondMaturity(perp, await getDepositBond(perp));

    reserveTranches = [];
    for (let i = 0; i < 4; i++) {
      const bond = await getDepositBond(perp);
      const tranches = await getTranches(bond);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);

      await pricingStrategy.computeTranchePrice.whenCalledWith(tranches[0].address).returns(toPriceFixedPtAmt("1"));
      await discountStrategy.computeTrancheDiscount
        .whenCalledWith(tranches[0].address)
        .returns(toDiscountFixedPtAmt("1"));
      await tranches[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

      await pricingStrategy.computeTranchePrice.whenCalledWith(tranches[1].address).returns(toPriceFixedPtAmt("1"));
      await discountStrategy.computeTrancheDiscount
        .whenCalledWith(tranches[1].address)
        .returns(toDiscountFixedPtAmt("1"));
      await tranches[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(tranches[1].address, toFixedPtAmt("300"));

      reserveTranches.push(tranches[0]);
      reserveTranches.push(tranches[1]);
      await advancePerpQueue(perp, 1200);
    }

    await checkReserveComposition(
      perp,
      [collateralToken, ...reserveTranches.slice(-6)],
      [
        toFixedPtAmt("500"),
        toFixedPtAmt("200"),
        toFixedPtAmt("300"),
        toFixedPtAmt("200"),
        toFixedPtAmt("300"),
        toFixedPtAmt("200"),
        toFixedPtAmt("300"),
      ],
    );

    rolloverInBond = await bondAt(await perp.callStatic.getDepositBond());
    rolloverInTranches = await getTranches(rolloverInBond);
    await pricingStrategy.computeTranchePrice
      .whenCalledWith(rolloverInTranches[0].address)
      .returns(toPriceFixedPtAmt("1"));
    await discountStrategy.computeTrancheDiscount
      .whenCalledWith(rolloverInTranches[0].address)
      .returns(toDiscountFixedPtAmt("1"));
    await pricingStrategy.computeTranchePrice
      .whenCalledWith(rolloverInTranches[1].address)
      .returns(toPriceFixedPtAmt("1"));
    await discountStrategy.computeTrancheDiscount
      .whenCalledWith(rolloverInTranches[1].address)
      .returns(toDiscountFixedPtAmt("0"));
    await pricingStrategy.computeTranchePrice
      .whenCalledWith(rolloverInTranches[2].address)
      .returns(toPriceFixedPtAmt("1"));
    await discountStrategy.computeTrancheDiscount
      .whenCalledWith(rolloverInTranches[2].address)
      .returns(toDiscountFixedPtAmt("0"));

    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    vault = await upgrades.deployProxy(RolloverVault.connect(deployer));
    await collateralToken.approve(vault.address, toFixedPtAmt("1"));
    await vault.init("RolloverVault", "VSHARE", perp.address);
    await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("0"), toFixedPtAmt("0")]);
    expect(await vault.deployedCount()).to.eq(0);

    await advancePerpQueueToBondMaturity(perp, rolloverInBond);
    currentBondIn = await bondAt(await perp.callStatic.getDepositBond());
    currentTranchesIn = await getTranches(currentBondIn);

    await pricingStrategy.computeTranchePrice
      .whenCalledWith(currentTranchesIn[0].address)
      .returns(toPriceFixedPtAmt("1"));
    await discountStrategy.computeTrancheDiscount
      .whenCalledWith(currentTranchesIn[0].address)
      .returns(toDiscountFixedPtAmt("1"));

    await collateralToken.transfer(vault.address, toFixedPtAmt("1000"));
    await vault.deploy();

    await checkVaultAssetComposition(
      vault,
      [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
      [toFixedPtAmt("200"), toFixedPtAmt("300"), toFixedPtAmt("500"), toFixedPtAmt("0")],
    );
    expect(await vault.deployedCount()).to.eq(2);
    expect(await vault.deployedAt(0)).to.eq(currentTranchesIn[2].address);
    expect(await vault.deployedAt(1)).to.eq(currentTranchesIn[1].address);

    await depositIntoBond(currentBondIn, toFixedPtAmt("5000"), deployer);
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#meld()", function () {
    describe("when the bond has a different collateral token", function () {
      let newBond: Contract;
      beforeEach(async function () {
        const BondController = await getContractFactoryFromExternalArtifacts("BondController");
        const Tranche = await getContractFactoryFromExternalArtifacts("Tranche");

        newBond = await smock.fake(BondController);
        await newBond.collateralToken.returns(constants.AddressZero);
        await newBond.trancheCount.returns(2);

        const tranche0 = await smock.fake(Tranche);
        await tranche0.bond.returns(newBond.address);
        await newBond.tranches.whenCalledWith(0).returns([tranche0.address, 200]);

        const tranche1 = await smock.fake(Tranche);
        await tranche1.bond.returns(newBond.address);
        await newBond.tranches.whenCalledWith(1).returns([tranche1.address, 800]);
      });
      it("should be reverted", async function () {
        await expect(vault.meld(newBond.address, [toFixedPtAmt("20"), toFixedPtAmt("80")])).to.be.revertedWith(
          "InvalidBond",
        );
      });
    });

    describe("when the bond has no tranches", function () {
      let newBond: Contract;
      beforeEach(async function () {
        const BondController = await getContractFactoryFromExternalArtifacts("BondController");

        newBond = await smock.fake(BondController);
        await newBond.collateralToken.returns(collateralToken.address);
        await newBond.trancheCount.returns(0);
      });
      it("should be reverted", async function () {
        await expect(
          vault.meld(newBond.address, [toFixedPtAmt("20"), toFixedPtAmt("30"), toFixedPtAmt("50")]),
        ).to.be.revertedWith("InvalidBond");
      });
    });

    describe("when the bond is mature", function () {
      let newBond: Contract;
      beforeEach(async function () {
        const BondController = await getContractFactoryFromExternalArtifacts("BondController");
        const Tranche = await getContractFactoryFromExternalArtifacts("Tranche");

        newBond = await smock.fake(BondController);
        await newBond.collateralToken.returns(collateralToken.address);
        await newBond.trancheCount.returns(2);
        await newBond.isMature.returns(true);

        const tranche0 = await smock.fake(Tranche);
        await tranche0.bond.returns(newBond.address);
        await newBond.tranches.whenCalledWith(0).returns([tranche0.address, 200]);

        const tranche1 = await smock.fake(Tranche);
        await tranche1.bond.returns(newBond.address);
        await newBond.tranches.whenCalledWith(1).returns([tranche1.address, 800]);
      });
      it("should be reverted", async function () {
        await expect(vault.meld(newBond.address, [toFixedPtAmt("20"), toFixedPtAmt("80")])).to.be.revertedWith(
          "InvalidBond",
        );
      });
    });

    describe("when the bond is not part of the deployed set", function () {
      let newBond: Contract;
      beforeEach(async function () {
        newBond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 4800);
        await depositIntoBond(newBond, toFixedPtAmt("100"), deployer);
        const tranches = await getTranches(newBond);
        for (let i = 0; i < tranches.length; i++) {
          tranches[i].approve(vault.address, toFixedPtAmt("100"));
        }
      });
      it("should be reverted", async function () {
        await expect(
          vault.meld(newBond.address, [toFixedPtAmt("20"), toFixedPtAmt("30"), toFixedPtAmt("50")]),
        ).to.be.revertedWith("InvalidBond");
      });
    });

    describe("when the user sends no tokens", function () {
      it("should be reverted", async function () {
        await expect(vault.meld(currentBondIn.address, ["0", "0", "0"])).to.be.revertedWith("ValuelessAssets");
      });
    });

    describe("when the user has insufficient approvals", function () {
      beforeEach(async function () {
        currentTranchesIn[0].approve(vault.address, toFixedPtAmt("10"));
      });
      it("should be reverted", async function () {
        await expect(
          vault.meld(currentBondIn.address, [toFixedPtAmt("10"), toFixedPtAmt("20"), toFixedPtAmt("0")]),
        ).to.be.revertedWith("ERC20: transfer amount exceeds allowance");
      });
    });

    describe("when the user has insufficient balance", function () {
      beforeEach(async function () {
        currentTranchesIn[0].transfer(vault.address, toFixedPtAmt("995"));
        currentTranchesIn[0].approve(vault.address, toFixedPtAmt("10"));
      });
      it("should be reverted", async function () {
        await expect(vault.meld(currentBondIn.address, [toFixedPtAmt("10"), "0", "0"])).to.be.revertedWith(
          "ERC20: transfer amount exceeds balance",
        );
      });
    });

    describe("when the user sends too few tokens", function () {
      beforeEach(async function () {
        currentTranchesIn[0].approve(vault.address, toFixedPtAmt("1"));
      });
      it("should be reverted", async function () {
        await expect(vault.meld(currentBondIn.address, ["1", "0", "0"])).to.be.revertedWith("Invalid redemption ratio");
      });
    });

    describe("when the user sends too few tokens", function () {
      beforeEach(async function () {
        currentTranchesIn[0].approve(vault.address, toFixedPtAmt("1"));
      });
      it("should be reverted", async function () {
        await expect(vault.meld(currentBondIn.address, ["1", "0", "0"])).to.be.revertedWith("Invalid redemption ratio");
      });
    });

    describe("when fee is zero", async function () {
      beforeEach(async function () {
        await advancePerpQueueUpToBondMaturity(perp, currentBondIn);
      });

      describe("when the user sends only A tranches", function () {
        let txFn: () => Promise<Transaction>;
        beforeEach(async function () {
          currentTranchesIn[0].approve(vault.address, toFixedPtAmt("10"));
          txFn = () => vault.meld(currentBondIn.address, [toFixedPtAmt("10"), "0", "0"]);
        });
        it("should redeem A tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[0],
            [deployer, vault],
            [toFixedPtAmt("-10"), toFixedPtAmt("0")],
          );
        });
        it("should redeem B tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[1],
            [deployer, vault],
            [toFixedPtAmt("0"), toFixedPtAmt("-15")],
          );
        });
        it("should redeem Z tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[2],
            [deployer, vault],
            [toFixedPtAmt("0"), toFixedPtAmt("-25")],
          );
        });
        it("should recover underlying", async function () {
          await expect(txFn).to.changeTokenBalances(
            collateralToken,
            [deployer, vault],
            [toFixedPtAmt("10"), toFixedPtAmt("40")],
          );
        });
        it("should update vault balances", async function () {
          await txFn();
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("240"), toFixedPtAmt("285"), toFixedPtAmt("475"), toFixedPtAmt("0")],
          );
        });
        it("should sync balances", async function () {
          const tx: Transaction = await txFn();
          await tx.wait();
          await expect(tx)
            .to.emit(vault, "AssetSynced")
            .withArgs(collateralToken.address, toFixedPtAmt("240"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[1].address, toFixedPtAmt("285"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[2].address, toFixedPtAmt("475"));
        });
      });

      describe("when the user sends A, B tranches", function () {
        let txFn: () => Promise<Transaction>;
        beforeEach(async function () {
          currentTranchesIn[0].approve(vault.address, toFixedPtAmt("10"));
          currentTranchesIn[1].approve(vault.address, toFixedPtAmt("15"));
          txFn = () => vault.meld(currentBondIn.address, [toFixedPtAmt("10"), toFixedPtAmt("15"), "0"]);
        });
        it("should redeem A tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[0],
            [deployer, vault],
            [toFixedPtAmt("-10"), toFixedPtAmt("0")],
          );
        });
        it("should redeem B tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[1],
            [deployer, vault],
            [toFixedPtAmt("-15"), toFixedPtAmt("0")],
          );
        });
        it("should redeem Z tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[2],
            [deployer, vault],
            [toFixedPtAmt("0"), toFixedPtAmt("-25")],
          );
        });
        it("should recover underlying", async function () {
          await expect(txFn).to.changeTokenBalances(
            collateralToken,
            [deployer, vault],
            [toFixedPtAmt("25"), toFixedPtAmt("25")],
          );
        });
        it("should update vault balances", async function () {
          await txFn();
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("225"), toFixedPtAmt("300"), toFixedPtAmt("475"), toFixedPtAmt("0")],
          );
        });
        it("should sync balances", async function () {
          const tx: Transaction = await txFn();
          await tx.wait();
          await expect(tx)
            .to.emit(vault, "AssetSynced")
            .withArgs(collateralToken.address, toFixedPtAmt("225"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[1].address, toFixedPtAmt("300"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[2].address, toFixedPtAmt("475"));
        });
      });

      describe("when the user sends A, Z tranches", function () {
        let txFn: () => Promise<Transaction>;
        beforeEach(async function () {
          currentTranchesIn[0].approve(vault.address, toFixedPtAmt("10"));
          currentTranchesIn[2].approve(vault.address, toFixedPtAmt("25"));
          txFn = () => vault.meld(currentBondIn.address, [toFixedPtAmt("10"), "0", toFixedPtAmt("25")]);
        });
        it("should redeem A tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[0],
            [deployer, vault],
            [toFixedPtAmt("-10"), toFixedPtAmt("0")],
          );
        });
        it("should redeem B tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[1],
            [deployer, vault],
            [toFixedPtAmt("0"), toFixedPtAmt("-15")],
          );
        });
        it("should redeem Z tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[2],
            [deployer, vault],
            [toFixedPtAmt("-25"), toFixedPtAmt("0")],
          );
        });
        it("should recover underlying", async function () {
          await expect(txFn).to.changeTokenBalances(
            collateralToken,
            [deployer, vault],
            [toFixedPtAmt("35"), toFixedPtAmt("15")],
          );
        });
        it("should update vault balances", async function () {
          await txFn();
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("215"), toFixedPtAmt("285"), toFixedPtAmt("500"), toFixedPtAmt("0")],
          );
        });
        it("should sync balances", async function () {
          const tx: Transaction = await txFn();
          await tx.wait();
          await expect(tx)
            .to.emit(vault, "AssetSynced")
            .withArgs(collateralToken.address, toFixedPtAmt("215"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[1].address, toFixedPtAmt("285"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[2].address, toFixedPtAmt("500"));
        });
      });

      describe("when the user sends A, B, Z tranches", function () {
        let txFn: () => Promise<Transaction>;
        beforeEach(async function () {
          currentTranchesIn[0].approve(vault.address, toFixedPtAmt("10"));
          currentTranchesIn[1].approve(vault.address, toFixedPtAmt("15"));
          currentTranchesIn[2].approve(vault.address, toFixedPtAmt("5"));
          txFn = () => vault.meld(currentBondIn.address, [toFixedPtAmt("10"), toFixedPtAmt("15"), toFixedPtAmt("5")]);
        });
        it("should redeem A tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[0],
            [deployer, vault],
            [toFixedPtAmt("-10"), toFixedPtAmt("0")],
          );
        });
        it("should redeem B tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[1],
            [deployer, vault],
            [toFixedPtAmt("-15"), toFixedPtAmt("0")],
          );
        });
        it("should redeem Z tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[2],
            [deployer, vault],
            [toFixedPtAmt("-5"), toFixedPtAmt("-20")],
          );
        });
        it("should recover underlying", async function () {
          await expect(txFn).to.changeTokenBalances(
            collateralToken,
            [deployer, vault],
            [toFixedPtAmt("30"), toFixedPtAmt("20")],
          );
        });
        it("should update vault balances", async function () {
          await txFn();
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("220"), toFixedPtAmt("300"), toFixedPtAmt("480"), toFixedPtAmt("0")],
          );
        });
        it("should sync balances", async function () {
          const tx: Transaction = await txFn();
          await tx.wait();
          await expect(tx)
            .to.emit(vault, "AssetSynced")
            .withArgs(collateralToken.address, toFixedPtAmt("220"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[1].address, toFixedPtAmt("300"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[2].address, toFixedPtAmt("480"));
        });
      });

      describe("when the user sends more tokens than required (only uses whats required)", function () {
        let txFn: () => Promise<Transaction>;
        beforeEach(async function () {
          currentTranchesIn[0].approve(vault.address, toFixedPtAmt("1000"));
          currentTranchesIn[1].approve(vault.address, toFixedPtAmt("15"));
          txFn = () => vault.meld(currentBondIn.address, [toFixedPtAmt("1000"), toFixedPtAmt("15"), toFixedPtAmt("0")]);
        });
        it("should redeem A tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[0],
            [deployer, vault],
            [toFixedPtAmt("-200"), toFixedPtAmt("0")],
          );
        });
        it("should redeem B tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[1],
            [deployer, vault],
            [toFixedPtAmt("-15"), toFixedPtAmt("-285")],
          );
        });
        it("should redeem Z tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[2],
            [deployer, vault],
            [toFixedPtAmt("0"), toFixedPtAmt("-500")],
          );
        });
        it("should recover underlying", async function () {
          await expect(txFn).to.changeTokenBalances(
            collateralToken,
            [deployer, vault],
            [toFixedPtAmt("215"), toFixedPtAmt("785")],
          );
        });
        it("should update vault balances", async function () {
          await txFn();
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], perp],
            [toFixedPtAmt("985"), toFixedPtAmt("15"), toFixedPtAmt("0")],
          );
        });
        it("should sync balances", async function () {
          const tx: Transaction = await txFn();
          await tx.wait();
          await expect(tx)
            .to.emit(vault, "AssetSynced")
            .withArgs(collateralToken.address, toFixedPtAmt("985"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[1].address, toFixedPtAmt("15"));
        });
      });

      describe("when the bond is over-collateralized (redemption based on value)", function () {
        let txFn: () => Promise<Transaction>;
        beforeEach(async function () {
          await rebase(collateralToken, rebaseOracle, +1);
          currentTranchesIn[0].approve(vault.address, toFixedPtAmt("10"));
          currentTranchesIn[2].approve(vault.address, toFixedPtAmt("5"));
          txFn = () => vault.meld(currentBondIn.address, [toFixedPtAmt("10"), "0", toFixedPtAmt("5")]);
        });
        it("should redeem A tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[0],
            [deployer, vault],
            [toFixedPtAmt("-10"), toFixedPtAmt("0")],
          );
        });
        it("should redeem B tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[1],
            [deployer, vault],
            [toFixedPtAmt("0"), toFixedPtAmt("-15")],
          );
        });
        it("should redeem Z tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[2],
            [deployer, vault],
            [toFixedPtAmt("-5"), toFixedPtAmt("-20")],
          );
        });
        it("should recover underlying", async function () {
          await expect(txFn).to.changeTokenBalances(
            collateralToken,
            [deployer, vault],
            [toFixedPtAmt("25"), toFixedPtAmt("75")],
          );
        });
        it("should update vault balances", async function () {
          await txFn();
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("475"), toFixedPtAmt("285"), toFixedPtAmt("480"), toFixedPtAmt("0")],
          );
        });
        it("should sync balances", async function () {
          const tx: Transaction = await txFn();
          await tx.wait();
          await expect(tx)
            .to.emit(vault, "AssetSynced")
            .withArgs(collateralToken.address, toFixedPtAmt("475"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[1].address, toFixedPtAmt("285"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[2].address, toFixedPtAmt("480"));
        });
      });

      describe("when the bond is under-collateralized (redemption based on value)", function () {
        let txFn: () => Promise<Transaction>;
        beforeEach(async function () {
          await rebase(collateralToken, rebaseOracle, -0.1);
          currentTranchesIn[0].approve(vault.address, toFixedPtAmt("10"));
          currentTranchesIn[2].approve(vault.address, toFixedPtAmt("5"));
          txFn = () => vault.meld(currentBondIn.address, [toFixedPtAmt("10"), "0", toFixedPtAmt("5")]);
        });
        it("should redeem A tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[0],
            [deployer, vault],
            [toFixedPtAmt("-10"), toFixedPtAmt("0")],
          );
        });
        it("should redeem B tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[1],
            [deployer, vault],
            [toFixedPtAmt("0"), toFixedPtAmt("-15")],
          );
        });
        it("should redeem Z tranches", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[2],
            [deployer, vault],
            [toFixedPtAmt("-5"), toFixedPtAmt("-20")],
          );
        });
        it("should recover underlying", async function () {
          await expect(txFn).to.changeTokenBalances(
            collateralToken,
            [deployer, vault],
            [toFixedPtAmt("14"), toFixedPtAmt("31")],
          );
        });
        it("should update vault balances", async function () {
          await txFn();
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("211"), toFixedPtAmt("285"), toFixedPtAmt("480"), toFixedPtAmt("0")],
          );
        });
        it("should sync balances", async function () {
          const tx: Transaction = await txFn();
          await tx.wait();
          await expect(tx)
            .to.emit(vault, "AssetSynced")
            .withArgs(collateralToken.address, toFixedPtAmt("211"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[1].address, toFixedPtAmt("285"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[2].address, toFixedPtAmt("480"));
        });
      });
    });

    describe("with a fee", async function () {
      let txFn: () => Promise<Transaction>, underlyingReturned: BigNumber;
      beforeEach(async function () {
        await TimeHelpers.increaseTime(parseInt((await timeToMaturity(currentBondIn)) / 2));
        currentTranchesIn[0].approve(vault.address, toFixedPtAmt("10"));
        underlyingReturned = await vault.callStatic.meld(currentBondIn.address, [
          toFixedPtAmt("10"),
          toFixedPtAmt("0"),
          "0",
        ]);
        txFn = () => vault.meld(currentBondIn.address, [toFixedPtAmt("10"), toFixedPtAmt("0"), "0"]);
      });
      it("should redeem A tranches", async function () {
        await expect(txFn).to.changeTokenBalances(
          currentTranchesIn[0],
          [deployer, vault],
          [toFixedPtAmt("-10"), toFixedPtAmt("0")],
        );
      });
      it("should redeem B tranches", async function () {
        await expect(txFn).to.changeTokenBalances(
          currentTranchesIn[1],
          [deployer, vault],
          [toFixedPtAmt("0"), toFixedPtAmt("-15")],
        );
      });
      it("should redeem Z tranches", async function () {
        await expect(txFn).to.changeTokenBalances(
          currentTranchesIn[2],
          [deployer, vault],
          [toFixedPtAmt("0"), toFixedPtAmt("-25")],
        );
      });
      it("should deduct fee", async function () {
        expect(underlyingReturned).to.gte(toFixedPtAmt("9.750")).lt(toFixedPtAmt("9.751"));
      });
      it("should recover underlying", async function () {
        const _deployerBal = await collateralToken.balanceOf(await deployer.getAddress());
        const _vaultBal = await collateralToken.balanceOf(vault.address);
        await txFn();
        const deployerBal = await collateralToken.balanceOf(await deployer.getAddress());
        const vaultBal = await collateralToken.balanceOf(vault.address);

        expect(deployerBal.sub(_deployerBal)).to.gte(toFixedPtAmt("9.750")).lt(toFixedPtAmt("9.751"));
        expect(vaultBal.sub(_vaultBal)).to.gte(toFixedPtAmt("40.249")).lt(toFixedPtAmt("40.250"));
      });
      it("should update vault balances", async function () {
        const _deployerBal = await collateralToken.balanceOf(await deployer.getAddress());
        await txFn();
        const deployerBal = await collateralToken.balanceOf(await deployer.getAddress());
        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
          [
            toFixedPtAmt("250").sub(deployerBal).add(_deployerBal),
            toFixedPtAmt("285"),
            toFixedPtAmt("475"),
            toFixedPtAmt("0"),
          ],
        );
      });
      it("should sync balances", async function () {
        const _deployerBal = await collateralToken.balanceOf(await deployer.getAddress());
        const tx: Transaction = await txFn();
        await tx.wait();
        const deployerBal = await collateralToken.balanceOf(await deployer.getAddress());
        await expect(tx)
          .to.emit(vault, "AssetSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("250").sub(deployerBal).add(_deployerBal))
          .to.emit(vault, "AssetSynced")
          .withArgs(currentTranchesIn[1].address, toFixedPtAmt("285"))
          .to.emit(vault, "AssetSynced")
          .withArgs(currentTranchesIn[2].address, toFixedPtAmt("475"));
      });
    });
  });
});
