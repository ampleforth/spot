import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { constants, Contract, Signer } from "ethers";
import { smock } from "@defi-wonderland/smock";
import {
  setupCollateralToken,
  setupBondFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toPriceFixedPtAmt,
  toPercFixedPtAmt,
  advancePerpQueue,
  mintCollteralToken,
  advancePerpQueueToRollover,
  checkReserveComposition,
} from "./helpers";
use(smock.matchers);

let perp: Contract,
  bondFactory: Contract,
  collateralToken: Contract,
  issuer: Contract,
  feeStrategy: Contract,
  pricingStrategy: Contract,
  deployer: Signer,
  deployerAddress: string,
  router: Contract,
  depositBond: Contract,
  depositTranches: Contract[];

describe("RouterV2", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    deployerAddress = await deployer.getAddress();

    bondFactory = await setupBondFactory();
    ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));

    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
    await issuer.init(3600, [200, 300, 500], 1200, 0);

    const FeeStrategy = await ethers.getContractFactory("FeeStrategy");
    feeStrategy = await smock.fake(FeeStrategy);
    await feeStrategy.computeRolloverFeePerc.returns(toPercFixedPtAmt("0"));
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
    await perp.updateTolerableTrancheMaturity(600, 3600);
    await advancePerpQueue(perp, 3600);

    depositBond = await bondAt(await perp.callStatic.getDepositBond());
    depositTranches = await getTranches(depositBond);

    const Router = await ethers.getContractFactory("RouterV2");
    router = await Router.deploy();
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#previewTranche", function () {
    it("should compute the tranche amounts", async function () {
      const r = await router.callStatic.previewTranche(perp.address, toFixedPtAmt("1000"));
      expect(r[0]).to.eq(await perp.callStatic.getDepositBond());
      expect(r[1][0]).to.eq(depositTranches[0].address);
      expect(r[1][1]).to.eq(depositTranches[1].address);
      expect(r[1][2]).to.eq(depositTranches[2].address);
      expect(r[2][0]).to.eq(toFixedPtAmt("200"));
      expect(r[2][1]).to.eq(toFixedPtAmt("300"));
      expect(r[2][2]).to.eq(toFixedPtAmt("500"));
    });
  });

  describe("#trancheAndDeposit", function () {
    beforeEach(async function () {
      await mintCollteralToken(collateralToken, toFixedPtAmt("2000"), deployer);
    });

    describe("when deposit bond is incorrect", function () {
      beforeEach(async function () {
        await collateralToken.approve(router.address, constants.MaxUint256);
        await advancePerpQueue(perp, 7200);
      });
      it("should revert", async function () {
        await expect(
          router.trancheAndDeposit(perp.address, depositBond.address, toFixedPtAmt("1000")),
        ).to.revertedWithCustomError(perp, "UnacceptableDepositTranche");
      });
    });

    describe("when deposit bond is correct", function () {
      beforeEach(async function () {
        await collateralToken.approve(router.address, constants.MaxUint256);
        await router.trancheAndDeposit(perp.address, depositBond.address, toFixedPtAmt("1000"));
      });

      it("should mint tranches", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("200"));
      });

      it("should transfer unused tranches back", async function () {
        expect(await depositTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("300"));
        expect(await depositTranches[2].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("500"));
      });

      it("should leave no dust", async function () {
        expect(await depositTranches[0].balanceOf(router.address)).to.eq("0");
        expect(await depositTranches[1].balanceOf(router.address)).to.eq("0");
        expect(await perp.balanceOf(router.address)).to.eq("0");
      });
    });
  });

  describe("#trancheAndRollover", function () {
    let reserveTranches1: Contract[], reserveTranches2: Contract[], depositBond: Contract, depositTranches: Contract[];
    beforeEach(async function () {
      const reserveBond1 = await bondAt(await perp.callStatic.getDepositBond());
      reserveTranches1 = await getTranches(reserveBond1);
      await depositIntoBond(reserveBond1, toFixedPtAmt("1000"), deployer);

      await reserveTranches1[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(reserveTranches1[0].address, toFixedPtAmt("200"));

      await advancePerpQueue(perp, 7200);

      const reserveBond2 = await bondAt(await perp.callStatic.getDepositBond());
      reserveTranches2 = await getTranches(reserveBond2);
      await depositIntoBond(reserveBond2, toFixedPtAmt("1000"), deployer);

      await reserveTranches2[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(reserveTranches2[0].address, toFixedPtAmt("200"));

      await advancePerpQueueToRollover(perp, reserveBond2);

      depositBond = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches = await getTranches(depositBond);
    });

    describe("successful tranche & rollover and return the remainder", function () {
      beforeEach(async function () {
        await feeStrategy.computeRolloverFeePerc.returns(toPercFixedPtAmt("-0.01"), "0");
        await perp.approve(router.address, toFixedPtAmt("15"));

        await mintCollteralToken(collateralToken, toFixedPtAmt("2001"), deployer);
        await collateralToken.transfer(router.address, toFixedPtAmt("1"));
        await collateralToken.approve(router.address, toFixedPtAmt("2000"));

        expect(await collateralToken.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("2000"));
        expect(await reserveTranches2[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[2].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        await router.trancheAndRollover(perp.address, depositBond.address, toFixedPtAmt("2000"), [
          [depositTranches[0].address, collateralToken.address, toFixedPtAmt("125")],
          [depositTranches[0].address, reserveTranches2[0].address, toFixedPtAmt("75")],
        ]);
      });

      it("should transfer tranches out", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranches2[0], depositTranches[0]],
          [toFixedPtAmt("73.75"), toFixedPtAmt("124.25"), toFixedPtAmt("200")],
        );
        expect(await collateralToken.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("127.25"));
        expect(await reserveTranches2[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("75.75"));
        expect(await depositTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("200"));
        expect(await depositTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("600"));
        expect(await depositTranches[2].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("1000"));
      });

      it("should not change the perp balance", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("400"));
      });

      it("should leave no dust", async function () {
        expect(await collateralToken.balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await perp.balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("successful tranche & rollover and return the remainder (with no fees)", function () {
      beforeEach(async function () {
        await feeStrategy.computeRolloverFeePerc.returns("0", "0");

        await mintCollteralToken(collateralToken, toFixedPtAmt("2001"), deployer);
        await collateralToken.transfer(router.address, toFixedPtAmt("1"));
        await collateralToken.approve(router.address, toFixedPtAmt("2000"));

        expect(await collateralToken.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("2000"));
        expect(await reserveTranches2[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[2].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        await router.trancheAndRollover(perp.address, depositBond.address, toFixedPtAmt("2000"), [
          [depositTranches[0].address, collateralToken.address, toFixedPtAmt("200")],
          [depositTranches[0].address, reserveTranches2[0].address, toFixedPtAmt("100")],
        ]);
      });

      it("should transfer tranches out", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranches2[0], depositTranches[0]],
          [toFixedPtAmt("0"), toFixedPtAmt("100"), toFixedPtAmt("300")],
        );
        expect(await collateralToken.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("201"));
        expect(await reserveTranches2[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("100"));
        expect(await depositTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("100"));
        expect(await depositTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("600"));
        expect(await depositTranches[2].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("1000"));
      });

      it("should not change the perp balance", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("400"));
      });

      it("should leave no dust", async function () {
        expect(await collateralToken.balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await perp.balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
      });
    });
  });
});
