import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer, Transaction } from "ethers";
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

  describe("#deploy", function () {
    describe("when usable balance is zero", function () {
      it("should revert", async function () {
        await expect(vault.deploy()).to.be.revertedWithCustomError(vault, "InsufficientDeployment");
      });
    });

    describe("when usable balance is lower than the min deployment", function () {
      beforeEach(async function () {
        await collateralToken.transfer(vault.address, toFixedPtAmt("999"));
        await vault.updateMinDeploymentAmt(toFixedPtAmt("1000"));
      });
      it("should revert", async function () {
        await expect(vault.deploy()).to.be.revertedWithCustomError(vault, "InsufficientDeployment");
      });
    });

    describe("when usable balance is higher than the min deployment", function () {
      beforeEach(async function () {
        await collateralToken.transfer(vault.address, toFixedPtAmt("1000"));
        await vault.updateMinDeploymentAmt(toFixedPtAmt("100"));
      });
      it("should not revert", async function () {
        await expect(vault.deploy()).not.to.be.reverted;
      });
    });

    describe("when no trancheIn", function () {
      beforeEach(async function () {
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(rolloverInTranches[0].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(rolloverInTranches[0].address)
          .returns(toDiscountFixedPtAmt("0"));
        await collateralToken.transfer(vault.address, toFixedPtAmt("10"));
      });
      it("should revert", async function () {
        await expect(vault.deploy()).to.be.revertedWithCustomError(vault, "InsufficientDeployment");
      });
    });

    describe("when one trancheIn one tokenOut (mature tranche)", function () {
      let newTranchesIn;
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, rolloverInBond);
        const newBondIn = await bondAt(await perp.callStatic.getDepositBond());
        newTranchesIn = await getTranches(newBondIn);
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(newTranchesIn[0].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(newTranchesIn[0].address)
          .returns(toDiscountFixedPtAmt("1"));
        await checkReserveComposition(perp, [collateralToken], [toFixedPtAmt("2000")]);
      });

      describe("when balance covers just 1 token", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("10"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, newTranchesIn[1], newTranchesIn[2], perp],
            [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, newTranchesIn[0]],
            [toFixedPtAmt("1998"), toFixedPtAmt("2")],
          );
        });
      });

      describe("when balance covers just 1 token exactly", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("10000"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, newTranchesIn[1], newTranchesIn[2], perp],
            [toFixedPtAmt("2000"), toFixedPtAmt("3000"), toFixedPtAmt("5000"), toFixedPtAmt("0")],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, newTranchesIn[0]],
            [toFixedPtAmt("0"), toFixedPtAmt("2000")],
          );
        });
      });
    });

    describe("when many trancheIn one tokenOut (mature tranche)", function () {
      let newTranchesIn;
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, rolloverInBond);
        const newBondIn = await bondAt(await perp.callStatic.getDepositBond());
        newTranchesIn = await getTranches(newBondIn);
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(newTranchesIn[0].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(newTranchesIn[0].address)
          .returns(toDiscountFixedPtAmt("1"));
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(newTranchesIn[1].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(newTranchesIn[1].address)
          .returns(toDiscountFixedPtAmt("1"));
        await checkReserveComposition(perp, [collateralToken], [toFixedPtAmt("2000")]);
      });

      describe("when balance covers just 1 token", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("10"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, newTranchesIn[2], perp],
            [toFixedPtAmt("5"), toFixedPtAmt("5"), toFixedPtAmt("0")],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, newTranchesIn[0], newTranchesIn[1]],
            [toFixedPtAmt("1995"), toFixedPtAmt("2"), toFixedPtAmt("3")],
          );
        });
      });

      describe("when balance covers just 1 token exactly", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("4000"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, newTranchesIn[2], perp],
            [toFixedPtAmt("2000"), toFixedPtAmt("2000"), toFixedPtAmt("0")],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, newTranchesIn[0], newTranchesIn[1]],
            [toFixedPtAmt("0"), toFixedPtAmt("800"), toFixedPtAmt("1200")],
          );
        });
      });
    });

    describe("when one trancheIn one tokenOut (near mature tranche)", function () {
      let curTranchesIn, newTranchesIn;
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, await bondAt(reserveTranches[4].bond()));
        const curBondIn = await bondAt(await perp.callStatic.getDepositBond());
        curTranchesIn = await getTranches(curBondIn);
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(curTranchesIn[0].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(curTranchesIn[0].address)
          .returns(toDiscountFixedPtAmt("1"));

        await collateralToken.transfer(vault.address, toFixedPtAmt("10000"));
        await vault.deploy();

        await advancePerpQueueToRollover(perp, curBondIn);
        const newBondIn = await bondAt(await perp.callStatic.getDepositBond());

        newTranchesIn = await getTranches(newBondIn);
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(newTranchesIn[0].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(newTranchesIn[0].address)
          .returns(toDiscountFixedPtAmt("1"));

        await checkVaultAssetComposition(
          vault,
          [collateralToken, reserveTranches[6], reserveTranches[7], curTranchesIn[1], curTranchesIn[2], perp],
          [
            toFixedPtAmt("1500"),
            toFixedPtAmt("200"),
            toFixedPtAmt("300"),
            toFixedPtAmt("3000"),
            toFixedPtAmt("5000"),
            toFixedPtAmt("0"),
          ],
        );
        await checkReserveComposition(
          perp,
          [collateralToken, curTranchesIn[0]],
          [toFixedPtAmt("0"), toFixedPtAmt("2000")],
        );
      });

      describe("when balance covers just 1 token", function () {
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [
              collateralToken,
              reserveTranches[6],
              reserveTranches[7],
              curTranchesIn[0],
              curTranchesIn[1],
              curTranchesIn[2],
              newTranchesIn[1],
              newTranchesIn[2],
              perp,
            ],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("300"),
              toFixedPtAmt("3000"),
              toFixedPtAmt("5000"),
              toFixedPtAmt("450"),
              toFixedPtAmt("750"),
              toFixedPtAmt("0"),
            ],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, curTranchesIn[0], newTranchesIn[0]],
            [toFixedPtAmt("0"), toFixedPtAmt("1700"), toFixedPtAmt("300")],
          );
        });
      });

      describe("when balance covers just 1 token exactly", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("8500"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [
              collateralToken,
              reserveTranches[6],
              reserveTranches[7],
              curTranchesIn[0],
              curTranchesIn[1],
              curTranchesIn[2],
              newTranchesIn[1],
              newTranchesIn[2],
              perp,
            ],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("2000"),
              toFixedPtAmt("3000"),
              toFixedPtAmt("5000"),
              toFixedPtAmt("3000"),
              toFixedPtAmt("5000"),
              toFixedPtAmt("0"),
            ],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, newTranchesIn[0]],
            [toFixedPtAmt("0"), toFixedPtAmt("2000")],
          );
        });
      });
    });

    describe("when many trancheIn one tokenOut (near mature tranche)", function () {
      let curTranchesIn, newTranchesIn;
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, await bondAt(reserveTranches[4].bond()));
        const curBondIn = await bondAt(await perp.callStatic.getDepositBond());
        curTranchesIn = await getTranches(curBondIn);
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(curTranchesIn[0].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(curTranchesIn[0].address)
          .returns(toDiscountFixedPtAmt("1"));

        await collateralToken.transfer(vault.address, toFixedPtAmt("10000"));
        await vault.deploy();

        await advancePerpQueueToRollover(perp, curBondIn);
        const newBondIn = await bondAt(await perp.callStatic.getDepositBond());

        newTranchesIn = await getTranches(newBondIn);
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(newTranchesIn[0].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(newTranchesIn[0].address)
          .returns(toDiscountFixedPtAmt("1"));
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(newTranchesIn[1].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(newTranchesIn[1].address)
          .returns(toDiscountFixedPtAmt("1"));

        await checkVaultAssetComposition(
          vault,
          [collateralToken, reserveTranches[6], reserveTranches[7], curTranchesIn[1], curTranchesIn[2], perp],
          [
            toFixedPtAmt("1500"),
            toFixedPtAmt("200"),
            toFixedPtAmt("300"),
            toFixedPtAmt("3000"),
            toFixedPtAmt("5000"),
            toFixedPtAmt("0"),
          ],
        );
        await checkReserveComposition(
          perp,
          [collateralToken, curTranchesIn[0]],
          [toFixedPtAmt("0"), toFixedPtAmt("2000")],
        );
      });

      describe("when balance covers just 1 token", function () {
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [
              collateralToken,
              reserveTranches[6],
              reserveTranches[7],
              curTranchesIn[0],
              curTranchesIn[1],
              curTranchesIn[2],
              newTranchesIn[2],
              perp,
            ],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("750"),
              toFixedPtAmt("3000"),
              toFixedPtAmt("5000"),
              toFixedPtAmt("750"),
              toFixedPtAmt("0"),
            ],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, curTranchesIn[0], newTranchesIn[0], newTranchesIn[1]],
            [toFixedPtAmt("0"), toFixedPtAmt("1250"), toFixedPtAmt("300"), toFixedPtAmt("450")],
          );
        });
      });

      describe("when balance covers just 1 token exactly", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("2500"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [
              collateralToken,
              reserveTranches[6],
              reserveTranches[7],
              curTranchesIn[0],
              curTranchesIn[1],
              curTranchesIn[2],
              newTranchesIn[2],
              perp,
            ],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("2000"),
              toFixedPtAmt("3000"),
              toFixedPtAmt("5000"),
              toFixedPtAmt("2000"),
              toFixedPtAmt("0"),
            ],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, newTranchesIn[0], newTranchesIn[1]],
            [toFixedPtAmt("0"), toFixedPtAmt("800"), toFixedPtAmt("1200")],
          );
        });
      });
    });

    describe("when one trancheIn many tokenOut", function () {
      describe("when balance covers just 1 token", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("10"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, rolloverInTranches[1], rolloverInTranches[2], perp],
            [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-6), rolloverInTranches[0]],
            [
              toFixedPtAmt("498"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("2"),
            ],
          );
        });
      });

      describe("when balance covers just 1 token exactly", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("2500"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, rolloverInTranches[1], rolloverInTranches[2], perp],
            [toFixedPtAmt("500"), toFixedPtAmt("750"), toFixedPtAmt("1250"), toFixedPtAmt("0")],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-6), rolloverInTranches[0]],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("500"),
            ],
          );
        });
      });

      describe("when balance covers many tokens", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("4000"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [
              collateralToken,
              reserveTranches[2],
              reserveTranches[3],
              rolloverInTranches[1],
              rolloverInTranches[2],
              perp,
            ],
            [
              toFixedPtAmt("500"),
              toFixedPtAmt("200"),
              toFixedPtAmt("100"),
              toFixedPtAmt("1200"),
              toFixedPtAmt("2000"),
              toFixedPtAmt("0"),
            ],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-5), rolloverInTranches[0]],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("200"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("800"),
            ],
          );
        });
      });

      describe("when balance covers all tokens", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("5000"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [
              collateralToken,
              reserveTranches[2],
              reserveTranches[3],
              rolloverInTranches[1],
              rolloverInTranches[2],
              perp,
            ],
            [
              toFixedPtAmt("500"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("1500"),
              toFixedPtAmt("2500"),
              toFixedPtAmt("0"),
            ],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-4), rolloverInTranches[0]],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("1000"),
            ],
          );
        });
      });

      describe("when balance exceeds all tokens", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("6000"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [
              collateralToken,
              reserveTranches[2],
              reserveTranches[3],
              rolloverInTranches[0],
              rolloverInTranches[1],
              rolloverInTranches[2],
              perp,
            ],
            [
              toFixedPtAmt("500"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("1800"),
              toFixedPtAmt("3000"),
              toFixedPtAmt("0"),
            ],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-4), rolloverInTranches[0]],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("1000"),
            ],
          );
        });
      });
    });

    describe("when many trancheIn many tokenOut", function () {
      beforeEach(async function () {
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(rolloverInTranches[1].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(rolloverInTranches[1].address)
          .returns(toDiscountFixedPtAmt("1"));
      });

      describe("when balance covers just 1 token", async function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("10"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, rolloverInTranches[2], perp],
            [toFixedPtAmt("5"), toFixedPtAmt("5"), toFixedPtAmt("0")],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-6), rolloverInTranches[0], rolloverInTranches[1]],
            [
              toFixedPtAmt("495"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("2"),
              toFixedPtAmt("3"),
            ],
          );
        });
      });

      describe("when balance covers just 1 token exactly", async function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("1000"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, rolloverInTranches[2], perp],
            [toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("0")],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-6), rolloverInTranches[0], rolloverInTranches[1]],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
            ],
          );
        });
      });

      describe("when balance covers many tokens", async function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("1500"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, reserveTranches[2], reserveTranches[3], rolloverInTranches[2], perp],
            [toFixedPtAmt("500"), toFixedPtAmt("200"), toFixedPtAmt("50"), toFixedPtAmt("750"), toFixedPtAmt("0")],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-5), rolloverInTranches[0], rolloverInTranches[1]],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("250"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("300"),
              toFixedPtAmt("450"),
            ],
          );
        });
      });

      describe("when balance covers all tokens", async function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("2000"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, reserveTranches[2], reserveTranches[3], rolloverInTranches[2], perp],
            [toFixedPtAmt("500"), toFixedPtAmt("200"), toFixedPtAmt("300"), toFixedPtAmt("1000"), toFixedPtAmt("0")],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-4), rolloverInTranches[0], rolloverInTranches[1]],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("400"),
              toFixedPtAmt("600"),
            ],
          );
        });
      });

      describe("when balance exceeds all tokens", async function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("6000"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [
              collateralToken,
              reserveTranches[2],
              reserveTranches[3],
              rolloverInTranches[0],
              rolloverInTranches[1],
              rolloverInTranches[2],
              perp,
            ],
            [
              toFixedPtAmt("500"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("1800"),
              toFixedPtAmt("3000"),
              toFixedPtAmt("0"),
            ],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-4), rolloverInTranches[0]],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("1000"),
            ],
          );
        });
      });
    });

    describe("when many trancheIn many tokenOut with different yields", function () {
      beforeEach(async function () {
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(rolloverInTranches[1].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(rolloverInTranches[1].address)
          .returns(toDiscountFixedPtAmt("0.75"));
      });

      describe("when balance covers many tokens", async function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("1500"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, reserveTranches[2], rolloverInTranches[2], perp],
            [toFixedPtAmt("500"), toFixedPtAmt("137.5"), toFixedPtAmt("750"), toFixedPtAmt("0")],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-6), rolloverInTranches[0], rolloverInTranches[1]],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("62.5"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("300"),
              toFixedPtAmt("450"),
            ],
          );
        });
      });

      describe("when balance covers all tokens", async function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.address, toFixedPtAmt("3500"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [
              collateralToken,
              reserveTranches[2],
              reserveTranches[3],
              rolloverInTranches[1],
              rolloverInTranches[2],
              perp,
            ],
            [
              toFixedPtAmt("500"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("650"),
              toFixedPtAmt("1750"),
              toFixedPtAmt("0"),
            ],
          );
          await checkReserveComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-4), rolloverInTranches[0], rolloverInTranches[1]],
            [
              toFixedPtAmt("0"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("200"),
              toFixedPtAmt("300"),
              toFixedPtAmt("700"),
              toFixedPtAmt("400"),
            ],
          );
        });
      });
    });

    describe("when rollover yield is rewarded", function () {
      beforeEach(async function () {
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(rolloverInTranches[1].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(rolloverInTranches[1].address)
          .returns(toDiscountFixedPtAmt("1"));

        await feeStrategy.computeRolloverFees.returns([toFixedPtAmt("-25"), "0"]);
        await collateralToken.transfer(vault.address, toFixedPtAmt("1500"));
      });

      it("should rollover", async function () {
        await expect(vault.deploy()).not.to.be.reverted;
        await checkVaultAssetComposition(
          vault,
          [collateralToken, reserveTranches[2], reserveTranches[3], rolloverInTranches[2], perp],
          [toFixedPtAmt("500"), toFixedPtAmt("200"), toFixedPtAmt("50"), toFixedPtAmt("750"), toFixedPtAmt("100")],
        );
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-5), rolloverInTranches[0], rolloverInTranches[1]],
          [
            toFixedPtAmt("0"),
            toFixedPtAmt("250"),
            toFixedPtAmt("200"),
            toFixedPtAmt("300"),
            toFixedPtAmt("200"),
            toFixedPtAmt("300"),
            toFixedPtAmt("300"),
            toFixedPtAmt("450"),
          ],
        );
      });
    });

    describe("typical deploy", function () {
      let tx: Transaction;
      beforeEach(async function () {
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(rolloverInTranches[1].address)
          .returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(rolloverInTranches[1].address)
          .returns(toDiscountFixedPtAmt("0.75"));

        await feeStrategy.computeRolloverFees.returns([toFixedPtAmt("-5"), "0"]);
        await collateralToken.transfer(vault.address, toFixedPtAmt("1500"));
        tx = vault.deploy();
        await tx;
      });

      it("should tranche and rollover", async function () {
        // Tranche
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(rolloverInTranches[0].address, toFixedPtAmt("300"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(rolloverInTranches[1].address, toFixedPtAmt("450"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(rolloverInTranches[2].address, toFixedPtAmt("750"));

        // Roll rollIn[0] for collateralToken
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(rolloverInTranches[0].address, toFixedPtAmt("0"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("300"));

        // Roll rollIn[1] for collateralToken
        await expect(tx)
          .to.emit(vault, "AssetSynced")
          .withArgs(rolloverInTranches[1].address, toFixedPtAmt("183.333333333333333334"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("500"));

        // Roll rollIn[1] for reserve[2]
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(rolloverInTranches[1].address, toFixedPtAmt("0"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(reserveTranches[2].address, toFixedPtAmt("137.5"));

        // rewards
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(perp.address, toFixedPtAmt("15"));
      });

      it("should update the list of deployed assets", async function () {
        expect(await vault.deployedCount()).to.eq(2);
        expect(await vault.deployedAt(0)).to.eq(rolloverInTranches[2].address);
        expect(await vault.deployedAt(1)).to.eq(reserveTranches[2].address);
      });
    });
  });

  describe("deploy limit", function () {
    async function setupDeployment() {
      const curBondIn = await bondAt(await perp.callStatic.getDepositBond());
      await advancePerpQueueToRollover(perp, curBondIn);
      const newBondIn = await bondAt(await perp.callStatic.getDepositBond());
      const newTranchesIn = await getTranches(newBondIn);
      await pricingStrategy.computeTranchePrice
        .whenCalledWith(newTranchesIn[0].address)
        .returns(toPriceFixedPtAmt("1"));
      await discountStrategy.computeTrancheDiscount
        .whenCalledWith(newTranchesIn[0].address)
        .returns(toDiscountFixedPtAmt("1"));
      await collateralToken.transfer(vault.address, toFixedPtAmt("10"));
    }

    beforeEach(async function () {
      for (let i = 0; i < 23; i++) {
        await setupDeployment();
        await vault.deploy();
      }
    });

    it("should revert after limit is reached", async function () {
      expect(await vault.deployedCount()).to.eq(46);
      await setupDeployment();
      await expect(vault.deploy()).to.be.revertedWith("DeployedCountOverLimit");
    });
    it("redemption should be within gas limit", async function () {
      await collateralToken.approve(vault.address, toFixedPtAmt("10"));
      await vault.deposit(toFixedPtAmt("10"));
      await expect(vault.redeem(await vault.balanceOf(await deployer.getAddress()))).not.to.be.reverted;
    });

    it("recovery should be within gas limit", async function () {
      await expect(vault["recover()"]()).not.to.be.reverted;
    });
  });
});
