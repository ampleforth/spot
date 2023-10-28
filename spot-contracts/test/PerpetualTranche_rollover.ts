import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Transaction, Signer, constants } from "ethers";
import { smock } from "@defi-wonderland/smock";
import {
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toPriceFixedPtAmt,
  toPercFixedPtAmt,
  advancePerpQueue,
  advancePerpQueueToBondMaturity,
  checkReserveComposition,
  rebase,
} from "./helpers";
use(smock.matchers);

let perp: Contract,
  bondFactory: Contract,
  collateralToken: Contract,
  rebaseOracle: Contract,
  issuer: Contract,
  feeStrategy: Contract,
  pricingStrategy: Contract,
  deployer: Signer,
  otherUser: Signer,
  deployerAddress: string,
  holdingPenBond: Contract,
  holdingPenTranche1: Contract,
  reserveBond: Contract,
  reserveTranche: Contract,
  rolloverInBond: Contract,
  rolloverInTranche: Contract;

describe("PerpetualTranche", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];
    deployerAddress = await deployer.getAddress();

    bondFactory = await setupBondFactory();
    ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));
    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
    await issuer.init(10800, [500, 500], 1200, 0);

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

    await perp.updateTolerableTrancheMaturity(1200, 10800);
    await advancePerpQueue(perp, 10900);

    holdingPenBond = await bondAt(await perp.callStatic.getDepositBond());
    [holdingPenTranche1] = await getTranches(holdingPenBond);

    await depositIntoBond(holdingPenBond, toFixedPtAmt("2000"), deployer);

    await holdingPenTranche1.approve(perp.address, toFixedPtAmt("500"));
    await perp.deposit(holdingPenTranche1.address, toFixedPtAmt("500"));

    await advancePerpQueue(perp, 1200);

    reserveBond = await bondAt(await perp.callStatic.getDepositBond());
    [reserveTranche] = await getTranches(reserveBond);

    await depositIntoBond(reserveBond, toFixedPtAmt("2000"), deployer);

    await reserveTranche.approve(perp.address, toFixedPtAmt("500"));
    await perp.deposit(reserveTranche.address, toFixedPtAmt("500"));
    await advancePerpQueueToBondMaturity(perp, holdingPenBond);

    rolloverInBond = await bondAt(await perp.callStatic.getDepositBond());
    [rolloverInTranche] = await getTranches(rolloverInBond);

    await depositIntoBond(rolloverInBond, toFixedPtAmt("5000"), deployer);
    await rolloverInTranche.approve(perp.address, toFixedPtAmt("5000"));
    await perp.deposit(rolloverInTranche.address, toFixedPtAmt("500"));

    await checkReserveComposition(
      perp,
      [collateralToken, reserveTranche, rolloverInTranche],
      [toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("500")],
    );
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#rollover", function () {
    describe("when paused", function () {
      beforeEach(async function () {
        await perp.updateKeeper(deployerAddress);
        await perp.pause();
      });

      it("should revert", async function () {
        await expect(
          perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.revertedWith("Pausable: paused");
      });
    });

    describe("when rollers are authorized", function () {
      beforeEach(async function () {
        await perp.authorizeRoller(await otherUser.getAddress(), true);
      });

      it("should revert when invoked from unauthorized roller ", async function () {
        await expect(
          perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnauthorizedCall");
      });

      it("should NOT revert when invoked from authorized roller ", async function () {
        await rolloverInTranche.transfer(await otherUser.getAddress(), toFixedPtAmt("500"));
        await rolloverInTranche.connect(otherUser).approve(perp.address, toFixedPtAmt("500"));
        await expect(
          perp.connect(otherUser).rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).not.to.be.reverted;
      });
    });

    describe("when trancheIn and tokenOut belong to the same bond", function () {
      let tranches: Contract[];
      beforeEach(async function () {
        tranches = await getTranches(rolloverInBond);
      });
      it("should revert", async function () {
        await expect(
          perp.rollover(rolloverInTranche.address, tranches[1].address, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
      });
    });

    describe("when trancheIn is NOT of deposit bond", function () {
      it("should revert", async function () {
        await expect(
          perp.rollover(reserveTranche.address, collateralToken.address, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
        await expect(
          perp.rollover(reserveTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
        await expect(
          perp.rollover(reserveTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
        await expect(
          perp.rollover(reserveTranche.address, holdingPenTranche1.address, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
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
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
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
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
      });
    });

    describe("when the malicious trancheIn which points to the deposit bond is rolled in", function () {
      let maliciousTranche: Contract;
      beforeEach(async function () {
        const ERC20 = await ethers.getContractFactory("MockTranche");
        maliciousTranche = await ERC20.deploy();
        await maliciousTranche.init("Tranche", "TRA");
        await maliciousTranche.mint(deployerAddress, toFixedPtAmt("500"));
        await maliciousTranche.setBond(await perp.callStatic.getDepositBond());
        await maliciousTranche.approve(perp.address, toFixedPtAmt("500"));
      });
      it("should revert", async function () {
        await expect(
          perp.rollover(maliciousTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
      });
    });

    describe("when user has insufficient tranche balance", function () {
      beforeEach(async function () {
        await rolloverInTranche.transfer("0x000000000000000000000000000000000000dead", toFixedPtAmt("1501"));
      });

      it("should revert", async function () {
        expect(await rolloverInTranche.balanceOf(deployerAddress)).to.lt(toFixedPtAmt("500"));
        await expect(
          perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("500")),
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
          perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.revertedWith("ERC20: transfer amount exceeds allowance");
      });
    });

    describe("when trancheInAmt is zero", function () {
      it("should return without rollover", async function () {
        const r = await perp.callStatic.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("0"));
        expect(r.tokenOutAmt).to.eq("0");
        expect(r.trancheInAmt).to.eq("0");
      });
    });

    describe("when tokenIn is not acceptable", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        const tranches = await getTranches(rolloverInBond);
        newRotationInTranche = tranches[1];
      });

      it("should revert", async function () {
        await expect(
          perp.rollover(newRotationInTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.revertedWith("UnacceptableRollover");
      });
    });

    describe("when trancheIn price is zero", function () {
      beforeEach(async function () {
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(rolloverInTranche.address)
          .returns(toPriceFixedPtAmt("0"));
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("0"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when tokenOut price is zero", function () {
      beforeEach(async function () {
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(reserveTranche.address)
          .returns(toPriceFixedPtAmt("0"));
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("0"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when trancheIn price is 0.5", function () {
      beforeEach(async function () {
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(rolloverInTranche.address)
          .returns(toPriceFixedPtAmt("0.5"));
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("tokenOut price is 0.5", function () {
      beforeEach(async function () {
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(reserveTranche.address)
          .returns(toPriceFixedPtAmt("0.5"));
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("tokenOut is collateral which rebased up", function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, +1);
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("tokenOut is collateral which rebased down", function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.5);
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("tokenIn price is 0.5 and tokenOut is collateral which rebased up", function () {
      let rolloverInTranche2: Contract;
      beforeEach(async function () {
        const rolloverInTranches = await getTranches(rolloverInBond);
        rolloverInTranche2 = rolloverInTranches[1];
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(rolloverInTranche2.address)
          .returns(toPriceFixedPtAmt("0.5"));
        await rebase(collateralToken, rebaseOracle, +1);
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche2.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("tokenIn price is 0.5 and tokenOut is collateral which rebased down", function () {
      let rolloverInTranche2: Contract;
      beforeEach(async function () {
        const rolloverInTranches = await getTranches(rolloverInBond);
        rolloverInTranche2 = rolloverInTranches[1];
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(rolloverInTranche2.address)
          .returns(toPriceFixedPtAmt("0.5"));
        await rebase(collateralToken, rebaseOracle, -0.5);
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche2.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when tokenOut is tranche and not covered", function () {
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("500"),
          toFixedPtAmt("250"),
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
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
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
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
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("375"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("375"));
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
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when tokenIn has 0.5 price, tokenOut is collateral has rebased down", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        const tranches = await getTranches(rolloverInBond);
        newRotationInTranche = tranches[1];
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(newRotationInTranche.address)
          .returns(toPriceFixedPtAmt("0.5"));
        await rebase(collateralToken, rebaseOracle, -0.25);
      });
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          newRotationInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when tokenIn has 0.5 price, tokenOut is collateral has rebased up", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        const tranches = await getTranches(rolloverInBond);
        newRotationInTranche = tranches[1];
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(newRotationInTranche.address)
          .returns(toPriceFixedPtAmt("0.5"));
        await rebase(collateralToken, rebaseOracle, 0.25);
      });
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          newRotationInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when tokenIn has 0.5 price, tokenOut is collateral has rebased down and NOT covered", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        const tranches = await getTranches(rolloverInBond);
        newRotationInTranche = tranches[1];
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(newRotationInTranche.address)
          .returns(toPriceFixedPtAmt("0.5"));
        await rebase(collateralToken, rebaseOracle, -0.25);
      });
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          newRotationInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          toFixedPtAmt("93.75"),
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("93.75"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("187.5"));
      });
    });

    describe("when tokenIn has 0.5 price, tokenOut is collateral has rebased up and NOT covered", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        const tranches = await getTranches(rolloverInBond);
        newRotationInTranche = tranches[1];
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(newRotationInTranche.address)
          .returns(toPriceFixedPtAmt("0.5"));
        await rebase(collateralToken, rebaseOracle, 0.25);
      });
      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          newRotationInTranche.address,
          collateralToken.address,
          toFixedPtAmt("500"),
          toFixedPtAmt("156.25"),
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("156.25"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("312.5"));
      });
    });

    describe("when fee is zero", function () {
      beforeEach(async function () {
        await feeStrategy.computeRolloverFeePerc.returns(toPercFixedPtAmt("0"));
      });
      it("should transfer the tranches in", async function () {
        await expect(() =>
          perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.changeTokenBalances(rolloverInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
      });
      it("should transfer the tranches out", async function () {
        await expect(() =>
          perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.changeTokenBalances(reserveTranche, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
      });
      it("should charge fee", async function () {
        await expect(() =>
          perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.changeTokenBalance(perp, perp, toFixedPtAmt("0"));
      });
      it("should calculate rollover amt", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when fee > 0", function () {
      beforeEach(async function () {
        await feeStrategy.computeRolloverFeePerc.returns(toPercFixedPtAmt("0.01"));
      });
      it("should transfer the tranches in", async function () {
        await expect(() =>
          perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.changeTokenBalances(rolloverInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
      });
      it("should transfer the tranches out", async function () {
        await expect(() =>
          perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.changeTokenBalances(reserveTranche, [deployer, perp], [toFixedPtAmt("495"), toFixedPtAmt("-495")]);
      });
      it("should calculate rollover amt", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("495"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when fee < 0", function () {
      beforeEach(async function () {
        await feeStrategy.computeRolloverFeePerc.returns(toPercFixedPtAmt("-0.01"));
      });
      it("should transfer the tranches in", async function () {
        await expect(() =>
          perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.changeTokenBalances(
          rolloverInTranche,
          [deployer, perp],
          [toFixedPtAmt("-495.049504950495049505"), toFixedPtAmt("495.049504950495049505")],
        );
      });
      it("should transfer the tranches out", async function () {
        await expect(() =>
          perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("500")),
        ).to.changeTokenBalances(reserveTranche, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
      });
      it("should calculate rollover amt", async function () {
        const r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("495.049504950495049505"));
      });
    });

    describe("when tokenIn is NOT yet in the reserve", async function () {
      let tx: Transaction, newRotationInTranche: Contract, r: any;
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, rolloverInBond); // advancing to next issuance
        const newRolloverInBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newRolloverInBond, toFixedPtAmt("1000"), deployer);
        [newRotationInTranche] = await getTranches(newRolloverInBond);
        await newRotationInTranche.approve(perp.address, toFixedPtAmt("250"));
        r = await perp.callStatic.computeRolloverAmt(
          newRotationInTranche.address,
          collateralToken.address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        tx = perp.rollover(newRotationInTranche.address, collateralToken.address, toFixedPtAmt("250"));
        await tx;
      });
      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, newRotationInTranche],
          [toFixedPtAmt("1250"), toFixedPtAmt("250")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(newRotationInTranche.address, toFixedPtAmt("250"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("1250"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when tokenOut is a reserve tranche", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("250"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("250"), toFixedPtAmt("750")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("750"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche.address, toFixedPtAmt("250"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when tokenOut is the mature collateral", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, collateralToken.address, toFixedPtAmt("250"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche, rolloverInTranche],
          [toFixedPtAmt("250"), toFixedPtAmt("500"), toFixedPtAmt("750")],
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
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when tokenOut is the mature collateral which has rebased up", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, +0.5);
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, collateralToken.address, toFixedPtAmt("250"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("750")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("250"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("500"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when tokenOut is the mature collateral which has rebased down", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.5);
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("250"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, collateralToken.address, toFixedPtAmt("250"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche, rolloverInTranche],
          [toFixedPtAmt("0"), toFixedPtAmt("500"), toFixedPtAmt("750")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("250"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("0"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when tokenOut is tranche and fully withdrawn", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("500"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("500"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("1000")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("1000"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche.address, toFixedPtAmt("0"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when tokenOut is collateral and fully withdrawn", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
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
          [collateralToken, reserveTranche, rolloverInTranche],
          [toFixedPtAmt("0"), toFixedPtAmt("500"), toFixedPtAmt("1000")],
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
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when tokenOut is partially redeemed", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("100"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("100"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("400"), toFixedPtAmt("600")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("600"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche.address, toFixedPtAmt("400"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("100"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("100"));
      });
    });

    describe("when tokenOut is NOT covered", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("2000"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("2000"));
        await tx;
      });

      it("should update the reserve (only transfers covered amount)", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("1000")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("1000"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche.address, toFixedPtAmt("0"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when tokenOut is NOT covered and fee > 0", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        await feeStrategy.computeRolloverFeePerc.returns(toPercFixedPtAmt("0.01"));
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("2000"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("2000"));
        await tx;
      });

      it("should update the reserve (only transfers covered amount)", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("1005.050505050505050506")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("1005.050505050505050506"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche.address, toFixedPtAmt("0"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("505.050505050505050506"));
      });
    });

    describe("when tokenOut is NOT covered and fee < 0", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        await feeStrategy.computeRolloverFeePerc.returns(toPercFixedPtAmt("-0.01"));
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          reserveTranche.address,
          toFixedPtAmt("2000"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, reserveTranche.address, toFixedPtAmt("2000"));
        await tx;
      });

      it("should update the reserve (only transfers covered amount)", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("995.049504950495049505")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("995.049504950495049505"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche.address, toFixedPtAmt("0"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("495.049504950495049505"));
      });
    });

    describe("when valid rollover", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.callStatic.computeRolloverAmt(
          rolloverInTranche.address,
          collateralToken.address,
          toFixedPtAmt("100"),
          constants.MaxUint256,
        );
        tx = perp.rollover(rolloverInTranche.address, collateralToken.address, toFixedPtAmt("100"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, reserveTranche, rolloverInTranche],
          [toFixedPtAmt("400"), toFixedPtAmt("500"), toFixedPtAmt("600")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.address, toFixedPtAmt("600"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("400"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("100"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("100"));
      });
    });
  });
});
