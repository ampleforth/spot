import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";

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
  checkPerpComposition,
  checkVaultComposition,
  DMock,
  toPercFixedPtAmt,
} from "../helpers";

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
      [bondFactory.target, collateralToken.target, 4800, [200, 800], 1200, 0],
      {
        initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
      },
    );

    feePolicy = new DMock(await ethers.getContractFactory("FeePolicy"));
    await feePolicy.deploy();
    await feePolicy.mockMethod("decimals()", [8]);
    await feePolicy.mockMethod("computeDeviationRatio((uint256,uint256,uint256))", [toPercFixedPtAmt("1")]);
    await feePolicy.mockMethod("computePerpMintFeePerc()", [0]);
    await feePolicy.mockMethod("computePerpBurnFeePerc()", [0]);
    await feePolicy.mockMethod("computePerpRolloverFeePerc(uint256)", [0]);
    await feePolicy.mockMethod("computeVaultMintFeePerc()", [0]);
    await feePolicy.mockMethod("computeVaultBurnFeePerc()", [0]);
    await feePolicy.mockMethod("computeUnderlyingToPerpVaultSwapFeePerc(uint256,uint256)", [0]);
    await feePolicy.mockMethod("computePerpToUnderlyingVaultSwapFeePerc(uint256,uint256)", [0]);

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await upgrades.deployProxy(
      PerpetualTranche.connect(deployer),
      ["PerpetualTranche", "PERP", collateralToken.target, issuer.target, feePolicy.target],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );

    await perp.updateTolerableTrancheMaturity(1200, 4800);
    await advancePerpQueueToBondMaturity(perp, await getDepositBond(perp));

    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    vault = await upgrades.deployProxy(RolloverVault.connect(deployer));
    await vault.init("RolloverVault", "VSHARE", perp.target, feePolicy.target);
    await perp.updateVault(vault.target);

    reserveTranches = [];
    for (let i = 0; i < 4; i++) {
      const bond = await getDepositBond(perp);
      const tranches = await getTranches(bond);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);

      await tranches[0].approve(perp.target, toFixedPtAmt("200"));
      await perp.deposit(tranches[0].target, toFixedPtAmt("200"));

      reserveTranches.push(tranches[0]);
      await advancePerpQueue(perp, 1200);
    }

    await checkPerpComposition(
      perp,
      [collateralToken, ...reserveTranches.slice(-3)],
      [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
    );

    rolloverInBond = await bondAt(await perp.getDepositBond.staticCall());

    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
    await collateralToken.approve(vault.target, toFixedPtAmt("1"));

    await checkVaultComposition(vault, [collateralToken], ["0"]);
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
        currentBondIn = await bondAt(await perp.getDepositBond.staticCall());
        currentTranchesIn = await getTranches(currentBondIn);

        await collateralToken.transfer(vault.target, toFixedPtAmt("10"));

        await vault.deploy();
        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("2"), toFixedPtAmt("8")],
        );
        expect(await vault.assetCount()).to.eq(2);
      });
      describe("when its not mature", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          await checkVaultComposition(
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
          await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("10")]);
        });
        it("should sync assets", async function () {
          const tx = vault["recover()"]();
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("10"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].target, "0");
        });
      });
    });

    describe("when many assets are deployed", function () {
      let currentBondIn: Contract, currentTranchesIn: Contract[], newBondIn: Contract, newTranchesIn: Contract[];
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, rolloverInBond);
        currentBondIn = await bondAt(await perp.getDepositBond.staticCall());
        currentTranchesIn = await getTranches(currentBondIn);

        await collateralToken.transfer(vault.target, toFixedPtAmt("10"));
        await vault.deploy();

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("2"), toFixedPtAmt("8")],
        );
        expect(await vault.assetCount()).to.eq(2);
      });

      describe("when no redemption", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover()"]()).not.to.be.reverted;
          await checkVaultComposition(
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
          await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("10")]);
        });
        it("should sync assets", async function () {
          const tx = vault["recover()"]();
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("10"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].target, "0");
        });
      });

      describe("when immature redemption", function () {
        beforeEach(async function () {
          await depositIntoBond(currentBondIn, toFixedPtAmt("1000"), deployer);
          await currentTranchesIn[0].transfer(vault.target, toFixedPtAmt("100"));

          await advancePerpQueueToRollover(perp, currentBondIn);

          newBondIn = await bondAt(await perp.getDepositBond.staticCall());
          newTranchesIn = await getTranches(newBondIn);

          await collateralToken.transfer(vault.target, toFixedPtAmt("9998"));
          await vault.deploy();

          expect(await vault.assetCount()).to.eq(3);
          await checkVaultComposition(
            vault,
            [collateralToken, currentTranchesIn[0], newTranchesIn[1]],
            [toFixedPtAmt("6808"), toFixedPtAmt("100"), toFixedPtAmt("3200")],
          );
        });

        describe("without reminder", function () {
          beforeEach(async function () {
            await currentTranchesIn[1].transfer(vault.target, toFixedPtAmt("400"));
          });
          it("should recover", async function () {
            await expect(vault["recover()"]()).not.to.be.reverted;
            expect(await vault.assetCount()).to.eq(2);
            await checkVaultComposition(
              vault,
              [collateralToken, newTranchesIn[1]],
              [toFixedPtAmt("7308"), toFixedPtAmt("3200")],
            );
          });
          it("should sync assets", async function () {
            const tx = vault["recover()"]();
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("7308"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].target, toFixedPtAmt("3200"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[0].target, toFixedPtAmt("0"));
          });
        });

        describe("with reminder", function () {
          beforeEach(async function () {
            await currentTranchesIn[1].transfer(vault.target, toFixedPtAmt("100"));
          });
          it("should recover", async function () {
            await expect(vault["recover()"]()).not.to.be.reverted;
            expect(await vault.assetCount()).to.eq(3);
            await checkVaultComposition(
              vault,
              [collateralToken, currentTranchesIn[0], newTranchesIn[1]],
              [toFixedPtAmt("6933"), toFixedPtAmt("75"), toFixedPtAmt("3200")],
            );
          });
          it("should sync assets", async function () {
            const tx = vault["recover()"]();
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("6933"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[0].target, toFixedPtAmt("75"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].target, toFixedPtAmt("3200"));
          });
        });
      });
    });
  });

  describe("#recover(address)", function () {
    describe("when no asset is deployed", function () {
      it("should revert", async function () {
        await vault["recover()"]();
        await expect(vault["recover(address)"](collateralToken.target)).to.be.revertedWithCustomError(
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
        currentBondIn = await bondAt(await perp.getDepositBond.staticCall());
        currentTranchesIn = await getTranches(currentBondIn);

        await collateralToken.transfer(vault.target, toFixedPtAmt("10"));

        await vault.deploy();
        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("2"), toFixedPtAmt("8")],
        );
        expect(await vault.assetCount()).to.eq(2);
      });

      describe("when address is not valid", function () {
        it("should be reverted", async function () {
          await expect(vault["recover(address)"](collateralToken.target)).to.be.revertedWithCustomError(
            vault,
            "UnexpectedAsset",
          );
        });
      });

      describe("when belongs to a malicious tranche", function () {
        it("should be reverted", async function () {
          const maliciousBond = await createBondWithFactory(bondFactory, collateralToken, [1, 999], 100000000000);
          await collateralToken.approve(maliciousBond.target, toFixedPtAmt("1"));
          await maliciousBond.deposit(toFixedPtAmt("1"));
          const maliciousTranches = await getTranches(maliciousBond);
          await maliciousTranches[1].transfer(
            vault.target,
            maliciousTranches[1].balanceOf(await deployer.getAddress()),
          );
          await expect(vault["recover(address)"](maliciousTranches[1].target)).to.be.revertedWithCustomError(
            vault,
            "UnexpectedAsset",
          );
        });
      });

      describe("when its not mature", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover(address)"](currentTranchesIn[1].target)).not.to.be.reverted;
          await checkVaultComposition(
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
          await expect(vault["recover(address)"](currentTranchesIn[1].target)).not.to.be.reverted;
          expect(await vault.assetCount()).to.eq(1);
          await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("10")]);
        });
        it("should sync assets", async function () {
          const tx = vault["recover(address)"](currentTranchesIn[1].target);
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("10"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].target, "0");
        });
      });
    });

    describe("when many assets are deployed", function () {
      let currentBondIn: Contract, currentTranchesIn: Contract[], newBondIn: Contract, newTranchesIn: Contract[];
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, rolloverInBond);
        currentBondIn = await bondAt(await perp.getDepositBond.staticCall());
        currentTranchesIn = await getTranches(currentBondIn);

        await collateralToken.transfer(vault.target, toFixedPtAmt("10"));
        await vault.deploy();

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("2"), toFixedPtAmt("8")],
        );
        expect(await vault.assetCount()).to.eq(2);
      });

      describe("when no redemption", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover(address)"](currentTranchesIn[1].target)).not.to.be.reverted;
          await checkVaultComposition(
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
          await expect(vault["recover(address)"](currentTranchesIn[1].target)).not.to.be.reverted;
          await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("10")]);
          expect(await vault.assetCount()).to.eq(1);
        });
        it("should sync assets", async function () {
          const tx = vault["recover(address)"](currentTranchesIn[1].target);
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("10"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].target, "0");
        });
      });

      describe("when immature redemption", function () {
        beforeEach(async function () {
          await advancePerpQueueToRollover(perp, currentBondIn);
          await depositIntoBond(currentBondIn, toFixedPtAmt("10"), deployer);

          newBondIn = await bondAt(await perp.getDepositBond.staticCall());
          newTranchesIn = await getTranches(newBondIn);

          await collateralToken.transfer(vault.target, toFixedPtAmt("9998"));
          await vault.deploy();

          expect(await vault.assetCount()).to.eq(2);
          await checkVaultComposition(
            vault,
            [collateralToken, newTranchesIn[1]],
            [toFixedPtAmt("6808"), toFixedPtAmt("3200")],
          );
        });

        describe("without reminder", function () {
          beforeEach(async function () {
            await depositIntoBond(newBondIn, toFixedPtAmt("4000"), deployer);
            await newTranchesIn[0].transfer(vault.target, toFixedPtAmt("800"));
          });
          it("should recover", async function () {
            await expect(vault["recover(address)"](newTranchesIn[1].target)).not.to.be.reverted;
            expect(await vault.assetCount()).to.eq(1);
            await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("10808")]);
          });
          it("should sync assets", async function () {
            const tx = vault["recover(address)"](newTranchesIn[1].target);
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("10808"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[0].target, "0");
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].target, "0");
          });
        });

        describe("with reminder", function () {
          beforeEach(async function () {
            await depositIntoBond(newBondIn, toFixedPtAmt("1000"), deployer);
            await newTranchesIn[0].transfer(vault.target, toFixedPtAmt("200"));
          });

          it("should recover", async function () {
            await expect(vault["recover(address)"](newTranchesIn[1].target)).not.to.be.reverted;
            expect(await vault.assetCount()).to.eq(2);
            await checkVaultComposition(
              vault,
              [collateralToken, newTranchesIn[1]],
              [toFixedPtAmt("7808"), toFixedPtAmt("2400")],
            );
          });

          it("should sync assets", async function () {
            const tx = vault["recover(address)"](newTranchesIn[1].target);
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("7808"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[0].target, toFixedPtAmt("0"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].target, toFixedPtAmt("2400"));
          });
        });

        describe("with dust reminder", function () {
          beforeEach(async function () {
            await depositIntoBond(newBondIn, toFixedPtAmt("1000"), deployer);
            await newTranchesIn[0].transfer(vault.target, "200000");
          });

          it("should recover", async function () {
            await expect(vault["recover(address)"](newTranchesIn[1].target)).not.to.be.reverted;
            expect(await vault.assetCount()).to.eq(2);
            await checkVaultComposition(
              vault,
              [collateralToken, newTranchesIn[1]],
              [toFixedPtAmt("6808.000000000001"), toFixedPtAmt("3199.9999999999992")],
            );
          });

          it("should sync assets", async function () {
            const tx = vault["recover(address)"](newTranchesIn[1].target);
            await expect(tx)
              .to.emit(vault, "AssetSynced")
              .withArgs(collateralToken.target, toFixedPtAmt("6808.000000000001"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[0].target, toFixedPtAmt("0"));
            await expect(tx)
              .to.emit(vault, "AssetSynced")
              .withArgs(newTranchesIn[1].target, toFixedPtAmt("3199.9999999999992"));
          });

          it("should not recover dust when triggered again", async function () {
            await depositIntoBond(newBondIn, toFixedPtAmt("10000"), deployer);
            await newTranchesIn[0].transfer(vault.target, toFixedPtAmt("799.999999999999"));
            await vault["recover(address)"](newTranchesIn[1].target);
            const tx = vault["recover(address)"](newTranchesIn[1].target);
            await tx;
            await checkVaultComposition(
              vault,
              [collateralToken, newTranchesIn[1]],
              [toFixedPtAmt("10807.999999999996"), "3200000"],
            );
            await expect(tx)
              .to.emit(vault, "AssetSynced")
              .withArgs(collateralToken.target, toFixedPtAmt("10807.999999999996"));
            await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].target, "3200000");
          });
        });
      });
    });

    describe("recovering perp", function () {
      let currentBondIn: Contract, currentTranchesIn: Contract[];
      beforeEach(async function () {
        currentBondIn = await bondAt(await perp.getDepositBond.staticCall());
        currentTranchesIn = await getTranches(currentBondIn);

        await collateralToken.transfer(vault.target, toFixedPtAmt("125"));
        await vault.deploy();

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("25"), toFixedPtAmt("100")],
        );
        expect(await vault.assetCount()).to.eq(2);
      });

      describe("when vault has no perps", function () {
        it("should be a no-op", async function () {
          await expect(vault["recover(address)"](perp.target)).not.to.be.reverted;
          await checkVaultComposition(
            vault,
            [collateralToken, currentTranchesIn[1]],
            [toFixedPtAmt("25"), toFixedPtAmt("100")],
          );
          expect(await vault.assetCount()).to.eq(2);
        });
      });

      describe("when vault has perps", function () {
        beforeEach(async function () {
          await perp.transfer(vault.target, toFixedPtAmt("100"));
        });
        it("should recover", async function () {
          await expect(vault["recover(address)"](perp.target)).not.to.be.reverted;
          await checkVaultComposition(
            vault,
            [collateralToken, currentTranchesIn[1], ...reserveTranches.slice(-3)],
            [toFixedPtAmt("62.5"), toFixedPtAmt("87.5"), toFixedPtAmt("25"), toFixedPtAmt("25"), toFixedPtAmt("25")],
          );
          expect(await vault.assetCount()).to.eq(5);
        });
        it("should sync assets", async function () {
          const tx = vault["recover(address)"](perp.target);
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("62.5"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].target, toFixedPtAmt("87.5"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[0].target, "0");
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(reserveTranches[1].target, toFixedPtAmt("25"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(reserveTranches[2].target, toFixedPtAmt("25"));
          await expect(tx).to.emit(vault, "AssetSynced").withArgs(reserveTranches[3].target, toFixedPtAmt("25"));
        });
      });
    });
  });

  describe("#recoverAndRedeploy", function () {
    let currentBondIn: Contract, currentTranchesIn: Contract[], newBondIn: Contract, newTranchesIn: Contract[];
    beforeEach(async function () {
      await advancePerpQueueToBondMaturity(perp, rolloverInBond);
      currentBondIn = await bondAt(await perp.getDepositBond.staticCall());
      currentTranchesIn = await getTranches(currentBondIn);

      await collateralToken.transfer(vault.target, toFixedPtAmt("10"));
      await vault.deploy();

      await checkVaultComposition(
        vault,
        [collateralToken, currentTranchesIn[1]],
        [toFixedPtAmt("2"), toFixedPtAmt("8")],
      );
      expect(await vault.assetCount()).to.eq(2);

      await advancePerpQueueToBondMaturity(perp, currentBondIn);

      newBondIn = await bondAt(await perp.getDepositBond.staticCall());
      newTranchesIn = await getTranches(newBondIn);
    });

    it("should recover", async function () {
      await expect(vault.recoverAndRedeploy()).not.to.be.reverted;
      expect(await vault.assetCount()).to.eq(2);
      await checkVaultComposition(vault, [collateralToken, newTranchesIn[1]], [toFixedPtAmt("2"), toFixedPtAmt("8")]);
    });

    it("should sync assets", async function () {
      const tx = vault.recoverAndRedeploy();
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("10"));
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].target, "0");
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[0].target, toFixedPtAmt("2"));
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[1].target, toFixedPtAmt("8"));
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(newTranchesIn[0].target, "0");
      await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("2"));
    });
  });
});
