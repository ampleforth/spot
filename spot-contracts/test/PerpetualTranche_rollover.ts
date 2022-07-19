import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Transaction, Signer, constants } from "ethers";

import {
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toYieldFixedPtAmt,
  toPriceFixedPtAmt,
  advancePerpQueue,
  advancePerpQueueToBondMaturity,
  checkReserveComposition,
  rebase,
} from "./helpers";

let perp: Contract,
  bondFactory: Contract,
  collateralToken: Contract,
  rebaseOracle: Contract,
  issuer: Contract,
  feeStrategy: Contract,
  pricingStrategy: Contract,
  yieldStrategy: Contract,
  deployer: Signer,
  deployerAddress: string,
  holdingPenBond: Contract,
  holdingPenTranche1: Contract,
  reserveBond: Contract,
  reserveTranche1: Contract,
  reserveTranche2: Contract,
  rolloverInBond: Contract,
  rolloverInTranche: Contract;

describe("PerpetualTranche", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    deployerAddress = await deployer.getAddress();

    bondFactory = await setupBondFactory();
    ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));
    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await BondIssuer.deploy(bondFactory.address, 1200, 0, 10800, collateralToken.address, [500, 500]);

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

    await feeStrategy.setFeeToken(perp.address);
    await feeStrategy.setMintFee(toFixedPtAmt("0"));
    await feeStrategy.setBurnFee(toFixedPtAmt("0"));
    await feeStrategy.setRolloverFee(toFixedPtAmt("0"));

    await perp.updateTolerableTrancheMaturity(1200, 10800);
    await advancePerpQueue(perp, 10900);

    holdingPenBond = await bondAt(await perp.callStatic.getDepositBond());
    [holdingPenTranche1] = await getTranches(holdingPenBond);

    await depositIntoBond(holdingPenBond, toFixedPtAmt("2000"), deployer);

    await pricingStrategy.setTranchePrice(holdingPenTranche1.address, toPriceFixedPtAmt("1"));
    await yieldStrategy.setTrancheYield(holdingPenTranche1.address, toYieldFixedPtAmt("1"));
    await holdingPenTranche1.approve(perp.address, toFixedPtAmt("500"));
    await perp.deposit(holdingPenTranche1.address, toFixedPtAmt("500"));

    await advancePerpQueue(perp, 1200);

    reserveBond = await bondAt(await perp.callStatic.getDepositBond());
    [reserveTranche1, reserveTranche2] = await getTranches(reserveBond);

    await depositIntoBond(reserveBond, toFixedPtAmt("2000"), deployer);

    await pricingStrategy.setTranchePrice(reserveTranche1.address, toPriceFixedPtAmt("1"));
    await yieldStrategy.setTrancheYield(reserveTranche1.address, toYieldFixedPtAmt("1"));
    await reserveTranche1.approve(perp.address, toFixedPtAmt("500"));
    await perp.deposit(reserveTranche1.address, toFixedPtAmt("500"));

    await pricingStrategy.setTranchePrice(reserveTranche2.address, toPriceFixedPtAmt("1"));
    await yieldStrategy.setTrancheYield(reserveTranche2.address, toYieldFixedPtAmt("0.5"));
    await reserveTranche2.approve(perp.address, toFixedPtAmt("1000"));
    await perp.deposit(reserveTranche2.address, toFixedPtAmt("1000"));

    await advancePerpQueueToBondMaturity(perp, holdingPenBond);

    rolloverInBond = await bondAt(await perp.callStatic.getDepositBond());
    [rolloverInTranche] = await getTranches(rolloverInBond);

    await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("1"));
    await yieldStrategy.setTrancheYield(rolloverInTranche.address, toYieldFixedPtAmt("1"));

    await depositIntoBond(rolloverInBond, toFixedPtAmt("5000"), deployer);
    await rolloverInTranche.approve(perp.address, toFixedPtAmt("5000"));
    await perp.deposit(rolloverInTranche.address, toFixedPtAmt("500"));

    await checkReserveComposition(
      perp,
      [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche],
      [toFixedPtAmt("500"), toFixedPtAmt("1000"), toFixedPtAmt("500"), toFixedPtAmt("500")],
    );
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#rollover", function () {
    describe("when paused", function () {
      beforeEach(async function () {
        await perp.pause();
      });

      it("should revert", async function () {
        await expect(
          perp.rollover(rolloverInTranche.address, reserveTranche2.address, toFixedPtAmt("500")),
        ).to.revertedWith("Pausable: paused");
      });
    });

    describe("when trancheIn and tokenOut belong to the same bond", function () {
      let tranches: Contract[];
      beforeEach(async function () {
        tranches = await getTranches(rolloverInBond);
        await yieldStrategy.setTrancheYield(tranches[1].address, toYieldFixedPtAmt("1"));
      });
      it("should revert", async function () {
        await expect(
          perp.rollover(rolloverInTranche.address, tranches[1].address, toFixedPtAmt("500")),
        ).to.revertedWith("UnacceptableRollover");
      });
    });

    describe("when trancheIn is NOT of deposit bond", function () {
      it("should revert", async function () {
        await expect(
          perp.rollover(reserveTranche1.address, collateralToken.address, toFixedPtAmt("500")),
        ).to.revertedWith("UnacceptableRollover");
        await expect(
          perp.rollover(reserveTranche1.address, holdingPenTranche1.address, toFixedPtAmt("500")),
        ).to.revertedWith("UnacceptableRollover");
      });
    });

    describe("when tokenOut is NOT in the reserve", function () {
      let maliciousTranche: Contract;
      beforeEach(async function () {
        const bond = await createBondWithFactory(bondFactory, collateralToken, [1, 999], 86400);
        maliciousTranche = (await getTranches(bond))[0];
      });
      it("should revert", async function () {
        await expect(
          perp.rollover(rolloverInTranche.address, maliciousTranche.address, toFixedPtAmt("500")),
        ).to.revertedWith("UnacceptableRollover");
      });
    });

    describe("when tokenOut is still isAcceptableForReserve", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        await advancePerpQueue(perp, 1200);
        const newRotationInBond = await bondAt(await perp.callStatic.getDepositBond());
        [newRotationInTranche] = await getTranches(newRotationInBond);
      });
      it("should revert", async function () {
        await expect(
          perp.rollover(newRotationInTranche.address, rolloverInTranche.address, toFixedPtAmt("500")),
        ).to.revertedWith("UnacceptableRollover");
      });
    });

    describe("when user has insufficient tranche balance", function () {
      beforeEach(async function () {
        await rolloverInTranche.transfer("0x000000000000000000000000000000000000dead", toFixedPtAmt("1501"));
      });

      it("should revert", async function () {
        expect(await rolloverInTranche.balanceOf(deployerAddress)).to.lt(toFixedPtAmt("500"));
        await expect(
          perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
        ).to.revertedWith("ERC20: transfer amount exceeds balance");
      });
    });

    describe("when user has insufficient approval", function () {
      beforeEach(async function () {
        await rolloverInTranche.approve(perp.address, toFixedPtAmt("0"));
      });

      it("should revert", async function () {
        expect(await rolloverInTranche.allowance(deployerAddress, perp.address)).to.lte(toFixedPtAmt("500"));
        await expect(
          perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
        ).to.revertedWith("ERC20: transfer amount exceeds allowance");
      });
    });

    describe("when trancheInAmt is zero", function () {
      it("should revert", async function () {
        await expect(
          perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("0")),
        ).to.revertedWith("UnacceptableRolloverAmt");
      });
    });

    describe("when tokenIn yield is zero", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        const tranches = await getTranches(rolloverInBond);
        newRotationInTranche = tranches[1];
      });

      it("should be reverted", async function () {
        await expect(
          perp.rollover(newRotationInTranche.address, reserveTranche1.address, toFixedPtAmt("0")),
        ).to.revertedWith("UnacceptableRolloverAmt");
      });
    });

    describe("when trancheIn yield is 0.5", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        const tranches = await getTranches(rolloverInBond);
        newRotationInTranche = tranches[1];
        await yieldStrategy.setTrancheYield(newRotationInTranche.address, toYieldFixedPtAmt("0.5"));
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          newRotationInTranche.address,
          reserveTranche1.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("250"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenOut yield is 0.5", function () {
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche2.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("500"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("1000"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when discount perc is zero", async function () {
      describe("when trancheIn price is zero", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("0"));
          await pricingStrategy.setTranchePrice(reserveTranche1.address, toPriceFixedPtAmt("1"));
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("0"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("0"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("0"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("0"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("0"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when tokenOut price is zero", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("1"));
          await pricingStrategy.setTranchePrice(reserveTranche1.address, toPriceFixedPtAmt("0"));
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("0"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("0"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("0"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("0"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("0"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when trancheIn price is 0.5", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("0.5"));
          await pricingStrategy.setTranchePrice(reserveTranche1.address, toPriceFixedPtAmt("1"));
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          // 250 / 1750 * 2000
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("285.714285714285714285"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("250"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("tokenOut price is 0.5", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("1"));
          await pricingStrategy.setTranchePrice(reserveTranche1.address, toPriceFixedPtAmt("0.5"));
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          // 250 / 1750 * 2000
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("285.714285714285714285"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("250"));
        });
      });

      describe("tokenOut is collateral which rebased up", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("1"));
          await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("2"));
          await rebase(collateralToken, rebaseOracle, +1);
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            collateralToken.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          // 500 / 2500 * 2000
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("400"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("250"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("tokenOut is collateral which rebased down", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("1"));
          await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("0.5"));
          await rebase(collateralToken, rebaseOracle, -0.5);
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            collateralToken.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          // 250 / 1750 * 2000
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("285.714285714285714285"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("250"));
        });
      });

      describe("tokenIn yield is 0.5 and tokenOut is collateral which rebased up", function () {
        let rolloverInTranche2: Contract;
        beforeEach(async function () {
          const rolloverInTranches = await getTranches(rolloverInBond);
          rolloverInTranche2 = rolloverInTranches[1];
          await pricingStrategy.setTranchePrice(rolloverInTranche2.address, toPriceFixedPtAmt("1"));
          await yieldStrategy.setTrancheYield(rolloverInTranche2.address, toYieldFixedPtAmt("0.5"));
          await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("2"));
          await rebase(collateralToken, rebaseOracle, +1);
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche2.address,
            collateralToken.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          // 250 / 2500 * 2000
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("200"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("125"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("tokenIn yield is 0.5 and tokenOut is collateral which rebased down", function () {
        let rolloverInTranche2: Contract;
        beforeEach(async function () {
          const rolloverInTranches = await getTranches(rolloverInBond);
          rolloverInTranche2 = rolloverInTranches[1];
          await pricingStrategy.setTranchePrice(rolloverInTranche2.address, toPriceFixedPtAmt("1"));
          await yieldStrategy.setTrancheYield(rolloverInTranche2.address, toYieldFixedPtAmt("0.5"));
          await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("0.5"));
          await rebase(collateralToken, rebaseOracle, -0.5);
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche2.address,
            collateralToken.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          // 250 / 1750 * 2000
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("285.714285714285714285"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });
    });

    describe("when discount perc is 50%", async function () {
      beforeEach(async function () {
        await feeStrategy.setRolloverDiscountPerc("50000000");
      });

      describe("when trancheIn price is zero", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("0"));
          await pricingStrategy.setTranchePrice(reserveTranche1.address, toPriceFixedPtAmt("1"));
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("0"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("0"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("0"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("0"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("0"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when tokenOut price is zero", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("1"));
          await pricingStrategy.setTranchePrice(reserveTranche1.address, toPriceFixedPtAmt("0"));
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("0"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("0"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("0"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("0"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("0"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when trancheIn price is 0.5", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("0.5"));
          await pricingStrategy.setTranchePrice(reserveTranche1.address, toPriceFixedPtAmt("1"));
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("142.857142857142857142"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("125"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("125"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("tokenOut price is 0.5", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("1"));
          await pricingStrategy.setTranchePrice(reserveTranche1.address, toPriceFixedPtAmt("0.5"));
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("285.714285714285714285"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("tokenOut is collateral which rebased up", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("1"));
          await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("2"));
          await rebase(collateralToken, rebaseOracle, +1);
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            collateralToken.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("200"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("125"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("tokenOut is collateral which rebased down", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("1"));
          await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("0.5"));
          await rebase(collateralToken, rebaseOracle, -0.5);
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            collateralToken.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("285.714285714285714285"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("tokenIn yield is 0.5 and tokenOut is collateral which rebased up", function () {
        let rolloverInTranche2: Contract;
        beforeEach(async function () {
          const rolloverInTranches = await getTranches(rolloverInBond);
          rolloverInTranche2 = rolloverInTranches[1];
          await pricingStrategy.setTranchePrice(rolloverInTranche2.address, toPriceFixedPtAmt("1"));
          await yieldStrategy.setTrancheYield(rolloverInTranche2.address, toYieldFixedPtAmt("0.5"));
          await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("2"));
          await rebase(collateralToken, rebaseOracle, 1);
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche2.address,
            collateralToken.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("100"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("125"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("62.5"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("tokenIn yield is 0.5 and tokenOut is collateral which rebased down", function () {
        let rolloverInTranche2: Contract;
        beforeEach(async function () {
          const rolloverInTranches = await getTranches(rolloverInBond);
          rolloverInTranche2 = rolloverInTranches[1];
          await pricingStrategy.setTranchePrice(rolloverInTranche2.address, toPriceFixedPtAmt("1"));
          await yieldStrategy.setTrancheYield(rolloverInTranche2.address, toYieldFixedPtAmt("0.5"));
          await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("0.5"));
          await rebase(collateralToken, rebaseOracle, -0.5);
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche2.address,
            collateralToken.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("142.857142857142857142"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("125"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("250"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });
    });

    describe("when discount perc is -50%", async function () {
      beforeEach(async function () {
        await feeStrategy.setRolloverDiscountPerc("-50000000");
      });

      describe("when trancheIn price is 0.5", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("0.5"));
          await pricingStrategy.setTranchePrice(reserveTranche1.address, toPriceFixedPtAmt("1"));
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("428.571428571428571428"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("375"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("375"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("tokenOut price is 0.5", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("1"));
          await pricingStrategy.setTranchePrice(reserveTranche1.address, toPriceFixedPtAmt("0.5"));
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("285.714285714285714285"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("166.666666666666666666"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("166.666666666666666666"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("333.333333333333333334"));
        });
      });

      describe("tokenOut is collateral which rebased up", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("1"));
          await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("2"));
          await rebase(collateralToken, rebaseOracle, +1);
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            collateralToken.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("600"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("750"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("375"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("tokenOut is collateral which rebased down", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(rolloverInTranche.address, toPriceFixedPtAmt("1"));
          await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("0.5"));
          await rebase(collateralToken, rebaseOracle, -0.5);
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            collateralToken.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("285.714285714285714285"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("166.666666666666666666"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("166.666666666666666666"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("333.333333333333333334"));
        });
      });

      describe("tokenIn yield is 0.5 and tokenOut is collateral which rebased up", function () {
        let rolloverInTranche2: Contract;
        beforeEach(async function () {
          const rolloverInTranches = await getTranches(rolloverInBond);
          rolloverInTranche2 = rolloverInTranches[1];
          await pricingStrategy.setTranchePrice(rolloverInTranche2.address, toPriceFixedPtAmt("1"));
          await yieldStrategy.setTrancheYield(rolloverInTranche2.address, toYieldFixedPtAmt("0.5"));
          await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("2"));
          await rebase(collateralToken, rebaseOracle, +1);
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche2.address,
            collateralToken.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("300"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("375"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("187.5"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("tokenIn yield is 0.5 and tokenOut is collateral which rebased down", function () {
        let rolloverInTranche2: Contract;
        beforeEach(async function () {
          const rolloverInTranches = await getTranches(rolloverInBond);
          rolloverInTranche2 = rolloverInTranches[1];
          await pricingStrategy.setTranchePrice(rolloverInTranche2.address, toPriceFixedPtAmt("1"));
          await yieldStrategy.setTrancheYield(rolloverInTranche2.address, toYieldFixedPtAmt("0.5"));
          await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("0.5"));
          await rebase(collateralToken, rebaseOracle, -0.5);
        });

        it("should rollover the correct amount", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche2.address,
            collateralToken.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("285.714285714285714285"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("166.666666666666666666"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("333.333333333333333332"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("166.666666666666666668"));
        });
      });
    });

    describe("when tokenOut is tranche and not covered", function () {
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche1.address,
          toFixedPtAmt("500"),
          toFixedPtAmt("250"),
        );
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("250"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when tokenOut is collateral and not covered", function () {
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          toFixedPtAmt("250"),
        );
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("250"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when tokenOut is collateral has rebased down", function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.25);
      });
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("500"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("375"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenOut is collateral has rebased up", function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, 0.25);
      });
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("500"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("625"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenIn has 0.5 yield, tokenOut is collateral has rebased down", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        const tranches = await getTranches(rolloverInBond);
        newRotationInTranche = tranches[1];
        await pricingStrategy.setTranchePrice(newRotationInTranche.address, toPriceFixedPtAmt("1"));
        await yieldStrategy.setTrancheYield(newRotationInTranche.address, toYieldFixedPtAmt("0.5"));
        await rebase(collateralToken, rebaseOracle, -0.25);
      });
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          newRotationInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("250"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("187.5"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenIn has 0.5 yield, tokenOut is collateral has rebased up", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        const tranches = await getTranches(rolloverInBond);
        newRotationInTranche = tranches[1];
        await pricingStrategy.setTranchePrice(newRotationInTranche.address, toPriceFixedPtAmt("1"));
        await yieldStrategy.setTrancheYield(newRotationInTranche.address, toYieldFixedPtAmt("0.5"));
        await rebase(collateralToken, rebaseOracle, 0.25);
      });
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          newRotationInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("250"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("312.5"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenIn has 0.5 yield, tokenOut is collateral has rebased down and NOT covered", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        const tranches = await getTranches(rolloverInBond);
        newRotationInTranche = tranches[1];
        await pricingStrategy.setTranchePrice(newRotationInTranche.address, toPriceFixedPtAmt("1"));
        await yieldStrategy.setTrancheYield(newRotationInTranche.address, toYieldFixedPtAmt("0.5"));
        await rebase(collateralToken, rebaseOracle, -0.25);
      });
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          newRotationInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          toFixedPtAmt("93.75"),
        );
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("125"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("93.75"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("125"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("125"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when tokenIn has 0.5 yield, tokenOut is collateral has rebased up and NOT covered", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        const tranches = await getTranches(rolloverInBond);
        newRotationInTranche = tranches[1];
        await pricingStrategy.setTranchePrice(newRotationInTranche.address, toPriceFixedPtAmt("1"));
        await yieldStrategy.setTrancheYield(newRotationInTranche.address, toYieldFixedPtAmt("0.5"));
        await rebase(collateralToken, rebaseOracle, 0.25);
      });
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          newRotationInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          toFixedPtAmt("156.25"),
        );
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("125"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("156.25"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("125"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("125"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when fee is in native token", function () {
      describe("when fee is zero", function () {
        it("should transfer the tranches in", async function () {
          await expect(() =>
            perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(rolloverInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
        });
        it("should transfer the tranches out", async function () {
          await expect(() =>
            perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(reserveTranche1, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
        });
        it("should charge fee", async function () {
          await expect(() =>
            perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalance(perp, perp, toFixedPtAmt("0"));
        });
        it("should calculate rollover amt", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("500"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("when fee > 0", function () {
        beforeEach(async function () {
          await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
        });
        it("should transfer the tranches in", async function () {
          await expect(() =>
            perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(rolloverInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
        });
        it("should transfer the tranches out", async function () {
          await expect(() =>
            perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(reserveTranche1, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
        });
        it("should charge fee", async function () {
          await expect(() =>
            perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalance(perp, perp, toFixedPtAmt("1"));
        });
        it("should calculate rollover amt", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("500"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("when fee < 0", function () {
        beforeEach(async function () {
          await perp.transfer(perp.address, toFixedPtAmt("1"));
          await feeStrategy.setRolloverFee(toFixedPtAmt("-1"));
        });
        it("should transfer the tranches in", async function () {
          await expect(() =>
            perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(rolloverInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
        });
        it("should transfer the tranches out", async function () {
          await expect(() =>
            perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(reserveTranche1, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
        });
        it("should charge fee", async function () {
          await expect(() =>
            perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalance(perp, perp, toFixedPtAmt("-1"));
        });
        it("should calculate rollover amt", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("500"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });
    });

    describe("when fee is in non-native token", function () {
      let feeToken: Contract;
      beforeEach(async function () {
        const ERC20 = await ethers.getContractFactory("MockERC20");
        feeToken = await ERC20.deploy();
        await feeToken.init("Mock token", "MOCK");
        await feeStrategy.setFeeToken(feeToken.address);
      });

      describe("when fee is zero", async function () {
        it("should transfer the tranches in", async function () {
          await expect(() =>
            perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(rolloverInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
        });
        it("should transfer the tranches out", async function () {
          await expect(() =>
            perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(reserveTranche1, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
        });
        it("should charge fee", async function () {
          await expect(() =>
            perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalance(feeToken, perp, toFixedPtAmt("0"));
        });
        it("should calculate rollover amt", async function () {
          const r = await perp.callStatic.computeRolloverAmt(
            rolloverInTranche.address,
            reserveTranche1.address,
            toFixedPtAmt("500"),
            constants.MaxUint256,
          );
          expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("500"));
          expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
          expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
          expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("when fee > 0", async function () {
        beforeEach(async function () {
          await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
        });

        describe("with no approval", function () {
          it("should revert", async function () {
            await expect(
              perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
            ).to.be.revertedWith("ERC20: insufficient allowance");
          });
        });

        describe("with insufficient balance", function () {
          beforeEach(async function () {
            await feeToken.approve(perp.address, toFixedPtAmt("1"));
          });

          it("should revert", async function () {
            await expect(
              perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
            ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
          });
        });

        describe("with sufficient fee", async function () {
          beforeEach(async function () {
            await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
            await feeToken.mint(deployerAddress, toFixedPtAmt("1"));
            await feeToken.approve(perp.address, toFixedPtAmt("1"));
          });

          it("should transfer the tranches in", async function () {
            await expect(() =>
              perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
            ).to.changeTokenBalances(rolloverInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
          });
          it("should transfer the tranches out", async function () {
            await expect(() =>
              perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
            ).to.changeTokenBalances(reserveTranche1, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
          });
          it("should charge fee", async function () {
            await expect(() =>
              perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
            ).to.changeTokenBalance(feeToken, perp, toFixedPtAmt("1"));
          });
          it("should calculate rollover amt", async function () {
            const r = await perp.callStatic.computeRolloverAmt(
              rolloverInTranche.address,
              reserveTranche1.address,
              toFixedPtAmt("500"),
              constants.MaxUint256,
            );
            expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("500"));
            expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
            expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
            expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
            expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
            expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
          });
        });
      });

      describe("when fee < 0", async function () {
        beforeEach(async function () {
          await feeStrategy.setRolloverFee(toFixedPtAmt("-1"));
        });
        describe("with insufficient balance", function () {
          it("should revert", async function () {
            await expect(
              perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
            ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
          });
        });

        describe("with sufficient balance", function () {
          beforeEach(async function () {
            await feeToken.mint(perp.address, toFixedPtAmt("1"));
          });

          it("should transfer the tranches in", async function () {
            await expect(() =>
              perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
            ).to.changeTokenBalances(rolloverInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
          });
          it("should transfer the tranches out", async function () {
            await expect(() =>
              perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
            ).to.changeTokenBalances(reserveTranche1, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
          });
          it("should charge fee", async function () {
            await expect(() =>
              perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500")),
            ).to.changeTokenBalance(feeToken, perp, toFixedPtAmt("-1"));
          });
          it("should calculate rollover amt", async function () {
            const r = await perp.callStatic.computeRolloverAmt(
              rolloverInTranche.address,
              reserveTranche1.address,
              toFixedPtAmt("500"),
              constants.MaxUint256,
            );
            expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("500"));
            expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
            expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
            expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
            expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
            expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
          });
        });
      });
    });

    describe("when tokenIn is not in the reserve", async function () {
      let tx: Transaction, newRotationInTranche: Contract, r: any;
      beforeEach(async function () {
        const tranches = await getTranches(rolloverInBond);
        newRotationInTranche = tranches[1];
        await pricingStrategy.setTranchePrice(newRotationInTranche.address, toPriceFixedPtAmt("1"));
        await yieldStrategy.setTrancheYield(newRotationInTranche.address, toYieldFixedPtAmt("1"));

        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("500"));

        await newRotationInTranche.approve(perp.address, toFixedPtAmt("250"));

        r = await perp.callStatic.computeRolloverAmt(
          newRotationInTranche.address,
          reserveTranche1.address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        tx = perp.rollover(newRotationInTranche.address, reserveTranche1.address, toFixedPtAmt("250"));
        await tx;
      });

      it("should NOT update tranche balances", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("500"));
      });
      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche, newRotationInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("1000"), toFixedPtAmt("250"), toFixedPtAmt("500"), toFixedPtAmt("250")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(newRotationInTranche.address, toFixedPtAmt("250"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche1.address, toFixedPtAmt("250"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("250"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenOut is a reserve tranche", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        await checkReserveComposition(perp, [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche]);
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("500"));
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche1.address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("250"));
        await tx;
      });

      it("should NOT update tranche balances", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("500"));
      });
      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("1000"), toFixedPtAmt("250"), toFixedPtAmt("750")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("750"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche1.address, toFixedPtAmt("250"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("250"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenOut is the mature collateral", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        await checkReserveComposition(perp, [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche]);
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("500"));
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, collateralToken.address, toFixedPtAmt("250"));
        await tx;
      });

      it("should emit tranche balance update", async function () {
        await expect(tx).to.emit(perp, "UpdatedMatureTrancheBalance").withArgs(toFixedPtAmt("250"));
      });
      it("should update mature tranche balance", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("250"));
      });
      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche],
          [toFixedPtAmt("250"), toFixedPtAmt("1000"), toFixedPtAmt("500"), toFixedPtAmt("750")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("250"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("250"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("250"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenOut is the mature collateral which has rebased up", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, +0.5);
        await checkReserveComposition(perp, [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche]);
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("500"));
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, collateralToken.address, toFixedPtAmt("250"));
        await tx;
      });

      it("should emit tranche balance update", async function () {
        await expect(tx).to.emit(perp, "UpdatedMatureTrancheBalance").withArgs(toFixedPtAmt("250"));
      });
      it("should update mature tranche balance", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("250"));
      });
      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche],
          [toFixedPtAmt("375"), toFixedPtAmt("1000"), toFixedPtAmt("500"), toFixedPtAmt("750")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("250"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("375"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("250"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("375"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenOut is the mature collateral which has rebased down", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.5);
        await checkReserveComposition(perp, [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche]);
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("500"));
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, collateralToken.address, toFixedPtAmt("250"));
        await tx;
      });

      it("should emit tranche balance update", async function () {
        await expect(tx).to.emit(perp, "UpdatedMatureTrancheBalance").withArgs(toFixedPtAmt("250"));
      });
      it("should update mature tranche balance", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("250"));
      });
      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche],
          [toFixedPtAmt("125"), toFixedPtAmt("1000"), toFixedPtAmt("500"), toFixedPtAmt("750")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("250"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("125"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("250"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("125"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenOut is tranche and fully withdrawn", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        await checkReserveComposition(perp, [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche]);
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche1.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("500"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche2, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("1000"), toFixedPtAmt("1000")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("1000"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche1.address, toFixedPtAmt("0"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("500"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenOut is collateral and fully withdrawn", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        await checkReserveComposition(perp, [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche]);
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, collateralToken.address, toFixedPtAmt("500"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche],
          [toFixedPtAmt("0"), toFixedPtAmt("1000"), toFixedPtAmt("500"), toFixedPtAmt("1000")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("1000"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("0"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("500"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenOut is partially redeemed", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        await checkReserveComposition(perp, [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche]);
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche1.address,
          toFixedPtAmt("100"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("100"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("1000"), toFixedPtAmt("400"), toFixedPtAmt("600")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("600"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche1.address, toFixedPtAmt("400"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("100"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("100"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("100"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("100"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("100"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenOut is NOT covered", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche1.address,
          toFixedPtAmt("2000"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, reserveTranche1.address, toFixedPtAmt("2000"));
        await tx;
      });

      it("should update the reserve (only transfers covered amount)", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche2, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("1000"), toFixedPtAmt("1000")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("1000"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche1.address, toFixedPtAmt("0"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("500"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("1500"));
      });
    });

    describe("when discount perc is set to 50%", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        await checkReserveComposition(perp, [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche]);
        await feeStrategy.setRolloverDiscountPerc("50000000");
        await pricingStrategy.setTranchePrice(collateralToken.address, toPriceFixedPtAmt("2"));
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("500"));
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("100"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, collateralToken.address, toFixedPtAmt("100"));
        await tx;
      });

      it("should emit tranche balance update", async function () {
        await expect(tx).to.emit(perp, "UpdatedMatureTrancheBalance").withArgs(toFixedPtAmt("475"));
      });

      it("should update tranche balances", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("475"));
      });

      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche2, reserveTranche1, rolloverInTranche],
          [toFixedPtAmt("475"), toFixedPtAmt("1000"), toFixedPtAmt("500"), toFixedPtAmt("600")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("600"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("475"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.perpRolloverAmt).to.eq(toFixedPtAmt("40"));
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("25"));
        expect(r.stdTrancheOutAmt).to.eq(toFixedPtAmt("25"));
        expect(r.stdTrancheInAmt).to.eq(toFixedPtAmt("100"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("100"));
        expect(r.remainingTrancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });
  });
});
