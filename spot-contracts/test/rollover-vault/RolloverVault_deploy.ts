import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer, Transaction } from "ethers";

import {
  setupCollateralToken,
  mintCollteralToken,
  setupBondFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toPercFixedPtAmt,
  getDepositBond,
  advancePerpQueue,
  advancePerpQueueToBondMaturity,
  advancePerpQueueToRollover,
  checkPerpComposition,
  checkVaultComposition,
  rebase,
  DMock,
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
let rolloverInTranches: Contract;
let rebaseOracle: Contract;

describe("RolloverVault", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];

    bondFactory = await setupBondFactory();
    ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));

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
    rolloverInTranches = await getTranches(rolloverInBond);
    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
    await collateralToken.approve(vault.target, toFixedPtAmt("1"));

    await checkVaultComposition(vault, [collateralToken], ["0"]);
    expect(await vault.assetCount()).to.eq(1);
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

    describe("when reservedUnderlyingBal is not set", function () {
      beforeEach(async function () {
        await vault.updateReservedUnderlyingBal(toFixedPtAmt("0"));
      });

      describe("when usable balance is lower than the min deployment", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.target, toFixedPtAmt("999"));
          await vault.updateMinDeploymentAmt(toFixedPtAmt("1000"));
        });
        it("should revert", async function () {
          await expect(vault.deploy()).to.be.revertedWithCustomError(vault, "InsufficientDeployment");
        });
      });

      describe("when usable balance is higher than the min deployment", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.target, toFixedPtAmt("1000"));
          await vault.updateMinDeploymentAmt(toFixedPtAmt("100"));
        });
        it("should not revert", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
        });
      });
    });

    describe("when reservedUnderlyingBal is set", function () {
      beforeEach(async function () {
        await vault.updateReservedUnderlyingBal(toFixedPtAmt("25"));
      });

      describe("when usable balance is lower than the reservedUnderlyingBal", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.target, toFixedPtAmt("20"));
          await vault.updateMinDeploymentAmt(toFixedPtAmt("1"));
        });
        it("should revert", async function () {
          await expect(vault.deploy()).to.be.revertedWithCustomError(vault, "InsufficientDeployment");
        });
      });

      describe("when usable balance is lower than the min deployment", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.target, toFixedPtAmt("125"));
          await vault.updateMinDeploymentAmt(toFixedPtAmt("100"));
        });
        it("should revert", async function () {
          await expect(vault.deploy()).to.be.revertedWithCustomError(vault, "InsufficientDeployment");
        });
      });

      describe("when usable balance is higher than the min deployment", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.target, toFixedPtAmt("126"));
          await vault.updateMinDeploymentAmt(toFixedPtAmt("100"));
        });
        it("should not revert", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
        });
      });
    });

    describe("when one trancheIn one tokenOut (mature tranche)", function () {
      let newTranchesIn;
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, rolloverInBond);
        const newBondIn = await bondAt(await perp.getDepositBond.staticCall());
        newTranchesIn = await getTranches(newBondIn);
        await checkPerpComposition(perp, [collateralToken], [toFixedPtAmt("800")]);
      });

      describe("when balance covers just 1 token", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.target, toFixedPtAmt("10"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultComposition(
            vault,
            [collateralToken, newTranchesIn[1]],
            [toFixedPtAmt("2"), toFixedPtAmt("8")],
          );
          await checkPerpComposition(
            perp,
            [collateralToken, newTranchesIn[0]],
            [toFixedPtAmt("798"), toFixedPtAmt("2")],
          );
        });
      });

      describe("when balance covers just 1 token exactly", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.target, toFixedPtAmt("10000"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultComposition(
            vault,
            [collateralToken, newTranchesIn[1]],
            [toFixedPtAmt("6800"), toFixedPtAmt("3200")],
          );
          await checkPerpComposition(perp, [collateralToken, newTranchesIn[0]], ["0", toFixedPtAmt("800")]);
        });
      });
    });

    describe("when one trancheIn one tokenOut (near mature tranche)", function () {
      let curTranchesIn, newTranchesIn;
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, await bondAt(await reserveTranches[2].bond()));
        const curBondIn = await bondAt(await perp.getDepositBond.staticCall());
        await depositIntoBond(curBondIn, toFixedPtAmt("10"), deployer);
        curTranchesIn = await getTranches(curBondIn);
        await collateralToken.transfer(vault.target, toFixedPtAmt("10000"));
        await vault.deploy();

        await advancePerpQueueToRollover(perp, curBondIn);
        const newBondIn = await bondAt(await perp.getDepositBond.staticCall());

        newTranchesIn = await getTranches(newBondIn);
        await checkVaultComposition(
          vault,
          [collateralToken, reserveTranches[3], curTranchesIn[1]],
          [toFixedPtAmt("6600"), toFixedPtAmt("200"), toFixedPtAmt("3200")],
        );
        await checkPerpComposition(perp, [collateralToken, curTranchesIn[0]], ["0", toFixedPtAmt("800")]);
      });

      describe("when balance covers just 1 token", function () {
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultComposition(
            vault,
            [collateralToken, newTranchesIn[1], reserveTranches[3]],
            [toFixedPtAmt("6600"), toFixedPtAmt("3200"), toFixedPtAmt("200")],
          );
          await checkPerpComposition(perp, [collateralToken, newTranchesIn[0]], ["0", toFixedPtAmt("800")]);
        });
      });

      describe("when balance covers just 1 token exactly", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.target, toFixedPtAmt("8500"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultComposition(
            vault,
            [collateralToken, reserveTranches[3], newTranchesIn[1]],
            [toFixedPtAmt("15100"), toFixedPtAmt("200"), toFixedPtAmt("3200")],
          );
          await checkPerpComposition(perp, [collateralToken, newTranchesIn[0]], ["0", toFixedPtAmt("800")]);
        });
      });
    });

    describe("when one trancheIn many tokenOut", function () {
      describe("when balance covers just 1 token", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.target, toFixedPtAmt("10"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultComposition(
            vault,
            [collateralToken, rolloverInTranches[1]],
            [toFixedPtAmt("2"), toFixedPtAmt("8")],
          );
          await checkPerpComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-3), rolloverInTranches[0]],
            [toFixedPtAmt("198"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("2")],
          );
        });
      });

      describe("when balance covers just 1 token exactly", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.target, toFixedPtAmt("1000"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultComposition(
            vault,
            [collateralToken, rolloverInTranches[1]],
            [toFixedPtAmt("200"), toFixedPtAmt("800")],
          );
          await checkPerpComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-3), rolloverInTranches[0]],
            ["0", toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
          );
        });
      });

      describe("when balance covers many tokens", function () {
        beforeEach(async function () {
          await collateralToken.transfer(vault.target, toFixedPtAmt("4000"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultComposition(
            vault,
            [collateralToken, reserveTranches[1], rolloverInTranches[1]],
            [toFixedPtAmt("2200"), toFixedPtAmt("200"), toFixedPtAmt("1600")],
          );
          await checkPerpComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-2), rolloverInTranches[0]],
            ["0", toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("400")],
          );
        });
      });
    });

    describe("when one trancheIn many tokenOut with different prices", function () {
      describe("when balance covers many tokens", async function () {
        beforeEach(async function () {
          await rebase(collateralToken, rebaseOracle, -0.9);
          await collateralToken.transfer(vault.target, toFixedPtAmt("600"));
        });
        it("should rollover", async function () {
          await expect(vault.deploy()).not.to.be.reverted;
          await checkVaultComposition(
            vault,
            [collateralToken, reserveTranches[1], rolloverInTranches[1]],
            [toFixedPtAmt("20"), toFixedPtAmt("200"), toFixedPtAmt("480")],
          );
          await checkPerpComposition(
            perp,
            [collateralToken, ...reserveTranches.slice(-2), rolloverInTranches[0]],
            ["0", toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("120")],
          );
        });
      });
    });

    describe("when rollover fee is +ve", function () {
      beforeEach(async function () {
        await feePolicy.mockMethod("computePerpRolloverFeePerc(uint256)", [toPercFixedPtAmt("0.01")]);
        await collateralToken.transfer(vault.target, toFixedPtAmt("1500"));
      });

      it("should rollover", async function () {
        await expect(vault.deploy()).not.to.be.reverted;
        await checkVaultComposition(
          vault,
          [collateralToken, reserveTranches[1], rolloverInTranches[1]],
          [toFixedPtAmt("200"), toFixedPtAmt("96.999999999999999999"), toFixedPtAmt("1200")],
        );
        await checkPerpComposition(
          perp,
          [collateralToken, reserveTranches[1], reserveTranches[2], reserveTranches[3], rolloverInTranches[0]],
          ["0", toFixedPtAmt("103.000000000000000001"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("300")],
        );
      });
    });

    describe("when rollover fee is -ve", function () {
      beforeEach(async function () {
        await feePolicy.mockMethod("computePerpRolloverFeePerc(uint256)", [toPercFixedPtAmt("-0.01")]);
        await collateralToken.transfer(vault.target, toFixedPtAmt("1500"));
      });

      it("should rollover", async function () {
        await expect(vault.deploy()).not.to.be.reverted;
        await checkVaultComposition(
          vault,
          [collateralToken, reserveTranches[1], rolloverInTranches[1]],
          [toFixedPtAmt("200"), toFixedPtAmt("102.999999999999999999"), toFixedPtAmt("1200")],
        );
        await checkPerpComposition(
          perp,
          [collateralToken, reserveTranches[1], reserveTranches[2], reserveTranches[3], rolloverInTranches[0]],
          ["0", toFixedPtAmt("97.000000000000000001"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("300")],
        );
      });
    });

    describe("typical deploy", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.9);
        await feePolicy.mockMethod("computePerpRolloverFeePerc(uint256)", [toPercFixedPtAmt("-0.01")]);
        await collateralToken.transfer(vault.target, toFixedPtAmt("1000"));
        txFn = () => vault.deploy();
      });

      it("should tranche and rollover", async function () {
        const tx = txFn();

        // Tranche
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(rolloverInTranches[0].target, toFixedPtAmt("200"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(rolloverInTranches[1].target, toFixedPtAmt("800"));

        // Rollover
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(reserveTranches[1].target, toFixedPtAmt("200"));

        // Recover
        await expect(tx)
          .to.emit(vault, "AssetSynced")
          .withArgs(rolloverInTranches[0].target, toFixedPtAmt("0.000000000000000118"));
        await expect(tx)
          .to.emit(vault, "AssetSynced")
          .withArgs(rolloverInTranches[1].target, toFixedPtAmt("475.247524752475248"));

        // Final
        await expect(tx)
          .to.emit(vault, "AssetSynced")
          .withArgs(collateralToken.target, toFixedPtAmt("425.940594059405940000"));
      });

      it("should update the list of deployed assets", async function () {
        await txFn();

        await checkVaultComposition(
          vault,
          [collateralToken, reserveTranches[1], rolloverInTranches[0], rolloverInTranches[1]],
          [
            toFixedPtAmt("425.940594059405940000"),
            toFixedPtAmt("200"),
            toFixedPtAmt("0.000000000000000118"),
            toFixedPtAmt("475.247524752475248"),
          ],
        );

        await checkPerpComposition(
          perp,
          [collateralToken, reserveTranches[2], reserveTranches[3], rolloverInTranches[0]],
          ["0", toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("118.811881188118811882")],
        );
      });
    });
  });

  describe("deploy limit", function () {
    async function setupDeployment() {
      const curBondIn = await bondAt(await perp.getDepositBond.staticCall());
      await advancePerpQueueToRollover(perp, curBondIn);
      await collateralToken.transfer(vault.target, toFixedPtAmt("10"));
    }

    beforeEach(async function () {
      for (let i = 0; i < 46; i++) {
        await setupDeployment();
        await vault.deploy();
      }
    });

    it("should revert after limit is reached", async function () {
      expect(await vault.assetCount()).to.eq(47);
      await setupDeployment();
      await expect(vault.deploy()).to.be.revertedWithCustomError(vault, "DeployedCountOverLimit");
    });
    it("redemption should be within gas limit", async function () {
      await collateralToken.approve(vault.target, toFixedPtAmt("10"));
      await vault.deposit(toFixedPtAmt("10"));
      await expect(vault.redeem(await vault.balanceOf(await deployer.getAddress()))).not.to.be.reverted;
    });

    it("recovery should be within gas limit", async function () {
      await expect(vault["recover()"]()).not.to.be.reverted;
    });
  });
});
