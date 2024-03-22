import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";
import {
  toPercFixedPtAmt,
  toFixedPtAmt,
  setupCollateralToken,
  setupBondFactory,
  advancePerpQueueToBondMaturity,
  getDepositBond,
  getTranches,
  depositIntoBond,
  advancePerpQueue,
  checkPerpComposition,
  bondAt,
  mintCollteralToken,
  checkVaultComposition,
  mintPerps,
  mintVaultNotes,
} from "../helpers";

let collateralToken: Contract,
  issuer: Contract,
  perp: Contract,
  vault: Contract,
  balancer: Contract,
  deployer: Signer,
  otherUser: Signer,
  perpTranches: Contract[],
  remTranches: Contract[],
  depositBond: Contract,
  depositTranches: Contract[];
const toPerc = toPercFixedPtAmt;

async function setFees(balancer: Contract, fees: any = {}) {
  const defaultFees = {
    perpMintFeePerc: 0n,
    perpBurnFeePerc: 0n,
    vaultMintFeePerc: 0n,
    vaultBurnFeePerc: 0n,
    rolloverFee: {
      lower: toPerc("-0.009"),
      upper: toPerc("0.009"),
      growth: 0n,
    },
    underlyingToPerpSwapFeePerc: 0n,
    perpToUnderlyingSwapFeePerc: 0n,
    protocolSwapSharePerc: 0n,
  };
  await balancer.updateFees({
    ...defaultFees,
    ...fees,
  });
}

