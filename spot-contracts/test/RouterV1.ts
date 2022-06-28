import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { constants, Contract, Signer } from "ethers";

import {
  setupCollateralToken,
  setupBondFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toYieldFixedPtAmt,
  toPriceFixedPtAmt,
  advancePerpQueue,
  mintCollteralToken,
  advancePerpQueueToRollover,
} from "./helpers";

let perp: Contract,
  bondFactory: Contract,
  collateralToken: Contract,
  issuer: Contract,
  feeStrategy: Contract,
  pricingStrategy: Contract,
  yieldStrategy: Contract,
  deployer: Signer,
  deployerAddress: string,
  router: Contract,
  depositBond: Contract,
  depositTranches: Contract[];

describe("RouterV1", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    deployerAddress = await deployer.getAddress();

    bondFactory = await setupBondFactory();
    ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));

    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await BondIssuer.deploy(bondFactory.address, 1200, 0, 3600, collateralToken.address, [200, 300, 500]);

    const FeeStrategy = await ethers.getContractFactory("MockFeeStrategy");
    feeStrategy = await FeeStrategy.deploy();

    const PricingStrategy = await ethers.getContractFactory("MockPricingStrategy");
    pricingStrategy = await PricingStrategy.deploy();

    const YieldStrategy = await ethers.getContractFactory("MockYieldStrategy");
    yieldStrategy = await YieldStrategy.deploy();

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
        yieldStrategy.address,
      ],
      {
        initializer: "init(string,string,address,address,address,address,address)",
      },
    );
    await perp.updateTolerableTrancheMaturiy(600, 3600);
    await advancePerpQueue(perp, 3600);

    depositBond = await bondAt(await perp.callStatic.getDepositBond());
    depositTranches = await getTranches(depositBond);

    await pricingStrategy.setTranchePrice(depositTranches[0].address, toPriceFixedPtAmt("1"));
    await yieldStrategy.setTrancheYield(depositTranches[0].address, toYieldFixedPtAmt("1"));

    await pricingStrategy.setTranchePrice(depositTranches[1].address, toPriceFixedPtAmt("1"));
    await yieldStrategy.setTrancheYield(depositTranches[1].address, toYieldFixedPtAmt("0.75"));

    await feeStrategy.setFeeToken(perp.address);
    await feeStrategy.setMintFee(toFixedPtAmt("0"));
    await feeStrategy.setBurnFee(toFixedPtAmt("0"));

    const Router = await ethers.getContractFactory("RouterV1");
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

  describe("#previewDeposit", function () {
    beforeEach(async function () {
      await feeStrategy.setMintFee(toFixedPtAmt("10"));
    });

    describe("when fee token is the native token", async function () {
      it("should compute the mint amount and fee", async function () {
        const r = await router.callStatic.previewDeposit(perp.address, depositTranches[1].address, toFixedPtAmt("300"));
        expect(r[0]).to.eq(toFixedPtAmt("225"));
        expect(r[1]).to.eq(perp.address);
        expect(r[2]).to.eq(toFixedPtAmt("10"));
      });
    });

    describe("when fee token is the non-native token", async function () {
      let feeToken: Contract;
      beforeEach(async function () {
        const ERC20 = await ethers.getContractFactory("MockERC20");
        feeToken = await ERC20.deploy();
        await feeToken.init("Mock token", "MOCK");
        await feeStrategy.setFeeToken(feeToken.address);
      });

      it("should compute the mint amount and fee", async function () {
        const r = await router.callStatic.previewDeposit(perp.address, depositTranches[0].address, toFixedPtAmt("200"));
        expect(r[0]).to.eq(toFixedPtAmt("200"));
        expect(r[1]).to.eq(feeToken.address);
        expect(r[2]).to.eq(toFixedPtAmt("10"));
      });
    });
  });

  describe("#previewRedeem", function () {
    let depositTranches1: Contract[], depositTranches2: Contract[], depositTranches3: Contract[];
    beforeEach(async function () {
      await feeStrategy.setBurnFee(toFixedPtAmt("12.75"));

      const depositBond1 = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches1 = await getTranches(depositBond1);
      await depositIntoBond(depositBond1, toFixedPtAmt("1000"), deployer);

      await pricingStrategy.setTranchePrice(depositTranches1[0].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(depositTranches1[0].address, toYieldFixedPtAmt("1"));
      await pricingStrategy.setTranchePrice(depositTranches1[1].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(depositTranches1[1].address, toYieldFixedPtAmt("0.75"));

      await depositTranches1[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(depositTranches1[0].address, toFixedPtAmt("200"));
      await depositTranches1[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(depositTranches1[1].address, toFixedPtAmt("300"));

      await advancePerpQueue(perp, 1200);

      const depositBond2 = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches2 = await getTranches(depositBond2);
      await depositIntoBond(depositBond2, toFixedPtAmt("1000"), deployer);

      await pricingStrategy.setTranchePrice(depositTranches2[0].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(depositTranches2[0].address, toYieldFixedPtAmt("1"));
      await pricingStrategy.setTranchePrice(depositTranches2[1].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(depositTranches2[1].address, toYieldFixedPtAmt("0.75"));

      await depositTranches2[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(depositTranches2[0].address, toFixedPtAmt("200"));
      await depositTranches2[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(depositTranches2[1].address, toFixedPtAmt("300"));

      await advancePerpQueue(perp, 1200);

      const depositBond3 = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches3 = await getTranches(depositBond3);
      await depositIntoBond(depositBond3, toFixedPtAmt("1000"), deployer);

      await pricingStrategy.setTranchePrice(depositTranches3[0].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(depositTranches3[0].address, toYieldFixedPtAmt("1"));
      await pricingStrategy.setTranchePrice(depositTranches3[1].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(depositTranches3[1].address, toYieldFixedPtAmt("0.75"));

      await depositTranches3[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(depositTranches3[0].address, toFixedPtAmt("200"));
      await depositTranches3[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(depositTranches3[1].address, toFixedPtAmt("300"));
    });

    describe("full redemption", function () {
      it("should compute the burn amount and fee", async function () {
        const r = await router.callStatic.previewRedeem(perp.address, toFixedPtAmt("1275"));

        expect(r[0][0]).to.eq(collateralToken.address);
        expect(r[0][1]).to.eq(depositTranches1[0].address);
        expect(r[0][2]).to.eq(depositTranches1[1].address);
        expect(r[0][3]).to.eq(depositTranches2[0].address);
        expect(r[0][4]).to.eq(depositTranches2[1].address);
        expect(r[0][5]).to.eq(depositTranches3[0].address);
        expect(r[0][6]).to.eq(depositTranches3[1].address);

        expect(r[1][0]).to.eq(toFixedPtAmt("0"));
        expect(r[1][1]).to.eq(toFixedPtAmt("200"));
        expect(r[1][2]).to.eq(toFixedPtAmt("300"));
        expect(r[1][3]).to.eq(toFixedPtAmt("200"));
        expect(r[1][4]).to.eq(toFixedPtAmt("300"));
        expect(r[1][5]).to.eq(toFixedPtAmt("200"));
        expect(r[1][6]).to.eq(toFixedPtAmt("300"));

        expect(r[2]).to.eq(perp.address);
        expect(r[3]).to.eq(toFixedPtAmt("12.75"));
      });
    });

    describe("partial redemption", async function () {
      it("should compute the burn amount and fee", async function () {
        const r = await router.callStatic.previewRedeem(perp.address, toFixedPtAmt("637.5"));

        expect(r[0][0]).to.eq(collateralToken.address);
        expect(r[0][1]).to.eq(depositTranches1[0].address);
        expect(r[0][2]).to.eq(depositTranches1[1].address);
        expect(r[0][3]).to.eq(depositTranches2[0].address);
        expect(r[0][4]).to.eq(depositTranches2[1].address);
        expect(r[0][5]).to.eq(depositTranches3[0].address);
        expect(r[0][6]).to.eq(depositTranches3[1].address);

        expect(r[1][0]).to.eq(toFixedPtAmt("0"));
        expect(r[1][1]).to.eq(toFixedPtAmt("100"));
        expect(r[1][2]).to.eq(toFixedPtAmt("150"));
        expect(r[1][3]).to.eq(toFixedPtAmt("100"));
        expect(r[1][4]).to.eq(toFixedPtAmt("150"));
        expect(r[1][5]).to.eq(toFixedPtAmt("100"));
        expect(r[1][6]).to.eq(toFixedPtAmt("150"));

        expect(r[2]).to.eq(perp.address);
        expect(r[3]).to.eq(toFixedPtAmt("12.75"));
      });
    });

    describe("when fee is in non native token", async function () {
      let feeToken: Contract;
      beforeEach(async function () {
        const ERC20 = await ethers.getContractFactory("MockERC20");
        feeToken = await ERC20.deploy();
        await feeToken.init("Mock token", "MOCK");
        await feeStrategy.setFeeToken(feeToken.address);
      });

      it("should compute the burn amount and fee", async function () {
        const r = await router.callStatic.previewRedeem(perp.address, toFixedPtAmt("637.5"));

        expect(r[0][0]).to.eq(collateralToken.address);
        expect(r[0][1]).to.eq(depositTranches1[0].address);
        expect(r[0][2]).to.eq(depositTranches1[1].address);
        expect(r[0][3]).to.eq(depositTranches2[0].address);
        expect(r[0][4]).to.eq(depositTranches2[1].address);
        expect(r[0][5]).to.eq(depositTranches3[0].address);
        expect(r[0][6]).to.eq(depositTranches3[1].address);

        expect(r[1][0]).to.eq(toFixedPtAmt("0"));
        expect(r[1][1]).to.eq(toFixedPtAmt("100"));
        expect(r[1][2]).to.eq(toFixedPtAmt("150"));
        expect(r[1][3]).to.eq(toFixedPtAmt("100"));
        expect(r[1][4]).to.eq(toFixedPtAmt("150"));
        expect(r[1][5]).to.eq(toFixedPtAmt("100"));
        expect(r[1][6]).to.eq(toFixedPtAmt("150"));

        expect(r[2]).to.eq(feeToken.address);
        expect(r[3]).to.eq(toFixedPtAmt("12.75"));
      });
    });
  });

  describe("#previewRollover", function () {
    let holdingPenTranches: Contract[], reserveTranches: Contract[], depositTranches: Contract[];
    beforeEach(async function () {
      await feeStrategy.setBurnFee(toFixedPtAmt("10"));

      const holdingPenBond = await bondAt(await perp.callStatic.getDepositBond());
      holdingPenTranches = await getTranches(holdingPenBond);
      await depositIntoBond(holdingPenBond, toFixedPtAmt("1000"), deployer);

      await pricingStrategy.setTranchePrice(holdingPenTranches[0].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(holdingPenTranches[0].address, toYieldFixedPtAmt("1"));
      await pricingStrategy.setTranchePrice(holdingPenTranches[1].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(holdingPenTranches[1].address, toYieldFixedPtAmt("0.75"));

      await holdingPenTranches[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(holdingPenTranches[0].address, toFixedPtAmt("200"));
      await holdingPenTranches[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(holdingPenTranches[1].address, toFixedPtAmt("300"));

      await advancePerpQueue(perp, 7200);

      const reserveBond = await bondAt(await perp.callStatic.getDepositBond());
      reserveTranches = await getTranches(reserveBond);
      await depositIntoBond(reserveBond, toFixedPtAmt("1000"), deployer);

      await pricingStrategy.setTranchePrice(reserveTranches[0].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(reserveTranches[0].address, toYieldFixedPtAmt("1"));
      await pricingStrategy.setTranchePrice(reserveTranches[1].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(reserveTranches[1].address, toYieldFixedPtAmt("0.75"));

      await reserveTranches[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(reserveTranches[0].address, toFixedPtAmt("200"));
      await reserveTranches[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(reserveTranches[1].address, toFixedPtAmt("300"));

      await advancePerpQueueToRollover(perp, reserveBond);

      const depositBond = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches = await getTranches(depositBond);
      await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);

      await pricingStrategy.setTranchePrice(depositTranches[0].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(depositTranches[0].address, toYieldFixedPtAmt("1"));
      await pricingStrategy.setTranchePrice(depositTranches[1].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(depositTranches[1].address, toYieldFixedPtAmt("0.75"));

      await depositTranches[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(depositTranches[0].address, toFixedPtAmt("200"));
      await depositTranches[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(depositTranches[1].address, toFixedPtAmt("300"));
    });

    describe("when rollover is not acceptable", function () {
      beforeEach(async function () {
        await await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
      });
      it("should return 0", async function () {
        const r = await router.callStatic.previewRollover(
          perp.address,
          depositTranches[0].address,
          depositTranches[0].address,
          toFixedPtAmt("200"),
          constants.MaxUint256,
        );
        expect(r[0].perpRolloverAmt).to.eq(toFixedPtAmt("0"));
        expect(r[0].tokenOutAmt).to.eq(toFixedPtAmt("0"));
        expect(r[0].trancheInAmtUsed).to.eq(toFixedPtAmt("0"));
        expect(r[0].remainingTrancheInAmt).to.eq(toFixedPtAmt("200"));
        expect(r[1]).to.eq(perp.address);
        expect(r[2]).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tranche out balance is NOT covered", function () {
      beforeEach(async function () {
        await await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
      });
      it("should compute the rollover fees and amounts", async function () {
        const r = await router.callStatic.previewRollover(
          perp.address,
          depositTranches[0].address,
          reserveTranches[0].address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        expect(r[0].perpRolloverAmt).to.eq(toFixedPtAmt("180"));
        expect(r[0].tokenOutAmt).to.eq(toFixedPtAmt("200"));
        expect(r[0].trancheInAmtUsed).to.eq(toFixedPtAmt("200"));
        expect(r[0].remainingTrancheInAmt).to.eq(toFixedPtAmt("50"));
        expect(r[1]).to.eq(perp.address);
        expect(r[2]).to.eq(toFixedPtAmt("1"));
      });
    });

    describe("when tranche out has different rate", function () {
      beforeEach(async function () {
        await await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
      });
      it("should compute the rollover fees and amounts", async function () {
        const r = await router.callStatic.previewRollover(
          perp.address,
          depositTranches[0].address,
          reserveTranches[1].address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        expect(r[0].perpRolloverAmt).to.eq(toFixedPtAmt("202.5"));
        expect(r[0].tokenOutAmt).to.eq(toFixedPtAmt("300"));
        expect(r[0].trancheInAmtUsed).to.eq(toFixedPtAmt("225"));
        expect(r[0].remainingTrancheInAmt).to.eq(toFixedPtAmt("25"));
        expect(r[1]).to.eq(perp.address);
        expect(r[2]).to.eq(toFixedPtAmt("1"));
      });
    });

    describe("when tranche out balance is covered exactly", function () {
      beforeEach(async function () {
        await await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
      });
      it("should compute the rollover fees and amounts", async function () {
        const r = await router.callStatic.previewRollover(
          perp.address,
          depositTranches[0].address,
          reserveTranches[0].address,
          toFixedPtAmt("200"),
          constants.MaxUint256,
        );
        expect(r[0].perpRolloverAmt).to.eq(toFixedPtAmt("180"));
        expect(r[0].tokenOutAmt).to.eq(toFixedPtAmt("200"));
        expect(r[0].trancheInAmtUsed).to.eq(toFixedPtAmt("200"));
        expect(r[0].remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        expect(r[1]).to.eq(perp.address);
        expect(r[2]).to.eq(toFixedPtAmt("1"));
      });
    });

    describe("when tranche out used is less than the balance", function () {
      beforeEach(async function () {
        await await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
      });
      it("should compute the rollover fees and amounts", async function () {
        const r = await router.callStatic.previewRollover(
          perp.address,
          depositTranches[0].address,
          reserveTranches[0].address,
          toFixedPtAmt("200"),
          toFixedPtAmt("190"),
        );
        expect(r[0].perpRolloverAmt).to.eq(toFixedPtAmt("171"));
        expect(r[0].tokenOutAmt).to.eq(toFixedPtAmt("190"));
        expect(r[0].trancheInAmtUsed).to.eq(toFixedPtAmt("190"));
        expect(r[0].remainingTrancheInAmt).to.eq(toFixedPtAmt("10"));
        expect(r[1]).to.eq(perp.address);
        expect(r[2]).to.eq(toFixedPtAmt("1"));
      });
    });

    describe("when tranche out balance is covered", function () {
      beforeEach(async function () {
        await await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
      });
      it("should compute the rollover fees and amounts", async function () {
        const r = await router.callStatic.previewRollover(
          perp.address,
          depositTranches[0].address,
          reserveTranches[0].address,
          toFixedPtAmt("190"),
          constants.MaxUint256,
        );
        expect(r[0].perpRolloverAmt).to.eq(toFixedPtAmt("171"));
        expect(r[0].tokenOutAmt).to.eq(toFixedPtAmt("190"));
        expect(r[0].trancheInAmtUsed).to.eq(toFixedPtAmt("190"));
        expect(r[0].remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        expect(r[1]).to.eq(perp.address);
        expect(r[2]).to.eq(toFixedPtAmt("1"));
      });
    });

    describe("when collateral token is transferred out", function () {
      beforeEach(async function () {
        await await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
      });
      it("should compute the rollover fees and amounts", async function () {
        const r = await router.callStatic.previewRollover(
          perp.address,
          depositTranches[0].address,
          collateralToken.address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        expect(r[0].perpRolloverAmt).to.eq(toFixedPtAmt("225"));
        expect(r[0].tokenOutAmt).to.eq("294117647058823529411");
        expect(r[0].trancheInAmtUsed).to.eq(toFixedPtAmt("250"));
        expect(r[0].remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        expect(r[1]).to.eq(perp.address);
        expect(r[2]).to.eq(toFixedPtAmt("1"));
      });
    });

    describe("when fee is -ve", function () {
      beforeEach(async function () {
        await await feeStrategy.setRolloverFee(toFixedPtAmt("-1"));
      });
      it("should compute the rollover fees and amounts", async function () {
        const r = await router.callStatic.previewRollover(
          perp.address,
          depositTranches[0].address,
          reserveTranches[0].address,
          toFixedPtAmt("200"),
          constants.MaxUint256,
        );
        expect(r[0].perpRolloverAmt).to.eq(toFixedPtAmt("180"));
        expect(r[0].tokenOutAmt).to.eq(toFixedPtAmt("200"));
        expect(r[0].trancheInAmtUsed).to.eq(toFixedPtAmt("200"));
        expect(r[0].remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        expect(r[1]).to.eq(perp.address);
        expect(r[2]).to.eq(toFixedPtAmt("-1"));
      });
    });

    describe("when fee is in non native token", function () {
      let feeToken: Contract;
      beforeEach(async function () {
        const ERC20 = await ethers.getContractFactory("MockERC20");
        feeToken = await ERC20.deploy();
        await feeToken.init("Mock token", "MOCK");
        await feeStrategy.setFeeToken(feeToken.address);
        await await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
      });
      it("should compute the rollover fees and amounts", async function () {
        const r = await router.callStatic.previewRollover(
          perp.address,
          depositTranches[0].address,
          reserveTranches[0].address,
          toFixedPtAmt("200"),
          constants.MaxUint256,
        );
        expect(r[0].perpRolloverAmt).to.eq(toFixedPtAmt("180"));
        expect(r[0].tokenOutAmt).to.eq(toFixedPtAmt("200"));
        expect(r[0].trancheInAmtUsed).to.eq(toFixedPtAmt("200"));
        expect(r[0].remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        expect(r[1]).to.eq(feeToken.address);
        expect(r[2]).to.eq(toFixedPtAmt("1"));
      });
    });
  });

  describe("#trancheAndDeposit", function () {
    beforeEach(async function () {
      await mintCollteralToken(collateralToken, toFixedPtAmt("2000"), deployer);
      await feeStrategy.setMintFee(toFixedPtAmt("5"));
    });

    describe("when deposit bond is incorrect", function () {
      beforeEach(async function () {
        await collateralToken.approve(router.address, constants.MaxUint256);
        await advancePerpQueue(perp, 7200);
      });
      it("should revert", async function () {
        await expect(
          router.trancheAndDeposit(perp.address, depositBond.address, toFixedPtAmt("1000"), 0),
        ).to.revertedWith("UnacceptableDepositTranche");
      });
    });

    describe("when fee is in native token", function () {
      beforeEach(async function () {
        await collateralToken.approve(router.address, constants.MaxUint256);
        await router.trancheAndDeposit(perp.address, depositBond.address, toFixedPtAmt("1000"), 0);
      });

      it("should mint tranches", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("415"));
      });

      it("should transfer unused tranches back", async function () {
        expect(await depositTranches[2].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("500"));
      });

      it("should leave no dust", async function () {
        expect(await depositTranches[0].balanceOf(router.address)).to.eq("0");
        expect(await depositTranches[1].balanceOf(router.address)).to.eq("0");
        expect(await perp.balanceOf(router.address)).to.eq("0");
      });
    });

    describe("when fee is in non-native token", function () {
      let feeToken: Contract;
      beforeEach(async function () {
        const ERC20 = await ethers.getContractFactory("MockERC20");
        feeToken = await ERC20.deploy();
        await feeToken.init("Mock token", "MOCK");
        await feeStrategy.setFeeToken(feeToken.address);
        await feeToken.mint(deployerAddress, toFixedPtAmt("10"));

        await feeToken.approve(router.address, constants.MaxUint256);
        await collateralToken.approve(router.address, constants.MaxUint256);
        await router.trancheAndDeposit(perp.address, depositBond.address, toFixedPtAmt("1000"), toFixedPtAmt("10"));
      });

      it("should mint tranches", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("425"));
      });

      it("should transfer fee", async function () {
        expect(await feeToken.balanceOf(perp.address)).to.eq(toFixedPtAmt("10"));
      });

      it("should transfer unused tranches back", async function () {
        expect(await depositTranches[2].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("500"));
      });

      it("should leave no dust", async function () {
        expect(await depositTranches[0].balanceOf(router.address)).to.eq("0");
        expect(await depositTranches[1].balanceOf(router.address)).to.eq("0");
        expect(await perp.balanceOf(router.address)).to.eq("0");
        expect(await feeToken.balanceOf(router.address)).to.eq("0");
      });
    });

    describe("when fee is overpaid", function () {
      let feeToken: Contract;
      beforeEach(async function () {
        const ERC20 = await ethers.getContractFactory("MockERC20");
        feeToken = await ERC20.deploy();
        await feeToken.init("Mock token", "MOCK");
        await feeStrategy.setFeeToken(feeToken.address);
        await feeToken.mint(deployerAddress, toFixedPtAmt("25"));

        await feeToken.approve(router.address, constants.MaxUint256);
        await collateralToken.approve(router.address, constants.MaxUint256);
        await mintCollteralToken(collateralToken, toFixedPtAmt("1"), deployer);
        await collateralToken.transfer(router.address, toFixedPtAmt("1"));
        await router.trancheAndDeposit(perp.address, depositBond.address, toFixedPtAmt("1000"), toFixedPtAmt("25"));
      });

      it("should mint tranches", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("425"));
      });

      it("should transfer fee", async function () {
        expect(await feeToken.balanceOf(perp.address)).to.eq(toFixedPtAmt("10"));
      });

      it("should remaining fee back", async function () {
        expect(await feeToken.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("15"));
      });

      it("should transfer unused tranches back", async function () {
        expect(await depositTranches[2].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("500"));
      });

      it("should leave no dust", async function () {
        expect(await collateralToken.balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[0].balanceOf(router.address)).to.eq("0");
        expect(await depositTranches[1].balanceOf(router.address)).to.eq("0");
        expect(await perp.balanceOf(router.address)).to.eq("0");
        expect(await feeToken.balanceOf(router.address)).to.eq("0");
      });
    });
  });

  describe("#trancheAndRollover", function () {
    let holdingPenTranches: Contract[], reserveTranches: Contract[], depositBond: Contract, depositTranches: Contract[];
    beforeEach(async function () {
      await feeStrategy.setBurnFee(toFixedPtAmt("10"));

      const holdingPenBond = await bondAt(await perp.callStatic.getDepositBond());
      holdingPenTranches = await getTranches(holdingPenBond);
      await depositIntoBond(holdingPenBond, toFixedPtAmt("1000"), deployer);

      await pricingStrategy.setTranchePrice(holdingPenTranches[0].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(holdingPenTranches[0].address, toYieldFixedPtAmt("1"));
      await pricingStrategy.setTranchePrice(holdingPenTranches[1].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(holdingPenTranches[1].address, toYieldFixedPtAmt("1"));

      await holdingPenTranches[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(holdingPenTranches[0].address, toFixedPtAmt("200"));
      await holdingPenTranches[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(holdingPenTranches[1].address, toFixedPtAmt("300"));

      await advancePerpQueue(perp, 7200);

      const reserveBond = await bondAt(await perp.callStatic.getDepositBond());
      reserveTranches = await getTranches(reserveBond);
      await depositIntoBond(reserveBond, toFixedPtAmt("1000"), deployer);

      await pricingStrategy.setTranchePrice(reserveTranches[0].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(reserveTranches[0].address, toYieldFixedPtAmt("1"));
      await pricingStrategy.setTranchePrice(reserveTranches[1].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(reserveTranches[1].address, toYieldFixedPtAmt("1"));

      await reserveTranches[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(reserveTranches[0].address, toFixedPtAmt("200"));
      await reserveTranches[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(reserveTranches[1].address, toFixedPtAmt("300"));

      await advancePerpQueueToRollover(perp, reserveBond);

      depositBond = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches = await getTranches(depositBond);

      await pricingStrategy.setTranchePrice(depositTranches[0].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(depositTranches[0].address, toYieldFixedPtAmt("1"));
      await pricingStrategy.setTranchePrice(depositTranches[1].address, toPriceFixedPtAmt("1"));
      await yieldStrategy.setTrancheYield(depositTranches[1].address, toYieldFixedPtAmt("1"));
    });

    describe("successful tranche & rollover and return the remainder", function () {
      beforeEach(async function () {
        await await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
        await perp.approve(router.address, toFixedPtAmt("15"));

        await mintCollteralToken(collateralToken, toFixedPtAmt("2000"), deployer);
        await collateralToken.approve(router.address, toFixedPtAmt("2000"));

        expect(await collateralToken.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("2000"));
        expect(await holdingPenTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await holdingPenTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await reserveTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[0].balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[1].balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("1000"));

        await mintCollteralToken(collateralToken, toFixedPtAmt("1"), deployer);
        await collateralToken.transfer(router.address, toFixedPtAmt("1"));
        await router.trancheAndRollover(
          perp.address,
          depositBond.address,
          toFixedPtAmt("2000"),
          [
            [depositTranches[0].address, collateralToken.address, toFixedPtAmt("300")],
            [depositTranches[0].address, reserveTranches[0].address, toFixedPtAmt("100")],
            [depositTranches[1].address, reserveTranches[0].address, toFixedPtAmt("100")],
            [depositTranches[1].address, reserveTranches[1].address, toFixedPtAmt("100")],
          ],
          toFixedPtAmt("15"),
        );
      });

      it("should transfer tranches out", async function () {
        expect(await collateralToken.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("301"));
        expect(await holdingPenTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await holdingPenTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await reserveTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("200"));
        expect(await reserveTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("100"));
        expect(await depositTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("400"));
        expect(await depositTranches[0].balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[1].balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
      });

      it("should transfer excess fees back", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("996"));
      });

      it("should leave no dust", async function () {
        expect(await collateralToken.balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await perp.balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("successful tranche & rollover and return the remainder (with no fees)", function () {
      beforeEach(async function () {
        await await feeStrategy.setRolloverFee("0");
        
        await mintCollteralToken(collateralToken, toFixedPtAmt("2000"), deployer);
        await collateralToken.approve(router.address, toFixedPtAmt("2000"));

        expect(await collateralToken.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("2000"));
        expect(await holdingPenTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await holdingPenTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await reserveTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[0].balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[1].balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("1000"));

        await mintCollteralToken(collateralToken, toFixedPtAmt("1"), deployer);
        await collateralToken.transfer(router.address, toFixedPtAmt("1"));
        await router.trancheAndRollover(
          perp.address,
          depositBond.address,
          toFixedPtAmt("1000"),
          [
            [depositTranches[0].address, reserveTranches[0].address, toFixedPtAmt("100")],
            [depositTranches[1].address, reserveTranches[0].address, toFixedPtAmt("100")],
            [depositTranches[1].address, reserveTranches[1].address, toFixedPtAmt("100")],
          ],
          "0",
        );
      });

      it("should transfer tranches out", async function () {
        expect(await collateralToken.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("1001"));
        expect(await holdingPenTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await holdingPenTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await reserveTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("200"));
        expect(await reserveTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("100"));
        expect(await depositTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("100"));
        expect(await depositTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("100"));
        expect(await depositTranches[0].balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[1].balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
      });

      it("should transfer excess fees back", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("1000"));
      });

      it("should leave no dust", async function () {
        expect(await collateralToken.balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await perp.balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
      });
    })
  });
});
