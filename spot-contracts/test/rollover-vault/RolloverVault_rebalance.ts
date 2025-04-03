import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";

import {
  setupCollateralToken,
  mintCollteralToken,
  setupBondFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  getDepositBond,
  advancePerpQueue,
  advancePerpQueueToBondMaturity,
  checkPerpComposition,
  checkVaultComposition,
  DMock,
  toPercFixedPtAmt,
  TimeHelpers,
} from "../helpers";

let vault: Contract;
let perp: Contract;
let bondFactory: Contract;
let collateralToken: Contract;
let issuer: Contract;
let feePolicy: Contract;
let deployer: Signer;
let reserveSrTranches: Contract[][] = [];
const reserveJrTranches: Contract[][] = [];

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
      [bondFactory.target, collateralToken.target, 4 * 86400, [200, 800], 86400, 0],
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

    await perp.updateTolerableTrancheMaturity(86400, 4 * 86400);
    await advancePerpQueueToBondMaturity(perp, await getDepositBond(perp));

    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    vault = await upgrades.deployProxy(RolloverVault.connect(deployer));
    await vault.init("RolloverVault", "VSHARE", perp.target, feePolicy.target);
    await perp.updateVault(vault.target);

    reserveSrTranches = [];
    for (let i = 0; i < 4; i++) {
      const bond = await getDepositBond(perp);
      const tranches = await getTranches(bond);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);

      await tranches[0].approve(perp.target, toFixedPtAmt("200"));
      await perp.deposit(tranches[0].target, toFixedPtAmt("200"));

      reserveSrTranches.push(tranches[0]);
      reserveJrTranches.push(tranches[1]);
      await advancePerpQueue(perp, 86400);
    }

    await checkPerpComposition(
      perp,
      [collateralToken, ...reserveSrTranches.slice(-3)],
      [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
    );

    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
    await collateralToken.approve(vault.target, toFixedPtAmt("100000"));
    const currentBondIn = await bondAt(await perp.getDepositBond.staticCall());
    const currentTranchesIn = await getTranches(currentBondIn);
    await vault.deposit(toFixedPtAmt("2000"));
    await vault.deploy();

    await checkVaultComposition(
      vault,
      [collateralToken, reserveSrTranches[1], currentTranchesIn[1]],
      [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("1600")],
    );
    expect(await vault.assetCount()).to.eq(3);
    await TimeHelpers.increaseTime(86401);

    await feePolicy.mockMethod("computeRebalanceData((uint256,uint256,uint256))", [[0n, 0n]]);
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#rebalance()", function () {
    describe("when system is paused", function () {
      it("should revert", async function () {
        await vault.pause();
        await expect(vault.rebalance()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when rebalance is paused", function () {
      it("should revert", async function () {
        await vault.pauseRebalance();
        await expect(vault.rebalance()).to.be.revertedWithCustomError(vault, "LastRebalanceTooRecent");
      });
    });

    describe("when invoked too soon", function () {
      it("should revert", async function () {
        await vault.rebalance();
        await expect(vault.rebalance()).to.be.revertedWithCustomError(vault, "LastRebalanceTooRecent");
        await TimeHelpers.increaseTime(86401);
        await expect(vault.rebalance()).to.not.be.reverted;
      });
    });

    describe("perp debasement", function () {
      beforeEach(async function () {
        await feePolicy.mockMethod("computeRebalanceData((uint256,uint256,uint256))", [[toFixedPtAmt("-10"), 0n]]);
      });
      it("should transfer value to the vault (by minting and melding perps)", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("800"));
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("2000"));
        await expect(() => vault.rebalance()).to.changeTokenBalances(perp, [vault], [toFixedPtAmt("0")]);
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("790.123456790123456792"));
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("2009.876543209876543204"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
      });
      it("should update the vault balance (after melding)", async function () {
        await expect(() => vault.rebalance()).to.changeTokenBalances(
          collateralToken,
          [vault],
          [toFixedPtAmt("24.691358024691358")],
        );
      });
      it("should sync token balances", async function () {
        const tx = vault.rebalance();
        await expect(tx)
          .to.emit(vault, "AssetSynced")
          .withArgs(collateralToken.target, toFixedPtAmt("224.691358024691358"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(perp.target, toFixedPtAmt("0"));
      });
    });

    describe("perp debasement with protocol fee", function () {
      beforeEach(async function () {
        await feePolicy.mockMethod("computeRebalanceData((uint256,uint256,uint256))", [
          [toFixedPtAmt("-9"), toFixedPtAmt("1")],
        ]);
      });
      it("should transfer value to the vault (by minting and melding perps)", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("800"));
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("2000"));
        await expect(() => vault.rebalance()).to.changeTokenBalances(perp, [vault], [toFixedPtAmt("0")]);
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("790.123456790123456792"));
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("2008.876543209876543204"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
      });
      it("should pay the protocol fee", async function () {
        await expect(() => vault.rebalance()).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("1")]);
      });
      it("should update the vault balance (after melding)", async function () {
        await expect(() => vault.rebalance()).to.changeTokenBalances(
          collateralToken,
          [vault],
          [toFixedPtAmt("23.691358024691358")],
        );
      });
      it("should sync token balances", async function () {
        const tx = vault.rebalance();
        await expect(tx)
          .to.emit(vault, "AssetSynced")
          .withArgs(collateralToken.target, toFixedPtAmt("223.691358024691358"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(perp.target, toFixedPtAmt("0"));
      });
    });

    describe("perp enrichment", function () {
      beforeEach(async function () {
        await feePolicy.mockMethod("computeRebalanceData((uint256,uint256,uint256))", [[toFixedPtAmt("25"), 0n]]);
      });
      it("should transfer collateral tokens from vault to perp", async function () {
        await expect(() => vault.rebalance()).to.changeTokenBalances(
          collateralToken,
          [vault, perp],
          [toFixedPtAmt("-25"), toFixedPtAmt("25")],
        );
      });
      it("should not change perp supply", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await vault.rebalance();
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
      });
      it("should sync token balances", async function () {
        const tx = vault.rebalance();
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("175"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(perp.target, toFixedPtAmt("0"));
        await expect(tx).to.emit(perp, "ReserveSynced").withArgs(collateralToken.target, toFixedPtAmt("25"));
      });
    });

    describe("perp enrichment with protocol fee", function () {
      beforeEach(async function () {
        await feePolicy.mockMethod("computeRebalanceData((uint256,uint256,uint256))", [
          [toFixedPtAmt("20"), toFixedPtAmt("5")],
        ]);
      });
      it("should transfer collateral tokens from vault to perp", async function () {
        await expect(() => vault.rebalance()).to.changeTokenBalances(
          collateralToken,
          [vault, perp, deployer],
          [toFixedPtAmt("-25"), toFixedPtAmt("20"), toFixedPtAmt("5")],
        );
      });
      it("should pay the protocol fee", async function () {
        await expect(() => vault.rebalance()).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("5")]);
      });
      it("should not change perp supply", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await vault.rebalance();
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
      });
      it("should sync token balances", async function () {
        const tx = vault.rebalance();
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("175"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(perp.target, toFixedPtAmt("0"));
        await expect(tx).to.emit(perp, "ReserveSynced").withArgs(collateralToken.target, toFixedPtAmt("20"));
      });
    });
  });
});
