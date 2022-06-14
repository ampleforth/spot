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
} from "./helpers";

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

describe("RouterV1", function () {
  beforeEach(async function () {
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

    const PerpetualNoteTranche = await ethers.getContractFactory("PerpetualNoteTranche");
    perp = await upgrades.deployProxy(
      PerpetualNoteTranche.connect(deployer),
      ["PerpetualNoteTranche", "PERP", 9, issuer.address, feeStrategy.address, pricingStrategy.address],
      {
        initializer: "init(string,string,uint8,address,address,address)",
      },
    );
    await advancePerpQueue(perp, 3600);

    depositBond = await bondAt(await perp.callStatic.getDepositBond());
    depositTranches = await getTranches(depositBond);

    await feeStrategy.setFeeToken(perp.address);
    await feeStrategy.setMintFee(toFixedPtAmt("0"));
    await feeStrategy.setBurnFee(toFixedPtAmt("0"));
    await pricingStrategy.setPrice(toPriceFixedPtAmt("1"));
    await perp.updateDefinedYield(await perp.trancheClass(depositTranches[0].address), toYieldFixedPtAmt("1"));
    await perp.updateDefinedYield(await perp.trancheClass(depositTranches[1].address), toYieldFixedPtAmt("0.75"));

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
      await feeStrategy.setBurnFee(toFixedPtAmt("10"));

      const depositBond1 = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches1 = await getTranches(depositBond1);
      await depositIntoBond(depositBond1, toFixedPtAmt("1000"), deployer);
      await depositTranches1[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(depositTranches1[0].address, toFixedPtAmt("200"));
      await depositTranches1[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(depositTranches1[1].address, toFixedPtAmt("300"));

      await advancePerpQueue(perp, 1200);

      const depositBond2 = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches2 = await getTranches(depositBond2);
      await depositIntoBond(depositBond2, toFixedPtAmt("1000"), deployer);
      await depositTranches2[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(depositTranches2[0].address, toFixedPtAmt("200"));
      await depositTranches2[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(depositTranches2[1].address, toFixedPtAmt("300"));

      await advancePerpQueue(perp, 1200);

      const depositBond3 = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches3 = await getTranches(depositBond3);
      await depositIntoBond(depositBond3, toFixedPtAmt("1000"), deployer);
      await depositTranches3[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(depositTranches3[0].address, toFixedPtAmt("200"));
      await depositTranches3[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(depositTranches3[1].address, toFixedPtAmt("300"));
    });

    describe("full redemption", function () {
      it("should compute the burn amount and fee", async function () {
        const r = await router.callStatic.previewRedeem(perp.address, toFixedPtAmt("1275"), constants.MaxUint256);
        expect(r[0]).to.eq(toFixedPtAmt("1275"));
        expect(r[1]).to.eq(perp.address);
        expect(r[2]).to.eq(toFixedPtAmt("10"));
        expect(r[3].length).to.eq(6);
        expect(r[3][0]).to.eq(depositTranches1[0].address);
        expect(r[3][1]).to.eq(depositTranches1[1].address);
        expect(r[3][2]).to.eq(depositTranches2[0].address);
        expect(r[3][3]).to.eq(depositTranches2[1].address);
        expect(r[3][4]).to.eq(depositTranches3[0].address);
        expect(r[3][5]).to.eq(depositTranches3[1].address);
      });
    });

    describe("full redemption when max tranches is set", async function () {
      it("should compute the burn amount and fee", async function () {
        const r = await router.callStatic.previewRedeem(perp.address, toFixedPtAmt("1275"), 2);
        expect(r[0]).to.eq(toFixedPtAmt("425"));
        expect(r[1]).to.eq(perp.address);
        expect(r[2]).to.eq(toFixedPtAmt("10"));
        expect(r[3].length).to.eq(2);
        expect(r[3][0]).to.eq(depositTranches1[0].address);
        expect(r[3][1]).to.eq(depositTranches1[1].address);
      });
    });

    describe("partial redemption", async function () {
      it("should compute the burn amount and fee", async function () {
        const r = await router.callStatic.previewRedeem(perp.address, toFixedPtAmt("500"), constants.MaxUint256);
        expect(r[0]).to.eq(toFixedPtAmt("500"));
        expect(r[1]).to.eq(perp.address);
        expect(r[2]).to.eq(toFixedPtAmt("10"));
        expect(r[3].length).to.eq(6);
        expect(r[3][0]).to.eq(depositTranches1[0].address);
        expect(r[3][1]).to.eq(depositTranches1[1].address);
        expect(r[3][2]).to.eq(depositTranches2[0].address);
        expect(r[3][3]).to.eq(constants.AddressZero);
        expect(r[3][4]).to.eq(constants.AddressZero);
        expect(r[3][5]).to.eq(constants.AddressZero);
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
        const r = await router.callStatic.previewRedeem(perp.address, toFixedPtAmt("500"), constants.MaxUint256);
        expect(r[0]).to.eq(toFixedPtAmt("500"));
        expect(r[1]).to.eq(feeToken.address);
        expect(r[2]).to.eq(toFixedPtAmt("10"));
        expect(r[3].length).to.eq(6);
        expect(r[3][0]).to.eq(depositTranches1[0].address);
        expect(r[3][1]).to.eq(depositTranches1[1].address);
        expect(r[3][2]).to.eq(depositTranches2[0].address);
        expect(r[3][3]).to.eq(constants.AddressZero);
        expect(r[3][4]).to.eq(constants.AddressZero);
        expect(r[3][5]).to.eq(constants.AddressZero);
      });
    });
  });

  describe("#previewRollover", function () {
    let iceboxTranches1: Contract[], iceboxTranches2: Contract[], depositTranches: Contract[];
    beforeEach(async function () {
      await feeStrategy.setBurnFee(toFixedPtAmt("10"));

      const iceboxBond1 = await bondAt(await perp.callStatic.getDepositBond());
      iceboxTranches1 = await getTranches(iceboxBond1);
      await depositIntoBond(iceboxBond1, toFixedPtAmt("1000"), deployer);
      await iceboxTranches1[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(iceboxTranches1[0].address, toFixedPtAmt("200"));
      await iceboxTranches1[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(iceboxTranches1[1].address, toFixedPtAmt("300"));

      await advancePerpQueue(perp, 1200);

      const iceboxBond2 = await bondAt(await perp.callStatic.getDepositBond());
      iceboxTranches2 = await getTranches(iceboxBond2);
      await depositIntoBond(iceboxBond2, toFixedPtAmt("1000"), deployer);
      await iceboxTranches2[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(iceboxTranches2[0].address, toFixedPtAmt("200"));
      await iceboxTranches2[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(iceboxTranches2[1].address, toFixedPtAmt("300"));

      await advancePerpQueue(perp, 7200);

      const depositBond = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches = await getTranches(depositBond);
      await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
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
        expect(r[0].rolloverPerpAmt).to.eq(toFixedPtAmt("0"));
        expect(r[0].requestedRolloverPerpAmt).to.eq(toFixedPtAmt("0"));
        expect(r[0].trancheOutAmt).to.eq(toFixedPtAmt("0"));
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
          iceboxTranches1[0].address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        expect(r[0].rolloverPerpAmt).to.eq(toFixedPtAmt("200"));
        expect(r[0].requestedRolloverPerpAmt).to.eq(toFixedPtAmt("250"));
        expect(r[0].trancheOutAmt).to.eq(toFixedPtAmt("200"));
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
          iceboxTranches1[1].address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        expect(r[0].rolloverPerpAmt).to.eq(toFixedPtAmt("225"));
        expect(r[0].requestedRolloverPerpAmt).to.eq(toFixedPtAmt("250"));
        expect(r[0].trancheOutAmt).to.eq(toFixedPtAmt("300"));
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
          iceboxTranches1[0].address,
          toFixedPtAmt("200"),
          constants.MaxUint256,
        );
        expect(r[0].rolloverPerpAmt).to.eq(toFixedPtAmt("200"));
        expect(r[0].requestedRolloverPerpAmt).to.eq(toFixedPtAmt("200"));
        expect(r[0].trancheOutAmt).to.eq(toFixedPtAmt("200"));
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
          iceboxTranches1[0].address,
          toFixedPtAmt("200"),
          toFixedPtAmt("190"),
        );
        expect(r[0].rolloverPerpAmt).to.eq(toFixedPtAmt("190"));
        expect(r[0].requestedRolloverPerpAmt).to.eq(toFixedPtAmt("200"));
        expect(r[0].trancheOutAmt).to.eq(toFixedPtAmt("190"));
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
          iceboxTranches1[0].address,
          toFixedPtAmt("190"),
          constants.MaxUint256,
        );
        expect(r[0].rolloverPerpAmt).to.eq(toFixedPtAmt("190"));
        expect(r[0].requestedRolloverPerpAmt).to.eq(toFixedPtAmt("190"));
        expect(r[0].trancheOutAmt).to.eq(toFixedPtAmt("190"));
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
          iceboxTranches1[0].address,
          toFixedPtAmt("200"),
          constants.MaxUint256,
        );
        expect(r[0].rolloverPerpAmt).to.eq(toFixedPtAmt("200"));
        expect(r[0].requestedRolloverPerpAmt).to.eq(toFixedPtAmt("200"));
        expect(r[0].trancheOutAmt).to.eq(toFixedPtAmt("200"));
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
          iceboxTranches1[0].address,
          toFixedPtAmt("200"),
          constants.MaxUint256,
        );
        expect(r[0].rolloverPerpAmt).to.eq(toFixedPtAmt("200"));
        expect(r[0].requestedRolloverPerpAmt).to.eq(toFixedPtAmt("200"));
        expect(r[0].trancheOutAmt).to.eq(toFixedPtAmt("200"));
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
        expect(await depositTranches[0].balanceOf(router.address)).to.eq("0");
        expect(await depositTranches[1].balanceOf(router.address)).to.eq("0");
        expect(await perp.balanceOf(router.address)).to.eq("0");
        expect(await feeToken.balanceOf(router.address)).to.eq("0");
      });
    });
  });

  describe("#redeem", function () {
    let depositTranches1: Contract[], depositTranches2: Contract[], depositTranches3: Contract[];
    beforeEach(async function () {
      await feeStrategy.setBurnFee(toFixedPtAmt("5"));

      const depositBond1 = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches1 = await getTranches(depositBond1);
      await depositIntoBond(depositBond1, toFixedPtAmt("1000"), deployer);
      await depositTranches1[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(depositTranches1[0].address, toFixedPtAmt("200"));
      await depositTranches1[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(depositTranches1[1].address, toFixedPtAmt("300"));

      await advancePerpQueue(perp, 1200);

      const depositBond2 = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches2 = await getTranches(depositBond2);
      await depositIntoBond(depositBond2, toFixedPtAmt("1000"), deployer);
      await depositTranches2[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(depositTranches2[0].address, toFixedPtAmt("200"));
      await depositTranches2[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(depositTranches2[1].address, toFixedPtAmt("300"));

      await advancePerpQueue(perp, 1200);

      const depositBond3 = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches3 = await getTranches(depositBond3);
      await depositIntoBond(depositBond3, toFixedPtAmt("1000"), deployer);
      await depositTranches3[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(depositTranches3[0].address, toFixedPtAmt("200"));
      await depositTranches3[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(depositTranches3[1].address, toFixedPtAmt("300"));
    });

    describe("when redemption order changes", function () {
      beforeEach(async function () {
        await perp.approve(router.address, constants.MaxUint256);
      });
      it("should revert", async function () {
        await expect(
          router.redeem(perp.address, toFixedPtAmt("500"), toFixedPtAmt("10"), [
            depositTranches1[0].address,
            depositTranches2[0].address,
            depositTranches1[1].address,
          ]),
        ).to.be.revertedWith("UnacceptableRedemptionTranche");
      });
    });

    describe("full redemption", function () {
      beforeEach(async function () {
        await perp.approve(router.address, constants.MaxUint256);
        await router.redeem(perp.address, toFixedPtAmt("1245"), toFixedPtAmt("30"), [
          depositTranches1[0].address,
          depositTranches1[1].address,
          depositTranches2[0].address,
          depositTranches2[1].address,
          depositTranches3[0].address,
          depositTranches3[1].address,
        ]);
      });

      it("should burn perps", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.eq("0");
      });

      it("should transfer fees", async function () {
        expect(await perp.balanceOf(perp.address)).to.eq(toFixedPtAmt("30"));
      });

      it("should transfer tranches", async function () {
        expect(await depositTranches1[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("200"));
        expect(await depositTranches1[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("300"));
        expect(await depositTranches2[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("200"));
        expect(await depositTranches2[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("300"));
        expect(await depositTranches3[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("200"));
        expect(await depositTranches3[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("260"));
      });
    });

    describe("partial redemption", async function () {
      beforeEach(async function () {
        await perp.approve(router.address, constants.MaxUint256);
        await router.redeem(perp.address, toFixedPtAmt("500"), toFixedPtAmt("15"), [
          depositTranches1[0].address,
          depositTranches1[1].address,
          depositTranches2[0].address,
        ]);
      });

      it("should burn perps", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("760")); // 1275 - 515
      });

      it("should transfer fees", async function () {
        expect(await perp.balanceOf(perp.address)).to.eq(toFixedPtAmt("15"));
      });

      it("should transfer tranches", async function () {
        expect(await depositTranches1[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("200"));
        expect(await depositTranches1[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("300"));
        expect(await depositTranches2[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("75"));
        expect(await depositTranches2[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches3[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches3[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when fee is in non native token", async function () {
      let feeToken: Contract;
      beforeEach(async function () {
        const ERC20 = await ethers.getContractFactory("MockERC20");
        feeToken = await ERC20.deploy();
        await feeToken.init("Mock token", "MOCK");
        await feeToken.mint(deployerAddress, toFixedPtAmt("20"));
        await feeStrategy.setFeeToken(feeToken.address);
        await feeToken.approve(router.address, constants.MaxUint256);
        await perp.approve(router.address, constants.MaxUint256);
        await router.redeem(perp.address, toFixedPtAmt("500"), toFixedPtAmt("20"), [
          depositTranches1[0].address,
          depositTranches1[1].address,
          depositTranches2[0].address,
        ]);
      });

      it("should burn perps", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("775")); // 1275 - 500
      });

      it("should transfer fees", async function () {
        expect(await feeToken.balanceOf(perp.address)).to.eq(toFixedPtAmt("15"));
      });

      it("should transfer remaining fees back", async function () {
        expect(await feeToken.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("5"));
      });

      it("should transfer tranches", async function () {
        expect(await depositTranches1[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("200"));
        expect(await depositTranches1[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("300"));
        expect(await depositTranches2[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("75"));
        expect(await depositTranches2[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches3[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches3[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
      });
    });
  });

  describe("#trancheAndRollover", function () {
    let iceboxTranches1: Contract[], iceboxTranches2: Contract[], depositBond: Contract, depositTranches: Contract[];
    beforeEach(async function () {
      await feeStrategy.setBurnFee(toFixedPtAmt("10"));

      const iceboxBond1 = await bondAt(await perp.callStatic.getDepositBond());
      iceboxTranches1 = await getTranches(iceboxBond1);
      await depositIntoBond(iceboxBond1, toFixedPtAmt("1000"), deployer);
      await iceboxTranches1[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(iceboxTranches1[0].address, toFixedPtAmt("200"));
      await iceboxTranches1[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(iceboxTranches1[1].address, toFixedPtAmt("300"));

      await advancePerpQueue(perp, 1200);

      const iceboxBond2 = await bondAt(await perp.callStatic.getDepositBond());
      iceboxTranches2 = await getTranches(iceboxBond2);
      await depositIntoBond(iceboxBond2, toFixedPtAmt("1000"), deployer);
      await iceboxTranches2[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(iceboxTranches2[0].address, toFixedPtAmt("200"));
      await iceboxTranches2[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(iceboxTranches2[1].address, toFixedPtAmt("300"));

      await advancePerpQueue(perp, 7200);

      depositBond = await bondAt(await perp.callStatic.getDepositBond());
      depositTranches = await getTranches(depositBond);
    });

    describe("successful tranche & rollover and return the remainder", function () {
      beforeEach(async function () {
        await await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
        await perp.approve(router.address, toFixedPtAmt("15"));

        await mintCollteralToken(collateralToken, toFixedPtAmt("2000"), deployer);
        await collateralToken.approve(router.address, toFixedPtAmt("2000"));

        expect(await iceboxTranches1[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await iceboxTranches1[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await iceboxTranches2[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[0].balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[1].balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("850"));

        await router.trancheAndRollover(
          perp.address,
          depositBond.address,
          toFixedPtAmt("2000"),
          [
            [depositTranches[0].address, iceboxTranches1[0].address, toFixedPtAmt("200")],
            [depositTranches[1].address, iceboxTranches1[1].address, toFixedPtAmt("300")],
            [depositTranches[0].address, iceboxTranches2[0].address, toFixedPtAmt("200")],
          ],
          toFixedPtAmt("15"),
        );
      });

      it("should transfer tranches out", async function () {
        expect(await iceboxTranches1[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("200"));
        expect(await iceboxTranches1[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("300"));
        expect(await iceboxTranches2[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("200"));
        expect(await depositTranches[0].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("300"));
        expect(await depositTranches[0].balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
        expect(await depositTranches[1].balanceOf(router.address)).to.eq(toFixedPtAmt("0"));
      });

      it("should transfer excess fees back", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("847"));
      });
    });
  });
});
