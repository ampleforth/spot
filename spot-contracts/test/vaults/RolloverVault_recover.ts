import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";
import { smock } from "@defi-wonderland/smock";

import {
  setupCollateralToken,
  mintCollteralToken,
  setupBondFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toDiscountFixedPtAmt,
  toPriceFixedPtAmt,
  getDepositBond,
  advancePerpQueue,
  advancePerpQueueToBondMaturity,
  advancePerpQueueToRollover,
  checkReserveComposition,
  checkVaultAssetComposition,
} from "../helpers";
use(smock.matchers);

let vault: Contract;
let perp: Contract;
let bondFactory: Contract;
let collateralToken: Contract;
let issuer: Contract;
let feeStrategy: Contract;
let pricingStrategy: Contract;
let discountStrategy: Contract;
let deployer: Signer;
let reserveTranches: Contract[][] = [];
let rolloverInBond: Contract;
let rolloverInTranches: Contract;

describe("RolloverVault", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];

    bondFactory = await setupBondFactory();
    ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));
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
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#recover", function () {
    describe("when no asset is deployed", function () {
      it("should be a no-op", async function () {
        await expect(vault.recover()).not.to.be.reverted;
        expect(await vault.deployedCount()).to.eq(0);
      });
    });

    describe("when one asset deployed", function () {
      let currentBondIn: Contract, currentTranchesIn: Contract[];
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, rolloverInBond);
        currentBondIn = await bondAt(await perp.callStatic.getDepositBond());
        currentTranchesIn = await getTranches(currentBondIn);

        await pricingStrategy.computeTranchePrice
          .whenCalledWith(currentTranchesIn[0].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(currentTranchesIn[0].address)
          .returns(toDiscountFixedPtAmt("1"));

        await pricingStrategy.computeTranchePrice
          .whenCalledWith(currentTranchesIn[1].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(currentTranchesIn[1].address)
          .returns(toDiscountFixedPtAmt("1"));

        await collateralToken.transfer(vault.address, toFixedPtAmt("10"));

        await vault.deploy();
        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[2], perp],
          [toFixedPtAmt("5"), toFixedPtAmt("5"), toFixedPtAmt("0")],
        );
        expect(await vault.deployedCount()).to.eq(1);
        expect(await vault.deployedAt(0)).to.eq(currentTranchesIn[2].address);
      });
      describe("when its not mature", function () {
        it("should be a no-op", async function () {
          await expect(vault.recover()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[2], perp],
            [toFixedPtAmt("5"), toFixedPtAmt("5"), toFixedPtAmt("0")],
          );
          expect(await vault.deployedCount()).to.eq(1);
          expect(await vault.deployedAt(0)).to.eq(currentTranchesIn[2].address);
        });
      });
      describe("when its mature", function () {
        beforeEach(async function () {
          await advancePerpQueueToBondMaturity(perp, currentBondIn);
        });
        it("should recover", async function () {
          await expect(vault.recover()).not.to.be.reverted;
          expect(await vault.deployedCount()).to.eq(0);
          await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("10"), toFixedPtAmt("0")]);
        });
        it("should sync assets", async function () {
          const tx = vault.recover();
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("10"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[2].address, toFixedPtAmt("0"));
        });
      });
    });

    describe("when many assets are deployed", function () {
      let currentBondIn: Contract, currentTranchesIn: Contract[], newBondIn: Contract, newTranchesIn: Contract[];
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, rolloverInBond);
        currentBondIn = await bondAt(await perp.callStatic.getDepositBond());
        currentTranchesIn = await getTranches(currentBondIn);

        await pricingStrategy.computeTranchePrice
          .whenCalledWith(currentTranchesIn[0].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(currentTranchesIn[0].address)
          .returns(toDiscountFixedPtAmt("1"));

        await collateralToken.transfer(vault.address, toFixedPtAmt("10"));
        await vault.deploy();

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
          [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
        );
        expect(await vault.deployedCount()).to.eq(2);
        expect(await vault.deployedAt(0)).to.eq(currentTranchesIn[2].address);
        expect(await vault.deployedAt(1)).to.eq(currentTranchesIn[1].address);
      });

      describe("when no redemption", function () {
        it("should be a no-op", async function () {
          await expect(vault.recover()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
          );
          expect(await vault.deployedCount()).to.eq(2);
          expect(await vault.deployedAt(0)).to.eq(currentTranchesIn[2].address);
          expect(await vault.deployedAt(1)).to.eq(currentTranchesIn[1].address);
        });
      });

      describe("when mature redemption", function () {
        beforeEach(async function () {
          await advancePerpQueueToBondMaturity(perp, currentBondIn);
        });
        it("should recover", async function () {
          await expect(vault.recover()).not.to.be.reverted;
          expect(await vault.deployedCount()).to.eq(0);
          await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("10"), toFixedPtAmt("0")]);
        });
        it("should sync assets", async function () {
          const tx = vault.recover();
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("10"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, toFixedPtAmt("0"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[2].address, toFixedPtAmt("0"));
        });
      });

      describe("when immature redemption", function () {
        beforeEach(async function () {
          await advancePerpQueueToRollover(perp, currentBondIn);

          newBondIn = await bondAt(await perp.callStatic.getDepositBond());
          newTranchesIn = await getTranches(newBondIn);

          await pricingStrategy.computeTranchePrice
            .whenCalledWith(newTranchesIn[0].address)
            .returns(toPriceFixedPtAmt("1"));
          await discountStrategy.computeTrancheDiscount
            .whenCalledWith(newTranchesIn[0].address)
            .returns(toDiscountFixedPtAmt("1"));

          await collateralToken.transfer(vault.address, toFixedPtAmt("9998"));
          await vault.deploy();

          expect(await vault.deployedCount()).to.eq(5);
          await checkVaultAssetComposition(
            vault,
            [
              collateralToken,
              currentTranchesIn[0],
              currentTranchesIn[1],
              currentTranchesIn[2],
              newTranchesIn[1],
              newTranchesIn[2],
              perp,
            ],
            [
              toFixedPtAmt("1998"),
              toFixedPtAmt("2"),
              toFixedPtAmt("3"),
              toFixedPtAmt("5"),
              toFixedPtAmt("3000"),
              toFixedPtAmt("5000"),
              toFixedPtAmt("0"),
            ],
          );
        });

        describe("without reminder", function () {
          it("should recover", async function () {
            await expect(vault.recover()).not.to.be.reverted;
            expect(await vault.deployedCount()).to.eq(2);
            await checkVaultAssetComposition(
              vault,
              [collateralToken, newTranchesIn[1], newTranchesIn[2], perp],
              [toFixedPtAmt("2008"), toFixedPtAmt("3000"), toFixedPtAmt("5000"), toFixedPtAmt("0")],
            );
          });
          it("should sync assets", async function () {
            const tx = vault.recover();
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("2008"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[0].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[2].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].address, toFixedPtAmt("3000"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[2].address, toFixedPtAmt("5000"));
          });
        });

        describe("with reminder", function () {
          beforeEach(async function () {
            await depositIntoBond(currentBondIn, toFixedPtAmt("1000"), deployer);
            await currentTranchesIn[2].transfer(vault.address, toFixedPtAmt("1"));
            expect(await vault.deployedCount()).to.eq(5);
            await checkVaultAssetComposition(
              vault,
              [
                collateralToken,
                currentTranchesIn[0],
                currentTranchesIn[1],
                currentTranchesIn[2],
                newTranchesIn[1],
                newTranchesIn[2],
                perp,
              ],
              [
                toFixedPtAmt("1998"),
                toFixedPtAmt("2"),
                toFixedPtAmt("3"),
                toFixedPtAmt("6"),
                toFixedPtAmt("3000"),
                toFixedPtAmt("5000"),
                toFixedPtAmt("0"),
              ],
            );
          });
          it("should recover", async function () {
            await expect(vault.recover()).not.to.be.reverted;
            expect(await vault.deployedCount()).to.eq(3);
            await checkVaultAssetComposition(
              vault,
              [collateralToken, currentTranchesIn[2], newTranchesIn[1], newTranchesIn[2], perp],
              [toFixedPtAmt("2008"), toFixedPtAmt("1"), toFixedPtAmt("3000"), toFixedPtAmt("5000"), toFixedPtAmt("0")],
            );
          });
          it("should sync assets", async function () {
            const tx = vault.recover();
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("2008"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[0].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[2].address, toFixedPtAmt("1"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].address, toFixedPtAmt("3000"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[2].address, toFixedPtAmt("5000"));
          });
        });
      });
    });
  });

  describe("#recoverAndRedeploy", function () {
    let currentBondIn: Contract, currentTranchesIn: Contract[], newBondIn: Contract, newTranchesIn: Contract[];
    beforeEach(async function () {
      await advancePerpQueueToBondMaturity(perp, rolloverInBond);
      currentBondIn = await bondAt(await perp.callStatic.getDepositBond());
      currentTranchesIn = await getTranches(currentBondIn);

      await pricingStrategy.computeTranchePrice
        .whenCalledWith(currentTranchesIn[0].address)
        .returns(toPriceFixedPtAmt("1"));
      await discountStrategy.computeTrancheDiscount
        .whenCalledWith(currentTranchesIn[0].address)
        .returns(toDiscountFixedPtAmt("1"));

      await collateralToken.transfer(vault.address, toFixedPtAmt("10"));
      await vault.deploy();

      await checkVaultAssetComposition(
        vault,
        [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
        [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
      );
      expect(await vault.deployedCount()).to.eq(2);
      expect(await vault.deployedAt(0)).to.eq(currentTranchesIn[2].address);
      expect(await vault.deployedAt(1)).to.eq(currentTranchesIn[1].address);

      await advancePerpQueueToBondMaturity(perp, currentBondIn);

      newBondIn = await bondAt(await perp.callStatic.getDepositBond());
      newTranchesIn = await getTranches(newBondIn);

      await pricingStrategy.computeTranchePrice
        .whenCalledWith(newTranchesIn[0].address)
        .returns(toPriceFixedPtAmt("1"));
      await discountStrategy.computeTrancheDiscount
        .whenCalledWith(newTranchesIn[0].address)
        .returns(toDiscountFixedPtAmt("1"));
    });

    it("should recover", async function () {
      await expect(vault.recoverAndRedeploy()).not.to.be.reverted;
      expect(await vault.deployedCount()).to.eq(2);
      await checkVaultAssetComposition(
        vault,
        [collateralToken, newTranchesIn[1], newTranchesIn[2], perp],
        [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
      );
    });

    it("should sync assets", async function () {
      const tx = vault.recoverAndRedeploy();
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("10"));
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, toFixedPtAmt("0"));
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[2].address, toFixedPtAmt("0"));
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[0].address, toFixedPtAmt("2"));
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].address, toFixedPtAmt("3"));
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[2].address, toFixedPtAmt("5"));
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[0].address, toFixedPtAmt("0"));
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("2"));
    });
  });
});
