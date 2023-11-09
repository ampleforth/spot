import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer, Transaction, BigNumber } from "ethers";
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
  toPercFixedPtAmt,
  getDepositBond,
  advancePerpQueue,
  advancePerpQueueToBondMaturity,
  checkReserveComposition,
  checkVaultAssetComposition,
  timeToMaturity,
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
let deployer: Signer;
let reserveTranches: Contract[][] = [];
let rolloverInBond: Contract;
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

    const FeeStrategy = await ethers.getContractFactory("FeeStrategy");
    feeStrategy = await smock.fake(FeeStrategy);
    await feeStrategy.decimals.returns(8);

    const PricingStrategy = await ethers.getContractFactory("CDRPricingStrategy");
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

    await advancePerpQueueToBondMaturity(perp, rolloverInBond);
    currentBondIn = await bondAt(await perp.callStatic.getDepositBond());
    currentTranchesIn = await getTranches(currentBondIn);

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
    await vault.updateMaxUndeployedPerc(toPercFixedPtAmt("1"));

    await collateralToken.approve(vault.address, toFixedPtAmt("1000"));
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#swap()", function () {
    describe("when requested tranche is not part of the deployed set", function () {
      let tranches: Contract[];
      beforeEach(async function () {
        const newBond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 4800);
        await depositIntoBond(newBond, toFixedPtAmt("100"), deployer);
        tranches = await getTranches(newBond);
      });
      it("should be reverted", async function () {
        await expect(vault.swap(tranches[0].address, toFixedPtAmt("20"))).to.be.revertedWith("UnexpectedAsset");
      });
    });

    describe("when the user sends no tokens", function () {
      it("should be reverted", async function () {
        await expect(vault.swap(currentTranchesIn[1].address, toFixedPtAmt("0"))).to.be.reverted;
      });
    });

    describe("when the user has insufficient approvals", function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.address, toFixedPtAmt("10"));
      });
      it("should be reverted", async function () {
        await expect(vault.swap(currentTranchesIn[1].address, toFixedPtAmt("20"))).to.be.reverted;
      });
    });

    describe("when the user has insufficient balance", function () {
      beforeEach(async function () {
        await collateralToken.transfer(vault.address, await collateralToken.balanceOf(await deployer.getAddress()));
      });
      it("should be reverted", async function () {
        await expect(vault.swap(currentTranchesIn[1].address, toFixedPtAmt("20"))).to.be.reverted;
      });
    });

    describe("when vault has no tranches (after recovery)", function () {
      beforeEach(async function () {
        await depositIntoBond(currentBondIn, toFixedPtAmt("1000"), deployer);
        await currentTranchesIn[0].transfer(vault.address, toFixedPtAmt("200"));
      });
      it("should be reverted", async function () {
        await expect(vault.swap(currentTranchesIn[1].address, toFixedPtAmt("0"))).to.be.revertedWith("ValuelessAssets");
      });
    });

    describe("when the bond is mature", function () {
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, currentBondIn);
      });
      it("should be reverted", async function () {
        await expect(vault.swap(currentTranchesIn[1].address, toFixedPtAmt("0"))).to.be.revertedWith("ValuelessAssets");
      });
    });

    describe("when fee is zero", async function () {
      beforeEach(async function () {
        await vault.updateFees([
          toPercFixedPtAmt("0"),
          toPercFixedPtAmt("0"),
          toPercFixedPtAmt("0"),
          toPercFixedPtAmt("0"),
          "0",
        ]);
      });

      describe("when the user swaps tranches", function () {
        let txFn: () => Promise<Transaction>;
        beforeEach(async function () {
          txFn = () => vault.swap(currentTranchesIn[1].address, toFixedPtAmt("15"));
        });
        it("should transfer underlying from the user to the vault", async function () {
          await expect(txFn).to.changeTokenBalances(
            collateralToken,
            [deployer, vault],
            [toFixedPtAmt("-15"), toFixedPtAmt("15")],
          );
        });

        it("should transfer tranches from the vault to the user", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[1],
            [deployer, vault],
            [toFixedPtAmt("15"), toFixedPtAmt("-15")],
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

      describe("when the user sends more tokens than required (only uses whats required)", function () {
        let txFn: () => Promise<Transaction>;
        beforeEach(async function () {
          txFn = () => vault.swap(currentTranchesIn[1].address, toFixedPtAmt("1000"));
        });
        it("should transfer underlying from the user to the vault", async function () {
          await expect(txFn).to.changeTokenBalances(
            collateralToken,
            [deployer, vault],
            [toFixedPtAmt("-300"), toFixedPtAmt("300")],
          );
        });

        it("should transfer tranches from the vault to the user", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[1],
            [deployer, vault],
            [toFixedPtAmt("300"), toFixedPtAmt("-300")],
          );
        });

        it("should update vault balances", async function () {
          await txFn();
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[2], perp],
            [toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("0")],
          );
        });

        it("should sync balances", async function () {
          const tx: Transaction = await txFn();
          await tx.wait();
          await expect(tx)
            .to.emit(vault, "AssetSynced")
            .withArgs(collateralToken.address, toFixedPtAmt("500"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[1].address, toFixedPtAmt("0"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[2].address, toFixedPtAmt("500"));
        });
      });

      describe("when the user swaps tranches which are over-collateralized", function () {
        let txFn: () => Promise<Transaction>;
        beforeEach(async function () {
          await rebase(collateralToken, rebaseOracle, +1);
          txFn = () => vault.swap(currentTranchesIn[2].address, toFixedPtAmt("15"));
        });
        it("should transfer underlying from the user to the vault", async function () {
          await expect(txFn).to.changeTokenBalances(
            collateralToken,
            [deployer, vault],
            [toFixedPtAmt("-15"), toFixedPtAmt("15")],
          );
        });

        it("should transfer tranches from the vault to the user", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[2],
            [deployer, vault],
            [toFixedPtAmt("5"), toFixedPtAmt("-5")],
          );
        });

        it("should update vault balances", async function () {
          await txFn();
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("415"), toFixedPtAmt("300"), toFixedPtAmt("495"), toFixedPtAmt("0")],
          );
        });
        it("should sync balances", async function () {
          const tx: Transaction = await txFn();
          await tx.wait();
          await expect(tx)
            .to.emit(vault, "AssetSynced")
            .withArgs(collateralToken.address, toFixedPtAmt("415"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[1].address, toFixedPtAmt("300"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[2].address, toFixedPtAmt("495"));
        });
      });

      describe("when the user swaps tranches which are under-collateralized", function () {
        let txFn: () => Promise<Transaction>;
        beforeEach(async function () {
          await rebase(collateralToken, rebaseOracle, -0.1);
          txFn = () => vault.swap(currentTranchesIn[2].address, toFixedPtAmt("10"));
        });
        it("should transfer underlying from the user to the vault", async function () {
          await expect(txFn).to.changeTokenBalances(
            collateralToken,
            [deployer, vault],
            [toFixedPtAmt("-10"), toFixedPtAmt("10")],
          );
        });

        it("should transfer tranches from the vault to the user", async function () {
          await expect(txFn).to.changeTokenBalances(
            currentTranchesIn[2],
            [deployer, vault],
            [toFixedPtAmt("12.5"), toFixedPtAmt("-12.5")],
          );
        });

        it("should update vault balances", async function () {
          await txFn();
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
            [toFixedPtAmt("190"), toFixedPtAmt("300"), toFixedPtAmt("487.5"), toFixedPtAmt("0")],
          );
        });
        it("should sync balances", async function () {
          const tx: Transaction = await txFn();
          await tx.wait();
          await expect(tx)
            .to.emit(vault, "AssetSynced")
            .withArgs(collateralToken.address, toFixedPtAmt("190"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[1].address, toFixedPtAmt("300"))
            .to.emit(vault, "AssetSynced")
            .withArgs(currentTranchesIn[2].address, toFixedPtAmt("487.5"));
        });
      });
    });

    describe("with a fee", async function () {
      let txFn: () => Promise<Transaction>, tranchesReturned: BigNumber;
      beforeEach(async function () {
        await vault.updateFees([toPercFixedPtAmt("0"), toPercFixedPtAmt("0"), toPercFixedPtAmt("0.05"), "0"]);
        await TimeHelpers.increaseTime(parseInt((await timeToMaturity(currentBondIn)) / 2));
        tranchesReturned = await vault.callStatic.swap(currentTranchesIn[1].address, toFixedPtAmt("10"));
        txFn = () => vault.swap(currentTranchesIn[1].address, toFixedPtAmt("10"));
      });

      it("should transfer underlying from the user to the vault", async function () {
        await expect(txFn).to.changeTokenBalances(
          collateralToken,
          [deployer, vault],
          [toFixedPtAmt("-10"), toFixedPtAmt("10")],
        );
      });

      it("should transfer tranches from the vault to the user", async function () {
        const _deployerBal = await currentTranchesIn[1].balanceOf(await deployer.getAddress());
        await txFn();
        const deployerBal = await currentTranchesIn[1].balanceOf(await deployer.getAddress());
        expect(deployerBal.sub(_deployerBal)).to.gte(toFixedPtAmt("9.750")).lt(toFixedPtAmt("9.751"));
      });

      it("should deduct fee", async function () {
        expect(tranchesReturned).to.gte(toFixedPtAmt("9.750")).lt(toFixedPtAmt("9.751"));
      });

      it("should update vault balances", async function () {
        const _deployerBal = await currentTranchesIn[1].balanceOf(await deployer.getAddress());
        await txFn();
        const deployerBal = await currentTranchesIn[1].balanceOf(await deployer.getAddress());
        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], currentTranchesIn[2], perp],
          [
            toFixedPtAmt("210"),
            toFixedPtAmt("300").sub(deployerBal).add(_deployerBal),
            toFixedPtAmt("500"),
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
          .withArgs(collateralToken.address, toFixedPtAmt("210"))
          .to.emit(vault, "AssetSynced")
          .withArgs(currentTranchesIn[1].address, toFixedPtAmt("300").sub(deployerBal).add(_deployerBal))
          .to.emit(vault, "AssetSynced")
          .withArgs(currentTranchesIn[2].address, toFixedPtAmt("500"));
      });
    });

    describe("with a fee and when the user sends more tokens than required", function () {
      let txFn: () => Promise<Transaction>;
      beforeEach(async function () {
        await vault.updateFees([toPercFixedPtAmt("0"), toPercFixedPtAmt("0"), toPercFixedPtAmt("0.05"), "0"]);
        await TimeHelpers.increaseTime(parseInt((await timeToMaturity(currentBondIn)) / 2));
        txFn = () => vault.swap(currentTranchesIn[1].address, toFixedPtAmt("1000"));
      });

      it("should transfer underlying from the user to the vault", async function () {
        await expect(txFn).to.changeTokenBalances(
          collateralToken,
          [deployer, vault],
          [toFixedPtAmt("-307.672575624457643758"), toFixedPtAmt("307.672575624457643758")],
        );
      });

      it("should transfer tranches from the vault to the user", async function () {
        await expect(txFn).to.changeTokenBalances(
          currentTranchesIn[1],
          [deployer, vault],
          [toFixedPtAmt("300"), toFixedPtAmt("-300")],
        );
      });

      it("should update vault balances", async function () {
        await txFn();
        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[2], perp],
          [toFixedPtAmt("507.672575624457643758"), toFixedPtAmt("500"), toFixedPtAmt("0")],
        );
      });

      it("should sync balances", async function () {
        const tx: Transaction = await txFn();
        await tx.wait();
        await expect(tx)
          .to.emit(vault, "AssetSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("500"))
          .to.emit(vault, "AssetSynced")
          .withArgs(currentTranchesIn[1].address, toFixedPtAmt("0"))
          .to.emit(vault, "AssetSynced")
          .withArgs(currentTranchesIn[2].address, toFixedPtAmt("500"));
      });
    });

    describe("underlyingPerc", async function () {
      beforeEach(async function () {
        await vault.updateMaxUndeployedPerc(toPercFixedPtAmt("0.225"));
      });
      describe("when swap goes over", function () {
        it("should revert", async function () {
          await expect(vault.swap(currentTranchesIn[1].address, toFixedPtAmt("26"))).to.be.revertedWith(
            "UndeployedPercOverLimit",
          );
        });
      });
      describe("when swap stays under", function () {
        it("should not revert", async function () {
          await expect(vault.swap(currentTranchesIn[1].address, toFixedPtAmt("25"))).not.to.be.reverted;
        });
      });
    });
  });
});