describe("Balancer", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    const bondFactory = await setupBondFactory();
    ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));

    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await upgrades.deployProxy(
      BondIssuer.connect(deployer),
      [bondFactory.target, collateralToken.target, 4800, [200, 800], 1200, 0],
      {
        initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
      },
    );

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await upgrades.deployProxy(
      PerpetualTranche.connect(deployer),
      ["PerpetualTranche", "PERP", collateralToken.target, issuer.target],
      {
        initializer: "init(string,string,address,address)",
      },
    );
    await perp.updateTolerableTrancheMaturity(1200, 4800);
    await advancePerpQueueToBondMaturity(perp, await getDepositBond(perp));

    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    vault = await upgrades.deployProxy(RolloverVault.connect(deployer));
    await vault.init("RolloverVault", "VSHARE", perp.target);
    await perp.updateVault(vault.target);

    const Balancer = await ethers.getContractFactory("Balancer");
    balancer = await upgrades.deployProxy(Balancer.connect(deployer), [perp.target], {
      initializer: "init(address)",
    });
    await setFees(balancer);
    await perp.updateBalancer(balancer.target);
    await vault.updateBalancer(balancer.target);

    perpTranches = [];
    remTranches = [];
    for (let i = 0; i < 4; i++) {
      const bond = await getDepositBond(perp);
      const tranches = await getTranches(bond);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
      await mintPerps(perp, tranches[0], toFixedPtAmt("200"), deployer);
      perpTranches.push(tranches[0]);
      remTranches.push(tranches[1]);
      await advancePerpQueue(perp, 1200);
    }

    await checkPerpComposition(
      perp,
      [collateralToken, ...perpTranches.slice(-3)],
      [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
    );
    depositBond = await bondAt(await perp.depositBond());
    depositTranches = await getTranches(depositBond);

    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
    await checkVaultComposition(vault, [collateralToken], [0n]);
    expect(await vault.assetCount()).to.eq(1);
  });

  describe("mint2", function () {
    let mintAmts: any;
    describe("when dr = 0", function () {
      beforeEach(async function () {
        expect(await balancer.deviationRatio()).to.eq(0n);
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
      });

      it("should move dr closer to 1", async function () {
        await balancer.mint2(toFixedPtAmt("1000"));
        expect(await balancer.deviationRatio()).to.eq(toPerc("0.17241379"));
      });
    });

    describe("when dr > 1", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("5000"), deployer);
        expect(await balancer.deviationRatio()).to.eq(toPerc("1.25"));
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
      });

      it("should move dr closer to 1", async function () {
        await balancer.mint2(toFixedPtAmt("1000"));
        expect(await balancer.deviationRatio()).to.eq(toPerc("1.20689654"));
      });
    });

    describe("when dr < 1", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("2000"), deployer);
        expect(await balancer.deviationRatio()).to.eq(toPerc("0.5"));
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
      });

      it("should move dr closer to 1", async function () {
        await balancer.mint2(toFixedPtAmt("1000"));
        expect(await balancer.deviationRatio()).to.eq(toPerc("0.58620689"));
      });
    });

    describe("when fees = 0", function () {
      beforeEach(async function () {
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
        mintAmts = await balancer.mint2.staticCall(toFixedPtAmt("1000"));
      });

      it("should transfer underlying", async function () {
        await expect(() => balancer.mint2(toFixedPtAmt("1000"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("-1000")],
        );
      });

      it("should mint perps", async function () {
        await expect(() => balancer.mint2(toFixedPtAmt("1000"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("166.666666666666666666")],
        );
      });

      it("should mint notes", async function () {
        await expect(() => balancer.mint2(toFixedPtAmt("1000"))).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("833333333.333333333334")],
        );
      });

      it("should return the mint amounts", async function () {
        expect(mintAmts.perpAmt).to.eq(toFixedPtAmt("166.666666666666666666"));
        expect(mintAmts.noteAmt).to.eq(toFixedPtAmt("833333333.333333333334"));
      });

      it("should have the updated composition", async function () {
        await balancer.mint2(toFixedPtAmt("1000"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...perpTranches.slice(-3), depositTranches[0]],
          [
            toFixedPtAmt("200"),
            toFixedPtAmt("200"),
            toFixedPtAmt("200"),
            toFixedPtAmt("200"),
            toFixedPtAmt("166.666666666666666666"),
          ],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, depositTranches[1]],
          [toFixedPtAmt("166.66666666666666667"), toFixedPtAmt("666.666666666666666664")],
        );
      });
    });

    describe("when fee > 0", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("3000"), deployer);
        await setFees(balancer, {
          perpMintFeePerc: toPerc("0.01"),
          vaultMintFeePerc: toPerc("0.1"),
        });
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
        mintAmts = await balancer.mint2.staticCall(toFixedPtAmt("1000"));
      });

      it("should transfer underlying", async function () {
        await expect(() => balancer.mint2(toFixedPtAmt("1000"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("-1000")],
        );
      });

      it("should mint perps", async function () {
        await expect(() => balancer.mint2(toFixedPtAmt("1000"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("164.999999999999999999")],
        );
      });

      it("should mint notes", async function () {
        await expect(() => balancer.mint2(toFixedPtAmt("1000"))).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("750000000.0000000000006")],
        );
      });

      it("should burn perp fees", async function () {
        await expect(balancer.mint2(toFixedPtAmt("1000")))
          .to.emit(balancer, "FeePerps")
          .withArgs(toFixedPtAmt("1.666666666666666667"));
      });

      it("should burn perp fees", async function () {
        await expect(balancer.mint2(toFixedPtAmt("1000")))
          .to.emit(perp, "Transfer")
          .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("1.666666666666666667"));
      });

      it("should burn vault fees", async function () {
        await expect(balancer.mint2(toFixedPtAmt("1000")))
          .to.emit(balancer, "FeeVault")
          .withArgs(toFixedPtAmt("83333333.3333333333334"));
      });

      it("should burn vault fees", async function () {
        await expect(balancer.mint2(toFixedPtAmt("1000")))
          .to.emit(vault, "Transfer")
          .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("83333333.3333333333334"));
      });

      it("should return the mint amounts", async function () {
        expect(mintAmts.perpAmt).to.eq(toFixedPtAmt("164.999999999999999999"));
        expect(mintAmts.noteAmt).to.eq(toFixedPtAmt("750000000.0000000000006"));
      });

      it("should have the updated composition", async function () {
        await balancer.mint2(toFixedPtAmt("1000"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...perpTranches.slice(-3), depositTranches[0]],
          [
            toFixedPtAmt("200"),
            toFixedPtAmt("200"),
            toFixedPtAmt("200"),
            toFixedPtAmt("200"),
            toFixedPtAmt("166.666666666666666666"),
          ],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, depositTranches[1]],
          [toFixedPtAmt("3166.66666666666666667"), toFixedPtAmt("666.666666666666666664")],
        );
      });
    });
  });

  describe("mint2WithPerps", function () {
    let mintAmts: any;
    describe("on successful mint", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("2000"), deployer);
        expect(await balancer.deviationRatio()).to.eq(toPerc("0.5"));
        await perp.approve(balancer.target, toFixedPtAmt("100"));
        mintAmts = await balancer.mint2WithPerps.staticCall(toFixedPtAmt("100"));
      });

      it("should transfer perp and mint", async function () {
        await expect(() => balancer.mint2WithPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("-83.333333333333333334")],
        );
      });

      it("should mint notes", async function () {
        await expect(() => balancer.mint2WithPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("83333333.333333333334")],
        );
      });

      it("should return the mint amounts", async function () {
        expect(mintAmts.perpAmt).to.eq(toFixedPtAmt("16.666666666666666666"));
        expect(mintAmts.noteAmt).to.eq(toFixedPtAmt("83333333.333333333334"));
      });

      it("should move dr closer to 1", async function () {
        await balancer.mint2WithPerps(toFixedPtAmt("100"));
        expect(await balancer.deviationRatio()).to.eq(toPerc("0.58139534"));
      });

      it("should have the updated composition", async function () {
        await balancer.mint2WithPerps(toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...perpTranches.slice(-3), depositTranches[0]],
          [
            toFixedPtAmt("175"),
            toFixedPtAmt("175"),
            toFixedPtAmt("175"),
            toFixedPtAmt("175"),
            toFixedPtAmt("16.666666666666666666"),
          ],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, ...perpTranches.slice(-3), depositTranches[1]],
          [
            toFixedPtAmt("1941.66666666666666667"),
            toFixedPtAmt("25"),
            toFixedPtAmt("25"),
            toFixedPtAmt("25"),
            toFixedPtAmt("66.666666666666666664"),
          ],
        );
      });
    });

    describe("when dr grows above upper bound", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("4000"), deployer);
        expect(await balancer.deviationRatio()).to.eq(toPerc("1"));
        await perp.approve(balancer.target, toFixedPtAmt("100"));
      });

      it("should revert", async function () {
        await expect(balancer.mint2WithPerps(toFixedPtAmt("100"))).to.be.revertedWithCustomError(
          balancer,
          "DROutsideBound",
        );
      });
    });

    describe("when liquidity becomes too low", function () {
      beforeEach(async function () {
        await balancer.updateVaultMinUnderlyingPerc(toPerc("0.23"));
        await mintVaultNotes(vault, toFixedPtAmt("100"), deployer);
        await perp.approve(balancer.target, toFixedPtAmt("100"));
      });

      it("should revert", async function () {
        await expect(balancer.mint2WithPerps(toFixedPtAmt("100"))).to.be.revertedWithCustomError(
          balancer,
          "InsufficientLiquidity",
        );
      });
    });
  });

  describe("mint2WithVaultNotes", function () {
    let mintAmts: any;
    describe("on successful mint", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("10000"), deployer);
        expect(await balancer.deviationRatio()).to.eq(toPerc("2.5"));
        await vault.approve(balancer.target, toFixedPtAmt("100000000"));
        mintAmts = await balancer.mint2WithVaultNotes.staticCall(toFixedPtAmt("100000000"));
      });

      it("should mint perps", async function () {
        await expect(() => balancer.mint2WithVaultNotes(toFixedPtAmt("100000000"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("16.666666666666666666")],
        );
      });

      it("should transfer vault notes and mint", async function () {
        await expect(() => balancer.mint2WithVaultNotes(toFixedPtAmt("100000000"))).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("-16666666.666666666666")],
        );
      });

      it("should return the mint amounts", async function () {
        expect(mintAmts.perpAmt).to.eq(toFixedPtAmt("16.666666666666666666"));
        expect(mintAmts.noteAmt).to.eq(toFixedPtAmt("83333333.333333333334"));
      });

      it("should move dr closer to 1", async function () {
        await balancer.mint2WithVaultNotes(toFixedPtAmt("100000000"));
        expect(await balancer.deviationRatio()).to.eq(toPerc("2.44489795"));
      });

      it("should have the updated composition", async function () {
        await balancer.mint2WithVaultNotes(toFixedPtAmt("100000000"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...perpTranches.slice(-3), depositTranches[0]],
          [
            toFixedPtAmt("200"),
            toFixedPtAmt("200"),
            toFixedPtAmt("200"),
            toFixedPtAmt("200"),
            toFixedPtAmt("16.666666666666666666"),
          ],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, depositTranches[1]],
          [toFixedPtAmt("9916.66666666666666667"), toFixedPtAmt("66.666666666666666664")],
        );
      });
    });

    describe("when dr grows above upper bound", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("5000"), deployer);
        expect(await balancer.deviationRatio()).to.eq(toPerc("1.25"));
        await vault.approve(balancer.target, toFixedPtAmt("100000000"));
      });

      it("should revert", async function () {
        await expect(balancer.mint2WithVaultNotes(toFixedPtAmt("100000000"))).to.be.revertedWithCustomError(
          balancer,
          "DROutsideBound",
        );
      });
    });

    describe("when liquidity has been deployed", function () {
      beforeEach(async function () {
        await balancer.updateRebalanceDRLimits([toPerc("0"), toPerc("1")]);
        await mintVaultNotes(vault, toFixedPtAmt("100"), deployer);
        await vault.deploy();
        await vault.deploy();
        await vault.approve(balancer.target, toFixedPtAmt("10000000"));
      });

      it("should revert", async function () {
        await expect(balancer.mint2WithVaultNotes(toFixedPtAmt("10000000"))).to.be.revertedWithCustomError(
          balancer,
          "InsufficientLiquidity",
        );
      });
    });

    describe("when liquidity goes below the enforced perc", function () {
      beforeEach(async function () {
        await balancer.updateVaultMinUnderlyingPerc(toPerc("0.95"));
        await balancer.updateRebalanceDRLimits([toPerc("1"), toPerc("1")]);
        await mintVaultNotes(vault, toFixedPtAmt("5000"), deployer);
        await vault.approve(balancer.target, toFixedPtAmt("500000000"));
      });

      it("should revert", async function () {
        await expect(balancer.mint2WithVaultNotes(toFixedPtAmt("500000000"))).to.be.revertedWithCustomError(
          balancer,
          "InsufficientLiquidity",
        );
      });
    });
  });

  describe("mintPerps", function () {
    let mintAmt: BigInt;
    describe("when fees = 0", function () {
      beforeEach(async function () {
        await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
        await depositTranches[0].approve(balancer.target, toFixedPtAmt("100"));
        mintAmt = await balancer.mintPerps.staticCall(depositTranches[0].target, toFixedPtAmt("100"));
      });

      it("should transfer depositTranche", async function () {
        await expect(() => balancer.mintPerps(depositTranches[0].target, toFixedPtAmt("100"))).to.changeTokenBalances(
          depositTranches[0],
          [deployer],
          [toFixedPtAmt("-100")],
        );
      });

      it("should mint perps", async function () {
        await expect(() => balancer.mintPerps(depositTranches[0].target, toFixedPtAmt("100"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("100")],
        );
      });

      it("should return the mint amount", async function () {
        expect(mintAmt).to.eq(toFixedPtAmt("100"));
      });

      it("should have the updated composition", async function () {
        await balancer.mintPerps(depositTranches[0].target, toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...perpTranches.slice(-3), depositTranches[0]],
          [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("100")],
        );
      });
    });

    describe("when fee > 0", function () {
      beforeEach(async function () {
        await setFees(balancer, {
          perpMintFeePerc: toPerc("0.1"),
        });
        await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
        await depositTranches[0].approve(balancer.target, toFixedPtAmt("100"));
        mintAmt = await balancer.mintPerps.staticCall(depositTranches[0].target, toFixedPtAmt("100"));
      });

      it("should transfer depositTranche", async function () {
        await expect(() => balancer.mintPerps(depositTranches[0].target, toFixedPtAmt("100"))).to.changeTokenBalances(
          depositTranches[0],
          [deployer],
          [toFixedPtAmt("-100")],
        );
      });

      it("should mint perps", async function () {
        await expect(() => balancer.mintPerps(depositTranches[0].target, toFixedPtAmt("100"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("90")],
        );
      });

      it("should return the mint amount", async function () {
        expect(mintAmt).to.eq(toFixedPtAmt("90"));
      });

      it("should have the updated composition", async function () {
        await balancer.mintPerps(depositTranches[0].target, toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...perpTranches.slice(-3), depositTranches[0]],
          [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("100")],
        );
      });

      it("should burn perp fees", async function () {
        await expect(balancer.mintPerps(depositTranches[0].target, toFixedPtAmt("100")))
          .to.emit(balancer, "FeePerps")
          .withArgs(toFixedPtAmt("10"));
      });

      it("should burn perp fees", async function () {
        await expect(balancer.mintPerps(depositTranches[0].target, toFixedPtAmt("100")))
          .to.emit(perp, "Transfer")
          .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("10"));
      });
    });
  });

  describe("redeemPerps", function () {
    let redemptionAmts: BigInt;
    describe("when fees = 0", function () {
      beforeEach(async function () {
        await perp.approve(balancer.target, toFixedPtAmt("100"));
        redemptionAmts = await balancer.redeemPerps.staticCall(toFixedPtAmt("100"));
      });

      it("should burn perps", async function () {
        await expect(() => balancer.redeemPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("-100")],
        );
      });

      it("should collateralToken", async function () {
        await expect(() => balancer.redeemPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("25")],
        );
      });

      it("should transfer tranches", async function () {
        await expect(() => balancer.redeemPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          perpTranches[1],
          [deployer],
          [toFixedPtAmt("25")],
        );
      });

      it("should transfer tranches", async function () {
        await expect(() => balancer.redeemPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          perpTranches[2],
          [deployer],
          [toFixedPtAmt("25")],
        );
      });

      it("should transfer tranches", async function () {
        await expect(() => balancer.redeemPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          perpTranches[3],
          [deployer],
          [toFixedPtAmt("25")],
        );
      });

      it("should return the redemptionAmts amount", async function () {
        expect(redemptionAmts[0].token).to.eq(collateralToken.target);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("25"));
        expect(redemptionAmts[1].token).to.eq(perpTranches[3].target);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("25"));
        expect(redemptionAmts[2].token).to.eq(perpTranches[1].target);
        expect(redemptionAmts[2].amount).to.eq(toFixedPtAmt("25"));
        expect(redemptionAmts[3].token).to.eq(perpTranches[2].target);
        expect(redemptionAmts[3].amount).to.eq(toFixedPtAmt("25"));
      });

      it("should have the updated composition", async function () {
        await balancer.redeemPerps(toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...perpTranches.slice(-3)],
          [toFixedPtAmt("175"), toFixedPtAmt("175"), toFixedPtAmt("175"), toFixedPtAmt("175")],
        );
      });
    });

    describe("when fees > 0", function () {
      beforeEach(async function () {
        await setFees(balancer, {
          perpBurnFeePerc: toPerc("0.1"),
        });
        await perp.approve(balancer.target, toFixedPtAmt("100"));
        redemptionAmts = await balancer.redeemPerps.staticCall(toFixedPtAmt("100"));
      });

      it("should burn perps", async function () {
        await expect(() => balancer.redeemPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("-100")],
        );
      });

      it("should collateralToken", async function () {
        await expect(() => balancer.redeemPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("22.5")],
        );
      });

      it("should transfer tranches", async function () {
        await expect(() => balancer.redeemPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          perpTranches[1],
          [deployer],
          [toFixedPtAmt("22.5")],
        );
      });

      it("should transfer tranches", async function () {
        await expect(() => balancer.redeemPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          perpTranches[2],
          [deployer],
          [toFixedPtAmt("22.5")],
        );
      });

      it("should transfer tranches", async function () {
        await expect(() => balancer.redeemPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          perpTranches[3],
          [deployer],
          [toFixedPtAmt("22.5")],
        );
      });

      it("should return the redemptionAmts amount", async function () {
        expect(redemptionAmts[0].token).to.eq(collateralToken.target);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("22.5"));
        expect(redemptionAmts[1].token).to.eq(perpTranches[3].target);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("22.5"));
        expect(redemptionAmts[2].token).to.eq(perpTranches[1].target);
        expect(redemptionAmts[2].amount).to.eq(toFixedPtAmt("22.5"));
        expect(redemptionAmts[3].token).to.eq(perpTranches[2].target);
        expect(redemptionAmts[3].amount).to.eq(toFixedPtAmt("22.5"));
      });

      it("should have the updated composition", async function () {
        await balancer.redeemPerps(toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...perpTranches.slice(-3)],
          [toFixedPtAmt("177.5"), toFixedPtAmt("177.5"), toFixedPtAmt("177.5"), toFixedPtAmt("177.5")],
        );
      });

      it("should burn perp fees", async function () {
        await expect(balancer.redeemPerps(toFixedPtAmt("100")))
          .to.emit(balancer, "FeePerps")
          .withArgs(toFixedPtAmt("10"));
      });

      it("should burn perp fees", async function () {
        await expect(balancer.redeemPerps(toFixedPtAmt("100")))
          .to.emit(perp, "Transfer")
          .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("10"));
      });
    });
  });

  describe("mintVaultNotes", function () {
    let mintAmt: BigInt;
    describe("when fees = 0", function () {
      beforeEach(async function () {
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
        mintAmt = await balancer.mintVaultNotes.staticCall(toFixedPtAmt("1000"));
      });

      it("should transfer underlying", async function () {
        await expect(() => balancer.mintVaultNotes(toFixedPtAmt("1000"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("-1000")],
        );
      });

      it("should mint vault notes", async function () {
        await expect(() => balancer.mintVaultNotes(toFixedPtAmt("1000"))).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("1000000000")],
        );
      });

      it("should return the mint amount", async function () {
        expect(mintAmt).to.eq(toFixedPtAmt("1000000000"));
      });

      it("should have the updated composition", async function () {
        await balancer.mintVaultNotes(toFixedPtAmt("1000"));
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("1000")]);
      });
    });

    describe("when fee > 0", function () {
      beforeEach(async function () {
        await setFees(balancer, {
          vaultMintFeePerc: toPerc("0.1"),
        });
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
        mintAmt = await balancer.mintVaultNotes.staticCall(toFixedPtAmt("1000"));
      });

      it("should transfer underlying", async function () {
        await expect(() => balancer.mintVaultNotes(toFixedPtAmt("1000"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("-1000")],
        );
      });

      it("should mint vault notes", async function () {
        await expect(() => balancer.mintVaultNotes(toFixedPtAmt("1000"))).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("900000000")],
        );
      });

      it("should return the mint amount", async function () {
        expect(mintAmt).to.eq(toFixedPtAmt("900000000"));
      });

      it("should have the updated composition", async function () {
        await balancer.mintVaultNotes(toFixedPtAmt("1000"));
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("1000")]);
      });

      it("should burn vault fees", async function () {
        await expect(balancer.mintVaultNotes(toFixedPtAmt("1000")))
          .to.emit(balancer, "FeeVault")
          .withArgs(toFixedPtAmt("100000000"));
      });

      it("should burn vault fees", async function () {
        await expect(balancer.mintVaultNotes(toFixedPtAmt("1000")))
          .to.emit(vault, "Transfer")
          .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("100000000"));
      });
    });
  });

  describe("redeemVaultNotes", function () {
    let redemptionAmts: BigInt;
    describe("when fees = 0", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("1000"), deployer);
        await vault.deploy();
        await vault.approve(balancer.target, toFixedPtAmt("100000000"));
        redemptionAmts = await balancer.redeemVaultNotes.staticCall(toFixedPtAmt("100000000"));
      });

      it("should burn vault notes", async function () {
        await expect(() => balancer.redeemVaultNotes(toFixedPtAmt("100000000"))).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("-100000000")],
        );
      });

      it("should collateralToken", async function () {
        await expect(() => balancer.redeemVaultNotes(toFixedPtAmt("100000000"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("20")],
        );
      });

      it("should transfer tranches", async function () {
        await expect(() => balancer.redeemVaultNotes(toFixedPtAmt("100000000"))).to.changeTokenBalances(
          depositTranches[1],
          [deployer],
          [toFixedPtAmt("80")],
        );
      });

      it("should return the redemptionAmts amount", async function () {
        expect(redemptionAmts[0].token).to.eq(collateralToken.target);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("20"));
        expect(redemptionAmts[1].token).to.eq(depositTranches[1].target);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("80"));
      });

      it("should have the updated composition", async function () {
        await balancer.redeemVaultNotes(toFixedPtAmt("100000000"));
        await checkVaultComposition(
          vault,
          [collateralToken, depositTranches[1]],
          [toFixedPtAmt("180"), toFixedPtAmt("720")],
        );
      });
    });

    describe("when fees > 0", function () {
      beforeEach(async function () {
        await setFees(balancer, {
          vaultBurnFeePerc: toPerc("0.1"),
        });
        await mintVaultNotes(vault, toFixedPtAmt("1000"), deployer);
        await vault.deploy();
        await vault.approve(balancer.target, toFixedPtAmt("100000000"));
        redemptionAmts = await balancer.redeemVaultNotes.staticCall(toFixedPtAmt("100000000"));
      });

      it("should burn vault notes", async function () {
        await expect(() => balancer.redeemVaultNotes(toFixedPtAmt("100000000"))).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("-100000000")],
        );
      });

      it("should collateralToken", async function () {
        await expect(() => balancer.redeemVaultNotes(toFixedPtAmt("100000000"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("18")],
        );
      });

      it("should transfer tranches", async function () {
        await expect(() => balancer.redeemVaultNotes(toFixedPtAmt("100000000"))).to.changeTokenBalances(
          depositTranches[1],
          [deployer],
          [toFixedPtAmt("72")],
        );
      });

      it("should return the redemptionAmts amount", async function () {
        expect(redemptionAmts[0].token).to.eq(collateralToken.target);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("18"));
        expect(redemptionAmts[1].token).to.eq(depositTranches[1].target);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("72"));
      });

      it("should have the updated composition", async function () {
        await balancer.redeemVaultNotes(toFixedPtAmt("100000000"));
        await checkVaultComposition(
          vault,
          [collateralToken, depositTranches[1]],
          [toFixedPtAmt("182"), toFixedPtAmt("728")],
        );
      });

      it("should burn vault fees", async function () {
        await expect(balancer.redeemVaultNotes(toFixedPtAmt("100000000")))
          .to.emit(balancer, "FeeVault")
          .withArgs(toFixedPtAmt("10000000"));
      });

      it("should burn vault fees", async function () {
        await expect(balancer.redeemVaultNotes(toFixedPtAmt("100000000")))
          .to.emit(vault, "Transfer")
          .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("10000000"));
      });
    });
  });

  describe("swapUnderlyingForPerps", function () {
    let swapAmt: any;
    describe("when fee = 0", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("4000"), deployer);
        expect(await balancer.deviationRatio()).to.eq(toPerc("1"));
        await collateralToken.approve(balancer.target, toFixedPtAmt("100"));
        swapAmt = await balancer.swapUnderlyingForPerps.staticCall(toFixedPtAmt("100"));
      });

      it("should transfer underlying", async function () {
        await expect(() => balancer.swapUnderlyingForPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("-100")],
        );
      });

      it("should mint perps", async function () {
        await expect(() => balancer.swapUnderlyingForPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("100")],
        );
      });

      it("should return the swap amount", async function () {
        expect(swapAmt).to.eq(toFixedPtAmt("100"));
      });

      it("should have the updated composition", async function () {
        await balancer.swapUnderlyingForPerps(toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...perpTranches.slice(-3), depositTranches[0]],
          [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("100")],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, depositTranches[1]],
          [toFixedPtAmt("3600"), toFixedPtAmt("400")],
        );
      });

      it("should reduce the system dr", async function () {
        await balancer.swapUnderlyingForPerps(toFixedPtAmt("100"));
        expect(await balancer.deviationRatio()).to.eq(toPerc("0.88888888"));
      });
    });

    describe("when fee > 0", function () {
      beforeEach(async function () {
        await setFees(balancer, {
          perpMintFeePerc: toPerc("0.05"),
          protocolSwapSharePerc: toPerc("0.25"),
          underlyingToPerpSwapFeePerc: toPerc("0.1"),
        });
        await mintVaultNotes(vault, toFixedPtAmt("4000"), deployer);
        expect(await balancer.deviationRatio()).to.eq(toPerc("1"));
        await vault.transferOwnership(await otherUser.getAddress());
        await collateralToken.approve(balancer.target, toFixedPtAmt("100"));
        swapAmt = await balancer.swapUnderlyingForPerps.staticCall(toFixedPtAmt("100"));
      });

      it("should transfer underlying", async function () {
        await expect(() => balancer.swapUnderlyingForPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("-100")],
        );
      });

      it("should mint perps", async function () {
        await expect(() => balancer.swapUnderlyingForPerps(toFixedPtAmt("100"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("85")],
        );
      });

      it("should return the swap amount", async function () {
        expect(swapAmt).to.eq(toFixedPtAmt("85"));
      });

      it("should have the updated composition", async function () {
        await balancer.swapUnderlyingForPerps(toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...perpTranches.slice(-3), depositTranches[0]],
          [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("90")],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, depositTranches[1]],
          [toFixedPtAmt("3647.5"), toFixedPtAmt("360.0")],
        );
      });

      it("should reduce the system dr", async function () {
        await balancer.swapUnderlyingForPerps(toFixedPtAmt("100"));
        expect(await balancer.deviationRatio()).to.eq(toPerc("0.90056179"));
      });

      it("should burn perp fees", async function () {
        await expect(balancer.swapUnderlyingForPerps(toFixedPtAmt("100")))
          .to.emit(balancer, "FeePerps")
          .withArgs(toFixedPtAmt("5"));
      });

      it("should burn perp fees", async function () {
        await expect(balancer.swapUnderlyingForPerps(toFixedPtAmt("100")))
          .to.emit(perp, "Transfer")
          .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("5"));
      });

      it("should settle vault fees", async function () {
        await expect(balancer.swapUnderlyingForPerps(toFixedPtAmt("100")))
          .to.emit(balancer, "FeeVault")
          .withArgs(toFixedPtAmt("7500000"));
      });

      it("should settle vault fees", async function () {
        await expect(balancer.swapUnderlyingForPerps(toFixedPtAmt("100")))
          .to.emit(collateralToken, "Transfer")
          .withArgs(balancer.target, vault.target, toFixedPtAmt("7.5"));
      });

      it("should settle protocol fees", async function () {
        await expect(balancer.swapUnderlyingForPerps(toFixedPtAmt("100")))
          .to.emit(balancer, "FeeProtocol")
          .withArgs(toFixedPtAmt("2.5"));
      });

      it("should settle protocol fees", async function () {
        await expect(balancer.swapUnderlyingForPerps(toFixedPtAmt("100")))
          .to.emit(collateralToken, "Transfer")
          .withArgs(balancer.target, await otherUser.getAddress(), toFixedPtAmt("2.5"));
      });
    });

    describe("when dr reduces below lower bound", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("3000"), deployer);
        expect(await balancer.deviationRatio()).to.eq(toPerc("0.75"));
        await collateralToken.approve(balancer.target, toFixedPtAmt("100"));
      });

      it("should revert", async function () {
        await expect(balancer.swapUnderlyingForPerps(toFixedPtAmt("100"))).to.be.revertedWithCustomError(
          balancer,
          "DROutsideBound",
        );
      });
    });

    describe("when liquidity becomes too low", function () {
      beforeEach(async function () {
        await balancer.updateVaultMinUnderlyingPerc(toPerc("0.91"));
        await mintVaultNotes(vault, toFixedPtAmt("4000"), deployer);
        await collateralToken.approve(balancer.target, toFixedPtAmt("100"));
      });

      it("should revert", async function () {
        await expect(balancer.swapUnderlyingForPerps(toFixedPtAmt("100"))).to.be.revertedWithCustomError(
          balancer,
          "InsufficientLiquidity",
        );
      });
    });
  });

  describe("swapPerpsForUnderlying", function () {
    let swapAmt: any;
    describe("when fee = 0", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("4000"), deployer);
        expect(await balancer.deviationRatio()).to.eq(toPerc("1"));
        await perp.approve(balancer.target, toFixedPtAmt("100"));
        swapAmt = await balancer.swapPerpsForUnderlying.staticCall(toFixedPtAmt("100"));
      });

      it("should transfer perps", async function () {
        await expect(() => balancer.swapPerpsForUnderlying(toFixedPtAmt("100"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("-100")],
        );
      });

      it("should return underlying", async function () {
        await expect(() => balancer.swapPerpsForUnderlying(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("100")],
        );
      });

      it("should return the swap amount", async function () {
        expect(swapAmt).to.eq(toFixedPtAmt("100"));
      });

      it("should have the updated composition", async function () {
        await balancer.swapPerpsForUnderlying(toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...perpTranches.slice(-3)],
          [toFixedPtAmt("175"), toFixedPtAmt("175"), toFixedPtAmt("175"), toFixedPtAmt("175")],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, ...perpTranches.slice(-3)],
          [toFixedPtAmt("3925"), toFixedPtAmt("25"), toFixedPtAmt("25"), toFixedPtAmt("25")],
        );
      });

      it("should increase the system dr", async function () {
        await balancer.swapPerpsForUnderlying(toFixedPtAmt("100"));
        expect(await balancer.deviationRatio()).to.eq(toPerc("1.14285713"));
      });
    });

    describe("when fee > 0", function () {
      beforeEach(async function () {
        await setFees(balancer, {
          perpBurnFeePerc: toPerc("0.05"),
          protocolSwapSharePerc: toPerc("0.25"),
          perpToUnderlyingSwapFeePerc: toPerc("0.1"),
        });
        await mintVaultNotes(vault, toFixedPtAmt("4000"), deployer);
        expect(await balancer.deviationRatio()).to.eq(toPerc("1"));
        await vault.transferOwnership(await otherUser.getAddress());
        await perp.approve(balancer.target, toFixedPtAmt("100"));
        swapAmt = await balancer.swapPerpsForUnderlying.staticCall(toFixedPtAmt("100"));
      });

      it("should transfer perps", async function () {
        await expect(() => balancer.swapPerpsForUnderlying(toFixedPtAmt("100"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("-100")],
        );
      });

      it("should return underlying", async function () {
        await expect(() => balancer.swapPerpsForUnderlying(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("85")],
        );
      });

      it("should return the swap amount", async function () {
        expect(swapAmt).to.eq(toFixedPtAmt("85"));
      });

      it("should have the updated composition", async function () {
        await balancer.swapPerpsForUnderlying(toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...perpTranches.slice(-3)],
          [toFixedPtAmt("176.25"), toFixedPtAmt("176.25"), toFixedPtAmt("176.25"), toFixedPtAmt("176.25")],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, ...perpTranches.slice(-3)],
          [toFixedPtAmt("3936.25"), toFixedPtAmt("23.75"), toFixedPtAmt("23.75"), toFixedPtAmt("23.75")],
        );
      });

      it("should increase the system dr", async function () {
        await balancer.swapPerpsForUnderlying(toFixedPtAmt("100"));
        expect(await balancer.deviationRatio()).to.eq(toPerc("1.13687943"));
      });

      it("should burn perp fees", async function () {
        await expect(balancer.swapPerpsForUnderlying(toFixedPtAmt("100")))
          .to.emit(balancer, "FeePerps")
          .withArgs(toFixedPtAmt("5"));
      });

      it("should burn perp fees", async function () {
        await expect(balancer.swapPerpsForUnderlying(toFixedPtAmt("100")))
          .to.emit(perp, "Transfer")
          .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("5"));
      });

      it("should settle vault fees", async function () {
        await expect(balancer.swapPerpsForUnderlying(toFixedPtAmt("100")))
          .to.emit(balancer, "FeeVault")
          .withArgs(toFixedPtAmt("7500000"));
      });

      it("should settle vault fees", async function () {
        await expect(balancer.swapPerpsForUnderlying(toFixedPtAmt("100")))
          .to.emit(collateralToken, "Transfer")
          .withArgs(balancer.target, vault.target, toFixedPtAmt("7.5"));
      });

      it("should settle protocol fees", async function () {
        await expect(balancer.swapPerpsForUnderlying(toFixedPtAmt("100")))
          .to.emit(balancer, "FeeProtocol")
          .withArgs(toFixedPtAmt("2.5"));
      });

      it("should settle protocol fees", async function () {
        await expect(balancer.swapPerpsForUnderlying(toFixedPtAmt("100")))
          .to.emit(collateralToken, "Transfer")
          .withArgs(balancer.target, await otherUser.getAddress(), toFixedPtAmt("2.5"));
      });
    });

    describe("when dr increases above upper bound", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("6000"), deployer);
        expect(await balancer.deviationRatio()).to.eq(toPerc("1.5"));
        await perp.approve(balancer.target, toFixedPtAmt("100"));
      });

      it("should revert", async function () {
        await expect(balancer.swapPerpsForUnderlying(toFixedPtAmt("100"))).to.be.revertedWithCustomError(
          balancer,
          "DROutsideBound",
        );
      });
    });

    describe("when liquidity becomes too low", function () {
      beforeEach(async function () {
        await balancer.updateVaultMinUnderlyingPerc(toPerc("0.99"));
        await mintVaultNotes(vault, toFixedPtAmt("4000"), deployer);
        await perp.approve(balancer.target, toFixedPtAmt("100"));
      });

      it("should revert", async function () {
        await expect(balancer.swapPerpsForUnderlying(toFixedPtAmt("100"))).to.be.revertedWithCustomError(
          balancer,
          "InsufficientLiquidity",
        );
      });
    });
  });
});
