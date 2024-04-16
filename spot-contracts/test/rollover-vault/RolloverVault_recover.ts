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
let feePolicy: Contract;
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
    issuer = await upgrades.deployProxy(
      BondIssuer.connect(deployer),
      [bondFactory.address, collateralToken.address, 4800, [200, 800], 1200, 0],
      {
        initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
      },
    );

    const FeePolicy = await ethers.getContractFactory("FeePolicy");
    feePolicy = await smock.fake(FeePolicy);
    await feePolicy.computePerpRolloverFeePerc.returns("0");
    await feePolicy.decimals.returns(8);

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await upgrades.deployProxy(
      PerpetualTranche.connect(deployer),
      ["PerpetualTranche", "PERP", collateralToken.address, issuer.address, feePolicy.address],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );

    await perp.updateTolerableTrancheMaturity(1200, 4800);
    await advancePerpQueueToBondMaturity(perp, await getDepositBond(perp));

    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    vault = await upgrades.deployProxy(RolloverVault.connect(deployer));
    await vault.init("RolloverVault", "VSHARE", perp.address, feePolicy.address);
    await perp.updateVault(vault.address);

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
    await collateralToken.approve(vault.address, toFixedPtAmt("1"));

    await checkVaultAssetComposition(vault, [collateralToken], ["0"]);
    expect(await vault.assetCount()).to.eq(1);
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#recover()", function () {
    describe("when no asset is deployed", function () {
      it("should be a no-op", async function () {
        await vault["recover()"]();
        await expect(vault["recover()"]()).not.to.be.reverted;
        expect(await vault.assetCount()).to.eq(1);
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
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("2"), toFixedPtAmt("8")],
        );
        expect(await vault.assetCount()).to.eq(2);
      });
      describe("when its not mature", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1]],
            [toFixedPtAmt("2"), toFixedPtAmt("8")],
          );
          expect(await vault.assetCount()).to.eq(2);
        });
      });
      describe("when its mature", function () {
        beforeEach(async function () {
          await advancePerpQueueToBondMaturity(perp, currentBondIn);
        });
        it("should recover", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          expect(await vault.assetCount()).to.eq(1);
          await checkVaultAssetComposition(vault, [collateralToken], [toFixedPtAmt("10")]);
        });
        it("should sync assets", async function () {
          const tx = vault["recover()"]();
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("10"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, "0");
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
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("2"), toFixedPtAmt("8")],
        );
        expect(await vault.assetCount()).to.eq(2);
      });

      describe("when no redemption", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1]],
            [toFixedPtAmt("2"), toFixedPtAmt("8")],
          );
          expect(await vault.assetCount()).to.eq(2);
        });
      });

      describe("when mature redemption", function () {
        beforeEach(async function () {
          await advancePerpQueueToBondMaturity(perp, currentBondIn);
        });
        it("should recover", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          expect(await vault.assetCount()).to.eq(1);
          await checkVaultAssetComposition(vault, [collateralToken], [toFixedPtAmt("10")]);
        });
        it("should sync assets", async function () {
          const tx = vault["recover()"]();
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("10"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, "0");
        });
      });

      describe("when immature redemption", function () {
        beforeEach(async function () {
          await depositIntoBond(currentBondIn, toFixedPtAmt("1000"), deployer);
          await currentTranchesIn[0].transfer(vault.address, toFixedPtAmt("100"));

          await advancePerpQueueToRollover(perp, currentBondIn);

          newBondIn = await bondAt(await perp.callStatic.getDepositBond());
          newTranchesIn = await getTranches(newBondIn);

          await collateralToken.transfer(vault.address, toFixedPtAmt("9998"));
          await vault.deploy();

          expect(await vault.assetCount()).to.eq(3);
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[0], newTranchesIn[1]],
            [toFixedPtAmt("6808"), toFixedPtAmt("100"), toFixedPtAmt("3200")],
          );
        });

        describe("without reminder", function () {
          beforeEach(async function () {
            await currentTranchesIn[1].transfer(vault.address, toFixedPtAmt("400"));
          });
          it("should recover", async function () {
            await expect(vault["recover()"]()).not.to.be.reverted;
            expect(await vault.assetCount()).to.eq(2);
            await checkVaultAssetComposition(
              vault,
              [collateralToken, newTranchesIn[1]],
              [toFixedPtAmt("7308"), toFixedPtAmt("3200")],
            );
          });
          it("should sync assets", async function () {
            const tx = vault["recover()"]();
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("7308"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].address, toFixedPtAmt("3200"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[0].address, toFixedPtAmt("0"));
          });
        });

        describe("with reminder", function () {
          beforeEach(async function () {
            await currentTranchesIn[1].transfer(vault.address, toFixedPtAmt("100"));
          });
          it("should recover", async function () {
            await expect(vault["recover()"]()).not.to.be.reverted;
            expect(await vault.assetCount()).to.eq(3);
            await checkVaultAssetComposition(
              vault,
              [collateralToken, currentTranchesIn[0], newTranchesIn[1]],
              [toFixedPtAmt("6933"), toFixedPtAmt("75"), toFixedPtAmt("3200")],
            );
          });
          it("should sync assets", async function () {
            const tx = vault["recover()"]();
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("6933"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[0].address, toFixedPtAmt("75"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].address, toFixedPtAmt("3200"));
          });
        });
      });
    });
  });

  describe("#recover(address)", function () {
    describe("when no asset is deployed", function () {
      it("should revert", async function () {
        await vault["recover()"]();
        await expect(vault["recover(address)"](collateralToken.address)).to.be.revertedWithCustomError(
          vault,
          "UnexpectedAsset",
        );
        expect(await vault.assetCount()).to.eq(1);
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
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("2"), toFixedPtAmt("8")],
        );
        expect(await vault.assetCount()).to.eq(2);
      });

      describe("when address is not valid", function () {
        it("should be reverted", async function () {
          await expect(vault["recover(address)"](collateralToken.address)).to.be.revertedWithCustomError(
            vault,
            "UnexpectedAsset",
          );
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
          await expect(vault["recover(address)"](maliciousTranches[1].address)).to.be.revertedWithCustomError(
            vault,
            "UnexpectedAsset",
          );
        });
      });

      describe("when its not mature", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover(address)"](currentTranchesIn[1].address)).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1]],
            [toFixedPtAmt("2"), toFixedPtAmt("8")],
          );
          expect(await vault.assetCount()).to.eq(2);
        });
      });

      describe("when its mature", function () {
        beforeEach(async function () {
          await advancePerpQueueUpToBondMaturity(perp, currentBondIn);
        });
        it("should recover", async function () {
          await expect(vault["recover(address)"](currentTranchesIn[1].address)).not.to.be.reverted;
          expect(await vault.assetCount()).to.eq(1);
          await checkVaultAssetComposition(vault, [collateralToken], [toFixedPtAmt("10")]);
        });
        it("should sync assets", async function () {
          const tx = vault["recover(address)"](currentTranchesIn[1].address);
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("10"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, "0");
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
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("2"), toFixedPtAmt("8")],
        );
        expect(await vault.assetCount()).to.eq(2);
      });

      describe("when no redemption", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover(address)"](currentTranchesIn[1].address)).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1]],
            [toFixedPtAmt("2"), toFixedPtAmt("8")],
          );
          expect(await vault.assetCount()).to.eq(2);
        });
      });

      describe("when mature redemption", function () {
        beforeEach(async function () {
          await advancePerpQueueToBondMaturity(perp, currentBondIn);
        });
        it("should recover", async function () {
          await expect(vault["recover(address)"](currentTranchesIn[1].address)).not.to.be.reverted;
          await checkVaultAssetComposition(vault, [collateralToken], [toFixedPtAmt("10")]);
          expect(await vault.assetCount()).to.eq(1);
        });
        it("should sync assets", async function () {
          const tx = vault["recover(address)"](currentTranchesIn[1].address);
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("10"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, "0");
        });
      });

      describe("when immature redemption", function () {
        beforeEach(async function () {
          await advancePerpQueueToRollover(perp, currentBondIn);

          newBondIn = await bondAt(await perp.callStatic.getDepositBond());
          newTranchesIn = await getTranches(newBondIn);

          await collateralToken.transfer(vault.address, toFixedPtAmt("9998"));
          await vault.deploy();

          expect(await vault.assetCount()).to.eq(2);
          await checkVaultAssetComposition(
            vault,
            [collateralToken, newTranchesIn[1]],
            [toFixedPtAmt("6808"), toFixedPtAmt("3200")],
          );
        });

        describe("without reminder", function () {
          beforeEach(async function () {
            await depositIntoBond(newBondIn, toFixedPtAmt("4000"), deployer);
            await newTranchesIn[0].transfer(vault.address, toFixedPtAmt("800"));
          });
          it("should recover", async function () {
            await expect(vault["recover(address)"](newTranchesIn[1].address)).not.to.be.reverted;
            expect(await vault.assetCount()).to.eq(1);
            await checkVaultAssetComposition(vault, [collateralToken], [toFixedPtAmt("10808")]);
          });
          it("should sync assets", async function () {
            const tx = vault["recover(address)"](newTranchesIn[1].address);
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("10808"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[0].address, "0");
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].address, "0");
          });
        });

        describe("with reminder", function () {
          beforeEach(async function () {
            await depositIntoBond(newBondIn, toFixedPtAmt("1000"), deployer);
            await newTranchesIn[0].transfer(vault.address, toFixedPtAmt("200"));
          });

          it("should recover", async function () {
            await expect(vault["recover(address)"](newTranchesIn[1].address)).not.to.be.reverted;
            expect(await vault.assetCount()).to.eq(2);
            await checkVaultAssetComposition(
              vault,
              [collateralToken, newTranchesIn[1]],
              [toFixedPtAmt("7808"), toFixedPtAmt("2400")],
            );
          });

          it("should sync assets", async function () {
            const tx = vault["recover(address)"](newTranchesIn[1].address);
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("7808"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[0].address, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].address, toFixedPtAmt("2400"));
          });
        });

        describe("with dust reminder", function () {
          beforeEach(async function () {
            await depositIntoBond(newBondIn, toFixedPtAmt("1000"), deployer);
            await newTranchesIn[0].transfer(vault.address, "200000");
          });

          it("should recover", async function () {
            await expect(vault["recover(address)"](newTranchesIn[1].address)).not.to.be.reverted;
            expect(await vault.assetCount()).to.eq(2);
            await checkVaultAssetComposition(
              vault,
              [collateralToken, newTranchesIn[1]],
              [toFixedPtAmt("6808.000000000001"), toFixedPtAmt("3199.9999999999992")],
            );
          });

          it("should sync assets", async function () {
            const tx = vault["recover(address)"](newTranchesIn[1].address);
            await expect(tx)
              .to.emit(vault, "AssetSynced")
              .withArgs(collateralToken.address, toFixedPtAmt("6808.000000000001"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[0].address, toFixedPtAmt("0"));
            await expect(tx)
              .to.emit(vault, "AssetSynced")
              .withArgs(newTranchesIn[1].address, toFixedPtAmt("3199.9999999999992"));
          });

          it("should not recover dust when triggered again", async function () {
            await depositIntoBond(newBondIn, toFixedPtAmt("10000"), deployer);
            await newTranchesIn[0].transfer(vault.address, toFixedPtAmt("799.999999999999"));
            await vault["recover(address)"](newTranchesIn[1].address);
            const tx = vault["recover(address)"](newTranchesIn[1].address);
            await tx;
            await checkVaultAssetComposition(
              vault,
              [collateralToken, newTranchesIn[1]],
              [toFixedPtAmt("10807.999999999996"), "3200000"],
            );
            await expect(tx)
              .to.emit(vault, "AssetSynced")
              .withArgs(collateralToken.address, toFixedPtAmt("10807.999999999996"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].address, "3200000");
          });
        });
      });
    });

    describe("recovering perp", function () {
      let currentBondIn: Contract, currentTranchesIn: Contract[];
      beforeEach(async function () {
        currentBondIn = await bondAt(await perp.callStatic.getDepositBond());
        currentTranchesIn = await getTranches(currentBondIn);

        await collateralToken.transfer(vault.address, toFixedPtAmt("125"));
        await vault.deploy();

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("25"), toFixedPtAmt("100")],
        );
        expect(await vault.assetCount()).to.eq(2);
      });

      describe("when vault has no perps", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover(address)"](perp.address)).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1]],
            [toFixedPtAmt("25"), toFixedPtAmt("100")],
          );
          expect(await vault.assetCount()).to.eq(2);
        });
      });

      describe("when vault has perps", function () {
        beforeEach(async function () {
          await perp.transfer(vault.address, toFixedPtAmt("100"));
        });
        it("should recover", async function () {
          await expect(vault["recover(address)"](perp.address)).not.to.be.reverted;
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], ...reserveTranches.slice(-3)],
            [toFixedPtAmt("62.5"), toFixedPtAmt("87.5"), toFixedPtAmt("25"), toFixedPtAmt("25"), toFixedPtAmt("25")],
          );
          expect(await vault.assetCount()).to.eq(5);
        });
        it("should sync assets", async function () {
          const tx = vault["recover(address)"](perp.address);
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("62.5"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, toFixedPtAmt("87.5"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[0].address, "0");
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(reserveTranches[1].address, toFixedPtAmt("25"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(reserveTranches[2].address, toFixedPtAmt("25"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(reserveTranches[3].address, toFixedPtAmt("25"));
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
        [collateralToken, currentTranchesIn[1]],
        [toFixedPtAmt("2"), toFixedPtAmt("8")],
      );
      expect(await vault.assetCount()).to.eq(2);

      await advancePerpQueueToBondMaturity(perp, currentBondIn);

      newBondIn = await bondAt(await perp.callStatic.getDepositBond());
      newTranchesIn = await getTranches(newBondIn);
    });

    it("should recover", async function () {
      await expect(vault.recoverAndRedeploy()).not.to.be.reverted;
      expect(await vault.assetCount()).to.eq(2);
      await checkVaultAssetComposition(
        vault,
        [collateralToken, newTranchesIn[1]],
        [toFixedPtAmt("2"), toFixedPtAmt("8")],
      );
    });

    it("should sync assets", async function () {
      const tx = vault.recoverAndRedeploy();
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("10"));
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].address, "0");
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[0].address, toFixedPtAmt("2"));
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].address, toFixedPtAmt("8"));
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[0].address, "0");
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("2"));
    });
  });
});
