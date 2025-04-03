import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Transaction, Signer } from "ethers";
import {
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toPercFixedPtAmt,
  advancePerpQueue,
  advancePerpQueueToBondMaturity,
  advancePerpQueueToRollover,
  checkPerpComposition,
  rebase,
  mintCollteralToken,
  DMock,
} from "../helpers";

let perp: Contract,
  bondFactory: Contract,
  collateralToken: Contract,
  rebaseOracle: Contract,
  issuer: Contract,
  feePolicy: Contract,
  deployer: Signer,
  deployerAddress: string,
  holdingPenBond: Contract,
  holdingPenTranche1: Contract,
  reserveBond: Contract,
  reserveTranche: Contract,
  rolloverInBond: Contract,
  rolloverInTranche: Contract,
  mockVault: Contract;

describe("PerpetualTranche", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    deployerAddress = await deployer.getAddress();

    bondFactory = await setupBondFactory();
    ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));

    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await upgrades.deployProxy(
      BondIssuer.connect(deployer),
      [bondFactory.target, collateralToken.target, 10800, [500, 500], 1200, 0],
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

    const MockVault = await ethers.getContractFactory("MockVault");
    mockVault = await MockVault.deploy();

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await upgrades.deployProxy(
      PerpetualTranche.connect(deployer),
      ["PerpetualTranche", "PERP", collateralToken.target, issuer.target, feePolicy.target],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );

    await perp.updateTolerableTrancheMaturity(1200, 10800);
    await advancePerpQueue(perp, 10900);
    await perp.updateVault(mockVault.target);

    holdingPenBond = await bondAt(await perp.getDepositBond.staticCall());
    [holdingPenTranche1] = await getTranches(holdingPenBond);

    await depositIntoBond(holdingPenBond, toFixedPtAmt("2000"), deployer);

    await holdingPenTranche1.approve(perp.target, toFixedPtAmt("500"));
    await perp.deposit(holdingPenTranche1.target, toFixedPtAmt("500"));

    await advancePerpQueue(perp, 1200);

    reserveBond = await bondAt(await perp.getDepositBond.staticCall());
    [reserveTranche] = await getTranches(reserveBond);

    await depositIntoBond(reserveBond, toFixedPtAmt("2000"), deployer);

    await reserveTranche.approve(perp.target, toFixedPtAmt("500"));
    await perp.deposit(reserveTranche.target, toFixedPtAmt("500"));
    await advancePerpQueueToBondMaturity(perp, holdingPenBond);

    rolloverInBond = await bondAt(await perp.getDepositBond.staticCall());
    [rolloverInTranche] = await getTranches(rolloverInBond);

    await depositIntoBond(rolloverInBond, toFixedPtAmt("5000"), deployer);
    await rolloverInTranche.approve(perp.target, toFixedPtAmt("5000"));
    await perp.deposit(rolloverInTranche.target, toFixedPtAmt("500"));

    await checkPerpComposition(
      perp,
      [collateralToken, reserveTranche, rolloverInTranche],
      [toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("500")],
    );

    await rolloverInTranche.approve(mockVault.target, toFixedPtAmt("5000"));
    await reserveTranche.approve(mockVault.target, toFixedPtAmt("5000"));
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
          mockVault.rollover(perp.target, rolloverInTranche.target, reserveTranche.target, toFixedPtAmt("500")),
        ).to.revertedWith("Pausable: paused");
      });
    });

    describe("when rollover vault reference is set", function () {
      beforeEach(async function () {
        await perp.updateVault(mockVault.target);
      });

      it("should revert when invoked from other addresses", async function () {
        await expect(
          perp.rollover(rolloverInTranche.target, reserveTranche.target, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnauthorizedCall");
      });

      it("should NOT revert when invoked from the vault ", async function () {
        await rolloverInTranche.approve(mockVault.target, toFixedPtAmt("500"));
        await expect(
          mockVault.rollover(perp.target, rolloverInTranche.target, reserveTranche.target, toFixedPtAmt("500")),
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
          mockVault.rollover(perp.target, rolloverInTranche.target, tranches[1].target, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
      });
    });

    describe("when trancheIn is NOT of deposit bond", function () {
      it("should revert", async function () {
        await expect(
          mockVault.rollover(perp.target, reserveTranche.target, collateralToken.target, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
        await expect(
          mockVault.rollover(perp.target, reserveTranche.target, reserveTranche.target, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
        await expect(
          mockVault.rollover(perp.target, reserveTranche.target, reserveTranche.target, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
        await expect(
          mockVault.rollover(perp.target, reserveTranche.target, holdingPenTranche1.target, toFixedPtAmt("500")),
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
          mockVault.rollover(perp.target, rolloverInTranche.target, maliciousTranche.target, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
      });
    });

    describe("when tokenOut is still isAcceptableForReserve", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        await advancePerpQueue(perp, 1200);
        const newRotationInBond = await bondAt(await perp.getDepositBond.staticCall());
        [newRotationInTranche] = await getTranches(newRotationInBond);
        await depositIntoBond(newRotationInBond, toFixedPtAmt("2000"), deployer);
        await newRotationInTranche.approve(mockVault.target, toFixedPtAmt("500"));
      });
      it("should revert", async function () {
        await expect(
          mockVault.rollover(perp.target, newRotationInTranche.target, rolloverInTranche.target, toFixedPtAmt("500")),
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
        await maliciousTranche.setBond(await perp.getDepositBond.staticCall());
        await maliciousTranche.approve(mockVault.target, toFixedPtAmt("500"));
      });
      it("should revert", async function () {
        await expect(
          mockVault.rollover(perp.target, maliciousTranche.target, reserveTranche.target, toFixedPtAmt("500")),
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
          mockVault.rollover(perp.target, rolloverInTranche.target, reserveTranche.target, toFixedPtAmt("500")),
        ).to.revertedWith("ERC20: transfer amount exceeds balance");
      });
    });

    describe("when approval is insufficient", function () {
      it("should return without rollover", async function () {
        await rolloverInTranche.transfer(mockVault.target, toFixedPtAmt("500"));
        await expect(
          mockVault.callRollover(perp.target, rolloverInTranche.target, reserveTranche.target, toFixedPtAmt("500")),
        ).to.revertedWith("ERC20: transfer amount exceeds allowance");
      });
    });

    describe("when trancheInAmt is zero", function () {
      it("should return without rollover", async function () {
        const r = await mockVault.rollover.staticCall(
          perp.target,
          rolloverInTranche.target,
          reserveTranche.target,
          "0",
        );
        expect(r.tokenOutAmt).to.eq("0");
        expect(r.trancheInAmt).to.eq("0");
      });
    });

    describe("when trancheIn is not acceptable", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        const tranches = await getTranches(rolloverInBond);
        newRotationInTranche = tranches[1];
        await newRotationInTranche.approve(mockVault.target, toFixedPtAmt("500"));
      });

      it("should revert", async function () {
        await expect(
          mockVault.rollover(perp.target, newRotationInTranche.target, reserveTranche.target, toFixedPtAmt("500")),
        ).to.revertedWithCustomError(perp, "UnacceptableRollover");
      });
    });

    describe("when trancheIn price is 0.5", function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.75);
        await mintCollteralToken(collateralToken, toFixedPtAmt("1000"), deployer);
        await collateralToken.transfer(perp.target, toFixedPtAmt("1000"));
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          collateralToken.target,
          toFixedPtAmt("500"),
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("trancheOut price is 0.5", function () {
      let newRotationInTranche: Contract, newReserveTranche: Contract;
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.75);
        await advancePerpQueueToRollover(perp, await bondAt(await rolloverInTranche.bond()));

        newReserveTranche = rolloverInTranche;
        const newDepositBond = await bondAt(await perp.getDepositBond.staticCall());
        [newRotationInTranche] = await getTranches(newDepositBond);
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.computeRolloverAmt.staticCall(
          newRotationInTranche.target,
          newReserveTranche.target,
          toFixedPtAmt("500"),
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
        const r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          collateralToken.target,
          toFixedPtAmt("500"),
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
        const r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          collateralToken.target,
          toFixedPtAmt("500"),
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when trancheIn price is 0.5 and tokenOut is collateral which rebased up", function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.75);
        // simulating collateral rebase up, by just transferring some tokens in
        await mintCollteralToken(collateralToken, toFixedPtAmt("1000"), deployer);
        await collateralToken.transfer(perp.target, toFixedPtAmt("1000"));
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          collateralToken.target,
          toFixedPtAmt("500"),
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when trancheIn price is 0.5 and tokenOut is collateral which rebased down", function () {
      beforeEach(async function () {
        await mintCollteralToken(collateralToken, toFixedPtAmt("1000"), deployer);
        await collateralToken.transfer(perp.target, toFixedPtAmt("1000"));
        await rebase(collateralToken, rebaseOracle, -0.75);
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          collateralToken.target,
          toFixedPtAmt("500"),
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when tokenOut is collateral has rebased down", function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.25);
      });
      it("should rollover the correct amount", async function () {
        const r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          collateralToken.target,
          toFixedPtAmt("500"),
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
        const r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          collateralToken.target,
          toFixedPtAmt("500"),
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when typical rollover", function () {
      beforeEach(async function () {});
      it("should transfer the tranches in", async function () {
        await expect(() =>
          mockVault.rollover(perp.target, rolloverInTranche.target, reserveTranche.target, toFixedPtAmt("500")),
        ).to.changeTokenBalances(rolloverInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
      });
      it("should transfer the tranches out", async function () {
        await expect(() =>
          mockVault.rollover(perp.target, rolloverInTranche.target, reserveTranche.target, toFixedPtAmt("500")),
        ).to.changeTokenBalances(reserveTranche, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
      });
      it("should charge fee", async function () {
        await expect(() =>
          mockVault.rollover(perp.target, rolloverInTranche.target, reserveTranche.target, toFixedPtAmt("500")),
        ).to.changeTokenBalance(perp, perp, "0");
      });
      it("should calculate rollover amt", async function () {
        const r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          reserveTranche.target,
          toFixedPtAmt("500"),
        );
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when trancheIn is NOT yet in the reserve", async function () {
      let tx: Transaction, newRotationInTranche: Contract, r: any;
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, rolloverInBond); // advancing to next issuance
        const newRolloverInBond = await bondAt(await perp.getDepositBond.staticCall());
        await depositIntoBond(newRolloverInBond, toFixedPtAmt("1000"), deployer);
        [newRotationInTranche] = await getTranches(newRolloverInBond);
        await newRotationInTranche.approve(mockVault.target, toFixedPtAmt("250"));
        r = await perp.computeRolloverAmt.staticCall(
          newRotationInTranche.target,
          collateralToken.target,
          toFixedPtAmt("250"),
        );
        tx = mockVault.rollover(perp.target, newRotationInTranche.target, collateralToken.target, toFixedPtAmt("250"));
        await tx;
      });
      it("should update the reserve", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, newRotationInTranche],
          [toFixedPtAmt("1250"), toFixedPtAmt("250")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(newRotationInTranche.target, toFixedPtAmt("250"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.target, toFixedPtAmt("1250"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when tokenOut is a reserve tranche", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          reserveTranche.target,
          toFixedPtAmt("250"),
        );
        tx = mockVault.rollover(perp.target, rolloverInTranche.target, reserveTranche.target, toFixedPtAmt("250"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, reserveTranche, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("250"), toFixedPtAmt("750")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.target, toFixedPtAmt("750"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche.target, toFixedPtAmt("250"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when tokenOut is the mature collateral", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          collateralToken.target,
          toFixedPtAmt("250"),
        );
        tx = mockVault.rollover(perp.target, rolloverInTranche.target, collateralToken.target, toFixedPtAmt("250"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, reserveTranche, rolloverInTranche],
          [toFixedPtAmt("250"), toFixedPtAmt("500"), toFixedPtAmt("750")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.target, toFixedPtAmt("750"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.target, toFixedPtAmt("250"));
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
        r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          collateralToken.target,
          toFixedPtAmt("250"),
        );
        tx = mockVault.rollover(perp.target, rolloverInTranche.target, collateralToken.target, toFixedPtAmt("250"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, reserveTranche, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("500"), toFixedPtAmt("750")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.target, toFixedPtAmt("750"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.target, toFixedPtAmt("500"));
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
        r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          collateralToken.target,
          toFixedPtAmt("250"),
        );
        tx = mockVault.rollover(perp.target, rolloverInTranche.target, collateralToken.target, toFixedPtAmt("250"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, reserveTranche, rolloverInTranche],
          ["0", toFixedPtAmt("500"), toFixedPtAmt("750")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.target, toFixedPtAmt("750"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.target, "0");
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("250"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when tokenOut is tranche and fully withdrawn", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          reserveTranche.target,
          toFixedPtAmt("500"),
        );
        tx = mockVault.rollover(perp.target, rolloverInTranche.target, reserveTranche.target, toFixedPtAmt("500"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("1000")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.target, toFixedPtAmt("1000"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche.target, "0");
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when tokenOut is collateral and fully withdrawn", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          collateralToken.target,
          toFixedPtAmt("500"),
        );
        tx = mockVault.rollover(perp.target, rolloverInTranche.target, collateralToken.target, toFixedPtAmt("500"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, reserveTranche, rolloverInTranche],
          ["0", toFixedPtAmt("500"), toFixedPtAmt("1000")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.target, toFixedPtAmt("1000"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.target, "0");
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when tokenOut is partially redeemed", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          reserveTranche.target,
          toFixedPtAmt("100"),
        );
        tx = mockVault.rollover(perp.target, rolloverInTranche.target, reserveTranche.target, toFixedPtAmt("100"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, reserveTranche, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("400"), toFixedPtAmt("600")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.target, toFixedPtAmt("600"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche.target, toFixedPtAmt("400"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("100"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("100"));
      });
    });

    describe("when tokenOut is NOT covered", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          reserveTranche.target,
          toFixedPtAmt("2000"),
        );
        tx = mockVault.rollover(perp.target, rolloverInTranche.target, reserveTranche.target, toFixedPtAmt("2000"));
        await tx;
      });

      it("should update the reserve (only transfers covered amount)", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, rolloverInTranche],
          [toFixedPtAmt("500"), toFixedPtAmt("1000")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.target, toFixedPtAmt("1000"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(reserveTranche.target, "0");
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("500"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when valid rollover", async function () {
      let tx: Transaction, r: any;
      beforeEach(async function () {
        r = await perp.computeRolloverAmt.staticCall(
          rolloverInTranche.target,
          collateralToken.target,
          toFixedPtAmt("100"),
        );
        tx = mockVault.rollover(perp.target, rolloverInTranche.target, collateralToken.target, toFixedPtAmt("100"));
        await tx;
      });

      it("should update the reserve", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, reserveTranche, rolloverInTranche],
          [toFixedPtAmt("400"), toFixedPtAmt("500"), toFixedPtAmt("600")],
        );
      });

      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(rolloverInTranche.target, toFixedPtAmt("600"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.target, toFixedPtAmt("400"));
      });
      it("should compute the rollover amounts", async function () {
        expect(r.tokenOutAmt).to.eq(toFixedPtAmt("100"));
        expect(r.trancheInAmt).to.eq(toFixedPtAmt("100"));
      });
    });
  });
});
