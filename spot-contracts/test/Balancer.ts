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
  toPercFixedPtAmt,
  getDepositBond,
  advancePerpQueue,
  advancePerpQueueToBondMaturity,
  checkReserveComposition,
  checkVaultAssetComposition,
} from "./helpers";
use(smock.matchers);

let vault: Contract;
let perp: Contract;
let bondFactory: Contract;
let collateralToken: Contract;
let rebaseOracle: Contract;
let issuer: Contract;
let feePolicy: Contract;
let balancer: Contract;
let deployer: Signer;
let reserveTranches: Contract[][] = [];
let remainingJuniorTranches: Contract[][] = [];
let currentBondIn: Contract;
let currentTranchesIn: Contract[];

describe("Balancer", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];

    bondFactory = await setupBondFactory();
    ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));
    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
    await issuer.init(4800, [500, 500], 1200, 0);

    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);

    const FeePolicy = await ethers.getContractFactory("FeePolicy");
    feePolicy = await FeePolicy.deploy();
    await feePolicy.init();
    await feePolicy.updateTargetSubscriptionRatio(toPercFixedPtAmt("1"));
    await feePolicy.updateVaultUnderlyingToPerpSwapFeePerc("0");
    await feePolicy.updateVaultPerpToUnderlyingSwapFeePerc("0");

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
    await collateralToken.approve(vault.address, toFixedPtAmt("1"));
    await vault.init("RolloverVault", "VSHARE", perp.address, feePolicy.address);
    await perp.updateVault(vault.address);

    reserveTranches = [];
    remainingJuniorTranches = [];
    for (let i = 0; i < 4; i++) {
      const bond = await getDepositBond(perp);
      const tranches = await getTranches(bond);
      reserveTranches.push(tranches[0]);
      remainingJuniorTranches.push(tranches[1]);
      if (i === 0) {
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("500"));
      }
      await collateralToken.approve(vault.address, toFixedPtAmt("2000"));
      await vault.deposit(toFixedPtAmt("1100"));
      await vault.swapUnderlyingForPerps(toFixedPtAmt("500"));
      await advancePerpQueue(perp, 1200);
    }

    await checkReserveComposition(
      perp,
      [collateralToken, ...reserveTranches.slice(-3)],
      [toFixedPtAmt("1000"), toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("500")],
    );

    await vault["recover()"]();
    await checkVaultAssetComposition(
      vault,
      [collateralToken, ...remainingJuniorTranches.slice(-3)],
      [toFixedPtAmt("2900"), toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("500")],
    );

    const Balancer = await ethers.getContractFactory("Balancer");
    balancer = await Balancer.deploy();

    await perp.updateBalancer(balancer.address);
    await vault.updateBalancer(balancer.address);

    currentBondIn = await bondAt(await perp.callStatic.getDepositBond());
    currentTranchesIn = await getTranches(currentBondIn);
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("deposit2", function () {
    beforeEach(async function () {
      await collateralToken.approve(balancer.address, toFixedPtAmt("1000"));
    });

    describe("when dr > 1", function () {
      let txFn: Promise<Transaction>, r: any;
      beforeEach(async function () {
        expect(
          await feePolicy["computeDeviationRatio(uint256,uint256,uint256)"](
            await perp.callStatic.getTVL(),
            await vault.callStatic.getTVL(),
            500,
          ),
        ).to.eq(toPercFixedPtAmt("1.76"));
        r = await balancer.callStatic.deposit2(perp.address, toFixedPtAmt("1000"));
        txFn = balancer.deposit2(perp.address, toFixedPtAmt("1000"));
      });
      it("should return minted amounts", async function () {
        expect(r.perpAmt).to.eq(toFixedPtAmt("500"));
        expect(r.noteAmt).to.eq(toFixedPtAmt("500000000"));
      });
      it("should mint perps", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("500")]);
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [toFixedPtAmt("1000"), toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
      });
      it("should mint notes", async function () {
        await expect(txFn).to.changeTokenBalances(vault, [deployer], [toFixedPtAmt("500000000")]);
        await checkVaultAssetComposition(
          vault,
          [collateralToken, ...remainingJuniorTranches.slice(-4), currentTranchesIn[1]],
          [
            toFixedPtAmt("2400"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
          ],
        );
      });
      it("should transfer underlying form user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("-1000")]);
      });
      it("should leave no dust", async function () {
        await txFn;
        expect(await collateralToken.balanceOf(balancer.address)).to.eq("0");
        expect(await perp.balanceOf(balancer.address)).to.eq("0");
        expect(await vault.balanceOf(balancer.address)).to.eq("0");
      });
      it("should decrease dr", async function () {
        await txFn;
        expect(
          await feePolicy["computeDeviationRatio(uint256,uint256,uint256)"](
            await perp.callStatic.getTVL(),
            await vault.callStatic.getTVL(),
            500,
          ),
        ).to.eq(toPercFixedPtAmt("1.63333333"));
      });
    });

    describe("when dr = 1", function () {
      let txFn: Promise<Transaction>, r: any;
      beforeEach(async function () {
        await feePolicy.updateTargetSubscriptionRatio(toPercFixedPtAmt("1.76"));
        expect(
          await feePolicy["computeDeviationRatio(uint256,uint256,uint256)"](
            await perp.callStatic.getTVL(),
            await vault.callStatic.getTVL(),
            500,
          ),
        ).to.eq(toPercFixedPtAmt("1"));
        r = await balancer.callStatic.deposit2(perp.address, toFixedPtAmt("1000"));
        txFn = balancer.deposit2(perp.address, toFixedPtAmt("1000"));
      });
      it("should return minted amounts", async function () {
        expect(r.perpAmt).to.eq(toFixedPtAmt("362.31884"));
        expect(r.noteAmt).to.eq(toFixedPtAmt("637681160"));
      });
      it("should mint perps", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("362.31884")]);
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            toFixedPtAmt("1000"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("362.31884"),
          ],
        );
      });
      it("should mint notes", async function () {
        await expect(txFn).to.changeTokenBalances(vault, [deployer], [toFixedPtAmt("637681160")]);
        await checkVaultAssetComposition(
          vault,
          [collateralToken, ...remainingJuniorTranches.slice(-4), currentTranchesIn[1]],
          [
            toFixedPtAmt("2675.36232"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("362.31884"),
          ],
        );
      });
      it("should transfer underlying form user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("-1000")]);
      });
      it("should leave no dust", async function () {
        await txFn;
        expect(await collateralToken.balanceOf(balancer.address)).to.eq("0");
        expect(await perp.balanceOf(balancer.address)).to.eq("0");
        expect(await vault.balanceOf(balancer.address)).to.eq("0");
      });
      it("should not change dr", async function () {
        await txFn;
        expect(
          await feePolicy["computeDeviationRatio(uint256,uint256,uint256)"](
            await perp.callStatic.getTVL(),
            await vault.callStatic.getTVL(),
            500,
          ),
        ).to.eq(toPercFixedPtAmt("1"));
      });
    });

    describe("when dr < 1", function () {
      let txFn: Promise<Transaction>, r: any;
      beforeEach(async function () {
        await feePolicy.updateTargetSubscriptionRatio(toPercFixedPtAmt("2"));
        expect(
          await feePolicy["computeDeviationRatio(uint256,uint256,uint256)"](
            await perp.callStatic.getTVL(),
            await vault.callStatic.getTVL(),
            500,
          ),
        ).to.eq(toPercFixedPtAmt("0.88"));
        r = await balancer.callStatic.deposit2(perp.address, toFixedPtAmt("1000"));
        txFn = balancer.deposit2(perp.address, toFixedPtAmt("1000"));
      });
      it("should return minted amounts", async function () {
        expect(r.perpAmt).to.eq(toFixedPtAmt("333.33333"));
        expect(r.noteAmt).to.eq(toFixedPtAmt("666666670"));
      });
      it("should mint perps", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("333.33333")]);
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            toFixedPtAmt("1000"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("333.33333"),
          ],
        );
      });
      it("should mint notes", async function () {
        await expect(txFn).to.changeTokenBalances(vault, [deployer], [toFixedPtAmt("666666670")]);
        await checkVaultAssetComposition(
          vault,
          [collateralToken, ...remainingJuniorTranches.slice(-4), currentTranchesIn[1]],
          [
            toFixedPtAmt("2733.33334"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("500"),
            toFixedPtAmt("333.33333"),
          ],
        );
      });
      it("should transfer underlying form user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("-1000")]);
      });
      it("should leave no dust", async function () {
        await txFn;
        expect(await collateralToken.balanceOf(balancer.address)).to.eq("0");
        expect(await perp.balanceOf(balancer.address)).to.eq("0");
        expect(await vault.balanceOf(balancer.address)).to.eq("0");
      });
      it("should increase dr", async function () {
        await txFn;
        expect(
          await feePolicy["computeDeviationRatio(uint256,uint256,uint256)"](
            await perp.callStatic.getTVL(),
            await vault.callStatic.getTVL(),
            500,
          ),
        ).to.eq(toPercFixedPtAmt("0.89411764"));
      });
    });
  });

  describe("redeem2", function () {
    beforeEach(async function () {
      await perp.approve(balancer.address, toFixedPtAmt("500"));
      await vault.approve(balancer.address, toFixedPtAmt("500000000"));
    });

    describe("when using exact ratios", async function () {
      let txFn: Promise<Transaction>, r: any;
      beforeEach(async function () {
        r = await balancer.callStatic.redeem2(perp.address, {
          perpAmt: toFixedPtAmt("250"),
          noteAmt: toFixedPtAmt("440000000"),
        });
        txFn = balancer.redeem2(perp.address, { perpAmt: toFixedPtAmt("250"), noteAmt: toFixedPtAmt("440000000") });
      });
      it("should return burnt amounts", async function () {
        expect(r[0].perpAmt).to.eq(toFixedPtAmt("250"));
        expect(r[0].noteAmt).to.eq(toFixedPtAmt("440000000"));
      });
      it("should return tokens returned", async function () {
        expect(r[1][0].token).to.eq(collateralToken.address);
        expect(r[1][0].amount).to.eq(toFixedPtAmt("690"));
      });
      it("should burn perps", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-250")]);
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3)],
          [toFixedPtAmt("900"), toFixedPtAmt("450"), toFixedPtAmt("450"), toFixedPtAmt("450")],
        );
      });
      it("should burn notes", async function () {
        await expect(txFn).to.changeTokenBalances(vault, [deployer], [toFixedPtAmt("-440000000")]);
        await checkVaultAssetComposition(
          vault,
          [collateralToken, ...remainingJuniorTranches.slice(-3)],
          [toFixedPtAmt("2610"), toFixedPtAmt("450"), toFixedPtAmt("450"), toFixedPtAmt("450")],
        );
      });
      it("should transfer underlying to the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("690")]);
      });
      it("should leave no dust", async function () {
        await txFn;
        expect(await collateralToken.balanceOf(balancer.address)).to.eq("0");
        expect(await perp.balanceOf(balancer.address)).to.eq("0");
        expect(await vault.balanceOf(balancer.address)).to.eq("0");
        expect(await reserveTranches[0].balanceOf(balancer.address)).to.eq("0");
        expect(await reserveTranches[1].balanceOf(balancer.address)).to.eq("0");
        expect(await reserveTranches[2].balanceOf(balancer.address)).to.eq("0");
        expect(await reserveTranches[3].balanceOf(balancer.address)).to.eq("0");
        expect(await remainingJuniorTranches[0].balanceOf(balancer.address)).to.eq("0");
        expect(await remainingJuniorTranches[1].balanceOf(balancer.address)).to.eq("0");
        expect(await remainingJuniorTranches[2].balanceOf(balancer.address)).to.eq("0");
        expect(await remainingJuniorTranches[3].balanceOf(balancer.address)).to.eq("0");
      });
    });

    // when ratios are not exact
    // when dust remains
    // quick dr checks?
  });
});
