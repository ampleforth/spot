import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";
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
  toPriceFixedPtAmt,
  getDepositBond,
  advancePerpQueue,
  advancePerpQueueUpToBondMaturity,
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
let deployer: Signer;
let reserveTranches: Contract[][] = [];
let rolloverInBond: Contract;

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

    const FeeStrategy = await ethers.getContractFactory("FeeStrategy");
    feeStrategy = await smock.fake(FeeStrategy);
    await feeStrategy.computeRolloverFeePerc.returns("0");
    await feeStrategy.decimals.returns(8);

    const PricingStrategy = await ethers.getContractFactory("UnitPricingStrategy");
    pricingStrategy = await smock.fake(PricingStrategy);
    await pricingStrategy.decimals.returns(8);
    await pricingStrategy.computeTranchePrice.returns(toPriceFixedPtAmt("1"));

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
      ],
      {
        initializer: "init(string,string,address,address,address,address)",
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

      await tranches[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

      reserveTranches.push(tranches[0]);
      await advancePerpQueue(perp, 1200);
    }

    await checkReserveComposition(
      perp,
      [collateralToken, ...reserveTranches.slice(-3)],
      [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
    );

    rolloverInBond = await bondAt(await perp.callStatic.getDepositBond());

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

  describe("#recover()", function () {
    describe("when no asset is deployed", function () {
      it("should be a no-op", async function () {
        await vault["recover()"]();
        await expect(vault["recover()"]()).not.to.be.reverted;
        expect(await vault.deployedCount()).to.eq(0);
      });
    });

    describe("when one asset deployed", function () {
      let currentBondIn: Contract, currentTranchesIn: Contract[];
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, rolloverInBond);
        currentBondIn = await bondAt(await perp.callStatic.getDepositBond());
        currentTranchesIn = await getTranches(currentBondIn);

        await collateralToken.transfer(vault.address, toFixedPtAmt("10"));

        await vault.deploy();
        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
          [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
        );
        expect(await vault.deployedCount()).to.eq(2);
      });
      describe("when its not mature", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
          );
          expect(await vault.deployedCount()).to.eq(2);
        });
      });
      describe("when its mature", function () {
        beforeEach(async function () {
          await advancePerpQueueToBondMaturity(perp, currentBondIn);
        });
        it("should recover", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          expect(await vault.deployedCount()).to.eq(0);
          await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("10"), toFixedPtAmt("0")]);
        });
        it("should sync assets", async function () {
          const tx = vault["recover()"]();
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

        await collateralToken.transfer(vault.address, toFixedPtAmt("10"));
        await vault.deploy();

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
          [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
        );
        expect(await vault.deployedCount()).to.eq(2);
      });

      describe("when no redemption", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
          );
          expect(await vault.deployedCount()).to.eq(2);
        });
      });

      describe("when mature redemption", function () {
        beforeEach(async function () {
          await advancePerpQueueToBondMaturity(perp, currentBondIn);
        });
        it("should recover", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          expect(await vault.deployedCount()).to.eq(0);
          await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("10"), toFixedPtAmt("0")]);
        });
        it("should sync assets", async function () {
          const tx = vault["recover()"]();
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

          await collateralToken.transfer(vault.address, toFixedPtAmt("9998"));
          await vault.deploy();

          expect(await vault.deployedCount()).to.eq(6);
          await checkVaultAssetComposition(
            vault,
            [
              collateralToken,
              currentTranchesIn[0],
              currentTranchesIn[1],
              currentTranchesIn[2],
              newTranchesIn[0],
              newTranchesIn[1],
              newTranchesIn[2],
              perp,
            ],
            [
              toFixedPtAmt("798"),
              toFixedPtAmt("2"),
              toFixedPtAmt("3"),
              toFixedPtAmt("5"),
              toFixedPtAmt("1200"),
              toFixedPtAmt("3000"),
              toFixedPtAmt("5000"),
              toFixedPtAmt("0"),
            ],
          );
        });

        describe("without reminder", function () {
          it("should recover", async function () {
            await expect(vault["recover()"]()).not.to.be.reverted;
            expect(await vault.deployedCount()).to.eq(2);
            await checkVaultAssetComposition(
              vault,
              [collateralToken, newTranchesIn[1], newTranchesIn[2], perp],
              [toFixedPtAmt("6808"), toFixedPtAmt("1200"), toFixedPtAmt("2000"), toFixedPtAmt("0")],
            );
          });
          it("should sync assets", async function () {
            const tx = vault["recover()"]();
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("6808"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[0].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[2].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].address, toFixedPtAmt("1200"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[2].address, toFixedPtAmt("2000"));
          });
        });

        describe("with reminder", function () {
          beforeEach(async function () {
            await depositIntoBond(currentBondIn, toFixedPtAmt("1000"), deployer);
            await currentTranchesIn[2].transfer(vault.address, toFixedPtAmt("1"));
            expect(await vault.deployedCount()).to.eq(6);
            await checkVaultAssetComposition(
              vault,
              [
                collateralToken,
                currentTranchesIn[0],
                currentTranchesIn[1],
                currentTranchesIn[2],
                newTranchesIn[0],
                newTranchesIn[1],
                newTranchesIn[2],
                perp,
              ],
              [
                toFixedPtAmt("798"),
                toFixedPtAmt("2"),
                toFixedPtAmt("3"),
                toFixedPtAmt("6"),
                toFixedPtAmt("1200"),
                toFixedPtAmt("3000"),
                toFixedPtAmt("5000"),
                toFixedPtAmt("0"),
              ],
            );
          });
          it("should recover", async function () {
            await expect(vault["recover()"]()).not.to.be.reverted;
            expect(await vault.deployedCount()).to.eq(3);
            await checkVaultAssetComposition(
              vault,
              [collateralToken, currentTranchesIn[2], newTranchesIn[1], newTranchesIn[2], perp],
              [toFixedPtAmt("6808"), toFixedPtAmt("1"), toFixedPtAmt("1200"), toFixedPtAmt("2000"), toFixedPtAmt("0")],
            );
          });
          it("should sync assets", async function () {
            const tx = vault["recover()"]();
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("6808"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[0].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[2].address, toFixedPtAmt("1"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].address, toFixedPtAmt("1200"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[2].address, toFixedPtAmt("2000"));
          });
        });
      });
    });

    describe("when one asset deployed with earned balance", function () {
      let currentBondIn: Contract, currentTranchesIn: Contract[];
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, rolloverInBond);
        currentBondIn = await bondAt(await perp.callStatic.getDepositBond());
        currentTranchesIn = await getTranches(currentBondIn);

        await collateralToken.transfer(vault.address, toFixedPtAmt("10"));
        await vault.deploy();
        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
          [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
        );
        expect(await vault.deployedCount()).to.eq(2);
        await perp.transfer(vault.address, toFixedPtAmt("10"));
      });
      describe("when deployed asset is not mature", function () {
        it("should redeem perp tranches", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("12.1"), toFixedPtAmt("2.9625"), toFixedPtAmt("4.9375"), toFixedPtAmt("0")],
          );
          expect(await vault.deployedCount()).to.eq(2);
        });
      });
      describe("when deployed asset is mature", function () {
        beforeEach(async function () {
          await advancePerpQueueToBondMaturity(perp, currentBondIn);
        });
        it("should recover", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          expect(await vault.deployedCount()).to.eq(0);
          await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("20"), toFixedPtAmt("0")]);
        });
        it("should sync assets", async function () {
          const tx = vault["recover()"]();
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("20"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(perp.address, toFixedPtAmt("0"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[2].address, toFixedPtAmt("0"));
        });
      });
    });

    describe("when many assets are deployed with earned balance", function () {
      let currentBondIn: Contract, currentTranchesIn: Contract[], newBondIn: Contract, newTranchesIn: Contract[];
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, rolloverInBond);
        currentBondIn = await bondAt(await perp.callStatic.getDepositBond());
        currentTranchesIn = await getTranches(currentBondIn);

        await collateralToken.transfer(vault.address, toFixedPtAmt("10"));
        await vault.deploy();

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
          [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
        );
        expect(await vault.deployedCount()).to.eq(2);
        await perp.transfer(vault.address, toFixedPtAmt("10"));
      });

      describe("when deployed tranches are not mature", function () {
        it("should redeem perp tranches", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("12.1"), toFixedPtAmt("2.9625"), toFixedPtAmt("4.9375"), toFixedPtAmt("0")],
          );
          expect(await vault.deployedCount()).to.eq(2);
        });
      });

      describe("when deployed tranches are mature", function () {
        beforeEach(async function () {
          await advancePerpQueueToBondMaturity(perp, currentBondIn);
        });
        it("should recover", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          expect(await vault.deployedCount()).to.eq(0);
          await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("20"), toFixedPtAmt("0")]);
        });
        it("should sync assets", async function () {
          const tx = vault["recover()"]();
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("20"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, toFixedPtAmt("0"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[2].address, toFixedPtAmt("0"));
        });
      });

      describe("when deployed tranches can be redeemed before maturity", function () {
        beforeEach(async function () {
          await advancePerpQueueToRollover(perp, currentBondIn);

          newBondIn = await bondAt(await perp.callStatic.getDepositBond());
          newTranchesIn = await getTranches(newBondIn);

          await collateralToken.transfer(vault.address, toFixedPtAmt("9998"));
          await vault.deploy();

          expect(await vault.deployedCount()).to.eq(6);
          await checkVaultAssetComposition(
            vault,
            [
              collateralToken,
              currentTranchesIn[0],
              currentTranchesIn[1],
              currentTranchesIn[2],
              newTranchesIn[0],
              newTranchesIn[1],
              newTranchesIn[2],
              perp,
            ],
            [
              toFixedPtAmt("798"),
              toFixedPtAmt("2"),
              toFixedPtAmt("3"),
              toFixedPtAmt("5"),
              toFixedPtAmt("1200"),
              toFixedPtAmt("3000"),
              toFixedPtAmt("5000"),
              toFixedPtAmt("10"),
            ],
          );
        });

        describe("without reminder", function () {
          it("should recover", async function () {
            await expect(vault["recover()"]()).not.to.be.reverted;
            expect(await vault.deployedCount()).to.eq(2);
            await checkVaultAssetComposition(
              vault,
              [collateralToken, newTranchesIn[1], newTranchesIn[2], perp],
              [toFixedPtAmt("6858"), toFixedPtAmt("1185"), toFixedPtAmt("1975"), toFixedPtAmt("0")],
            );
          });
          it("should sync assets", async function () {
            const tx = vault["recover()"]();
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("6858"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[0].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[2].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].address, toFixedPtAmt("1185"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[2].address, toFixedPtAmt("1975"));
          });
        });

        describe("with reminder", function () {
          beforeEach(async function () {
            await depositIntoBond(currentBondIn, toFixedPtAmt("1000"), deployer);
            await currentTranchesIn[2].transfer(vault.address, toFixedPtAmt("1"));
            expect(await vault.deployedCount()).to.eq(6);
            await checkVaultAssetComposition(
              vault,
              [
                collateralToken,
                currentTranchesIn[0],
                currentTranchesIn[1],
                currentTranchesIn[2],
                newTranchesIn[0],
                newTranchesIn[1],
                newTranchesIn[2],
                perp,
              ],
              [
                toFixedPtAmt("798"),
                toFixedPtAmt("2"),
                toFixedPtAmt("3"),
                toFixedPtAmt("6"),
                toFixedPtAmt("1200"),
                toFixedPtAmt("3000"),
                toFixedPtAmt("5000"),
                toFixedPtAmt("10"),
              ],
            );
          });
          it("should recover", async function () {
            await expect(vault["recover()"]()).not.to.be.reverted;
            expect(await vault.deployedCount()).to.eq(3);
            await checkVaultAssetComposition(
              vault,
              [collateralToken, currentTranchesIn[2], newTranchesIn[1], newTranchesIn[2], perp],
              [toFixedPtAmt("6858"), toFixedPtAmt("1"), toFixedPtAmt("1185"), toFixedPtAmt("1975"), toFixedPtAmt("0")],
            );
          });
          it("should sync assets", async function () {
            const tx = vault["recover()"]();
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("6858"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[0].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[2].address, toFixedPtAmt("1"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].address, toFixedPtAmt("1185"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[2].address, toFixedPtAmt("1975"));
          });
        });
      });
    });
  });

  describe("#recover(address)", function () {
    describe("when no asset is deployed", function () {
      it("should revert", async function () {
        await vault["recover()"]();
        await expect(vault["recover(address)"](collateralToken.address)).to.be.revertedWith("UnexpectedAsset");
        expect(await vault.deployedCount()).to.eq(0);
      });
    });

    describe("when one asset deployed", function () {
      let currentBondIn: Contract, currentTranchesIn: Contract[];
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, rolloverInBond);
        currentBondIn = await bondAt(await perp.callStatic.getDepositBond());
        currentTranchesIn = await getTranches(currentBondIn);

        await collateralToken.transfer(vault.address, toFixedPtAmt("10"));

        await vault.deploy();
        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
          [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
        );
        expect(await vault.deployedCount()).to.eq(2);
      });
      describe("when address is not valid", function () {
        it("should be reverted", async function () {
          await expect(vault["recover(address)"](collateralToken.address)).to.be.revertedWith("UnexpectedAsset");
        });
      });
      describe("when belongs to a malicious tranche", function () {
        it("should be reverted", async function () {
          const maliciousBond = await createBondWithFactory(bondFactory, collateralToken, [1, 999], 100000000000);
          await collateralToken.approve(maliciousBond.address, toFixedPtAmt("1"));
          await maliciousBond.deposit(toFixedPtAmt("1"));
          const maliciousTranches = await getTranches(maliciousBond);
          await maliciousTranches[1].transfer(
            vault.address,
            maliciousTranches[1].balanceOf(await deployer.getAddress()),
          );
          await expect(vault["recover(address)"](maliciousTranches[1].address)).to.be.revertedWith("UnexpectedAsset");
        });
      });
      describe("when its not mature", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover(address)"](currentTranchesIn[2].address)).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
          );
          expect(await vault.deployedCount()).to.eq(2);
        });
      });
      describe("when its mature", function () {
        beforeEach(async function () {
          await advancePerpQueueUpToBondMaturity(perp, currentBondIn);
        });
        it("should recover", async function () {
          await expect(vault["recover(address)"](currentTranchesIn[2].address)).not.to.be.reverted;
          expect(await vault.deployedCount()).to.eq(1);
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], perp],
            [toFixedPtAmt("7"), toFixedPtAmt("3"), toFixedPtAmt("0")],
          );
        });
        it("should sync assets", async function () {
          const tx = vault["recover(address)"](currentTranchesIn[2].address);
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("7"));
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

        await collateralToken.transfer(vault.address, toFixedPtAmt("10"));
        await vault.deploy();

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
          [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
        );
        expect(await vault.deployedCount()).to.eq(2);
      });

      describe("when no redemption", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover(address)"](currentTranchesIn[1].address)).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
          );
          expect(await vault.deployedCount()).to.eq(2);
        });
      });

      describe("when mature redemption", function () {
        beforeEach(async function () {
          await advancePerpQueueToBondMaturity(perp, currentBondIn);
        });
        it("should recover", async function () {
          await expect(vault["recover(address)"](currentTranchesIn[1].address)).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[2], perp],
            [toFixedPtAmt("5"), toFixedPtAmt("5"), toFixedPtAmt("0")],
          );
          expect(await vault.deployedCount()).to.eq(1);
        });
        it("should sync assets", async function () {
          const tx = vault["recover(address)"](currentTranchesIn[1].address);
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("5"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, toFixedPtAmt("0"));
        });
      });

      describe("when immature redemption", function () {
        beforeEach(async function () {
          await advancePerpQueueToRollover(perp, currentBondIn);

          newBondIn = await bondAt(await perp.callStatic.getDepositBond());
          newTranchesIn = await getTranches(newBondIn);

          await collateralToken.transfer(vault.address, toFixedPtAmt("9998"));
          await vault.deploy();

          expect(await vault.deployedCount()).to.eq(6);
          await checkVaultAssetComposition(
            vault,
            [
              collateralToken,
              currentTranchesIn[0],
              currentTranchesIn[1],
              currentTranchesIn[2],
              newTranchesIn[0],
              newTranchesIn[1],
              newTranchesIn[2],
              perp,
            ],
            [
              toFixedPtAmt("798"),
              toFixedPtAmt("2"),
              toFixedPtAmt("3"),
              toFixedPtAmt("5"),
              toFixedPtAmt("1200"),
              toFixedPtAmt("3000"),
              toFixedPtAmt("5000"),
              toFixedPtAmt("0"),
            ],
          );
        });

        describe("without reminder", function () {
          it("should recover", async function () {
            await expect(vault["recover(address)"](currentTranchesIn[1].address)).not.to.be.reverted;
            expect(await vault.deployedCount()).to.eq(3);
            await checkVaultAssetComposition(
              vault,
              [collateralToken, newTranchesIn[0], newTranchesIn[1], newTranchesIn[2], perp],
              [
                toFixedPtAmt("808"),
                toFixedPtAmt("1200"),
                toFixedPtAmt("3000"),
                toFixedPtAmt("5000"),
                toFixedPtAmt("0"),
              ],
            );
          });
          it("should sync assets", async function () {
            const tx = vault["recover(address)"](currentTranchesIn[1].address);
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("808"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, toFixedPtAmt("0"));
          });
        });

        describe("with reminder", function () {
          beforeEach(async function () {
            await depositIntoBond(currentBondIn, toFixedPtAmt("1000"), deployer);
            await currentTranchesIn[2].transfer(vault.address, toFixedPtAmt("1"));
            expect(await vault.deployedCount()).to.eq(6);
            await checkVaultAssetComposition(
              vault,
              [
                collateralToken,
                currentTranchesIn[0],
                currentTranchesIn[1],
                currentTranchesIn[2],
                newTranchesIn[0],
                newTranchesIn[1],
                newTranchesIn[2],
                perp,
              ],
              [
                toFixedPtAmt("798"),
                toFixedPtAmt("2"),
                toFixedPtAmt("3"),
                toFixedPtAmt("6"),
                toFixedPtAmt("1200"),
                toFixedPtAmt("3000"),
                toFixedPtAmt("5000"),
                toFixedPtAmt("0"),
              ],
            );
          });
          it("should recover", async function () {
            await expect(vault["recover(address)"](currentTranchesIn[0].address)).not.to.be.reverted;
            expect(await vault.deployedCount()).to.eq(4);
            await checkVaultAssetComposition(
              vault,
              [collateralToken, currentTranchesIn[2], newTranchesIn[0], newTranchesIn[1], newTranchesIn[2], perp],
              [
                toFixedPtAmt("808"),
                toFixedPtAmt("1"),
                toFixedPtAmt("1200"),
                toFixedPtAmt("3000"),
                toFixedPtAmt("5000"),
                toFixedPtAmt("0"),
              ],
            );
          });
          it("should sync assets", async function () {
            const tx = vault["recover(address)"](currentTranchesIn[0].address);
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("808"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[0].address, toFixedPtAmt("0"));
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

      await collateralToken.transfer(vault.address, toFixedPtAmt("10"));
      await vault.deploy();

      await checkVaultAssetComposition(
        vault,
        [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
        [toFixedPtAmt("2"), toFixedPtAmt("3"), toFixedPtAmt("5"), toFixedPtAmt("0")],
      );
      expect(await vault.deployedCount()).to.eq(2);

      await advancePerpQueueToBondMaturity(perp, currentBondIn);

      newBondIn = await bondAt(await perp.callStatic.getDepositBond());
      newTranchesIn = await getTranches(newBondIn);
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
