import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";
import {
  setupCollateralToken,
  setupBondFactory,
  bondAt,
  getTranches,
  toFixedPtAmt,
  advancePerpQueue,
  advanceTime,
  mintCollteralToken,
  advancePerpQueueToBondMaturity,
  getDepositBond,
  depositIntoBond,
  mintPerps,
  checkPerpComposition,
  checkVaultComposition,
  mintVaultNotes,
  toPercFixedPtAmt,
} from "./helpers";

let perp: Contract,
  bondFactory: Contract,
  collateralToken: Contract,
  issuer: Contract,
  balancer: Contract,
  vault: Contract,
  deployer: Signer,
  deployerAddress: string,
  router: Contract,
  depositBond: Contract,
  depositTranches: Contract[],
  perpTranches: Contract[],
  remTranches: Contract[];

describe("RouterV3", function () {
  beforeEach(async function () {
    await network.provider.request({ method: "hardhat_reset" });

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    deployerAddress = await deployer.getAddress();

    bondFactory = await setupBondFactory();
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
    balancer.updateFees({
      perpMintFeePerc: 0n,
      perpBurnFeePerc: 0n,
      vaultMintFeePerc: 0n,
      vaultBurnFeePerc: 0n,
      rolloverFee: {
        lower: toPercFixedPtAmt("-0.009"),
        upper: toPercFixedPtAmt("0.009"),
        growth: 0n,
      },
      underlyingToPerpSwapFeePerc: 0n,
      perpToUnderlyingSwapFeePerc: 0n,
      protocolSwapSharePerc: 0n,
    });
    await perp.updateBalancer(balancer.target);
    await vault.updateBalancer(balancer.target);

    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
    await balancer.updateSwapDRLimits({ lower: 0n, upper: toPercFixedPtAmt("1") });

    perpTranches = [];
    remTranches = [];
    for (let i = 0; i < 4; i++) {
      const bond = await getDepositBond(perp);
      const tranches = await getTranches(bond);
      await depositIntoBond(bond, toFixedPtAmt("500"), deployer);
      await mintPerps(perp, tranches[0], toFixedPtAmt("100"), deployer);
      await mintVaultNotes(vault, toFixedPtAmt("500"), deployer);
      await collateralToken.approve(balancer.target, toFixedPtAmt("100"));
      await balancer.swapUnderlyingForPerps(toFixedPtAmt("100"));
      perpTranches.push(tranches[0]);
      remTranches.push(tranches[1]);
      await advancePerpQueue(perp, 1200);
    }
    await checkPerpComposition(
      perp,
      [collateralToken, ...perpTranches.slice(-3)],
      [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
    );
    await checkVaultComposition(
      vault,
      [collateralToken, ...remTranches],
      [toFixedPtAmt("400"), toFixedPtAmt("400"), toFixedPtAmt("400"), toFixedPtAmt("400"), toFixedPtAmt("400")],
    );

    depositBond = await bondAt(await perp.depositBond());
    depositTranches = await getTranches(depositBond);

    const Router = await ethers.getContractFactory("RouterV3");
    router = await Router.deploy();
  });

  afterEach(async function () {
    await network.provider.request({ method: "hardhat_reset" });
  });

  describe("#previewTranche", function () {
    it("should compute the tranche amounts", async function () {
      const r = await router.previewTranche.staticCall(perp.target, toFixedPtAmt("1000"));
      expect(r[0]).to.eq(await perp.depositBond());
      expect(r[1][0].token).to.eq(depositTranches[0].target);
      expect(r[1][0].amount).to.eq(toFixedPtAmt("200"));
      expect(r[1][1].token).to.eq(depositTranches[1].target);
      expect(r[1][1].amount).to.eq(toFixedPtAmt("800"));
    });
  });

  describe("#mintPerps", function () {
    beforeEach(async function () {
      await mintCollteralToken(collateralToken, toFixedPtAmt("1100"), deployer);
    });

    describe("when deposit bond is incorrect", function () {
      beforeEach(async function () {
        await collateralToken.approve(router.target, ethers.MaxUint256);
        await advancePerpQueue(perp, 7200);
      });
      it("should revert", async function () {
        await expect(
          router.mintPerps(balancer.target, depositBond.target, toFixedPtAmt("1000")),
        ).to.revertedWithCustomError(perp, "UnacceptableDeposit");
      });
    });

    describe("when deposit bond is not issued", function () {
      beforeEach(async function () {
        await collateralToken.approve(router.target, ethers.MaxUint256);
        await advanceTime(7200);
      });
      it("should not revert", async function () {
        const depositBond = await bondAt(await perp.updateDepositBond.staticCall());
        await expect(router.mintPerps(balancer.target, depositBond.target, toFixedPtAmt("1000"))).not.to.be.reverted;
      });
    });

    describe("when deposit bond is correct", function () {
      let r: any;
      beforeEach(async function () {
        await collateralToken.approve(router.target, ethers.MaxUint256);
        r = await router.mintPerps.staticCall(balancer.target, depositBond.target, toFixedPtAmt("1000"));
        await router.mintPerps(balancer.target, depositBond.target, toFixedPtAmt("1000"));
      });

      it("should return minted token amounts", async function () {
        expect(r[0]).to.eq(toFixedPtAmt("200"));
        expect(r[1].token).to.eq(depositTranches[1].target);
        expect(r[1].amount).to.eq(toFixedPtAmt("800"));
      });

      it("should mint tranches", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("1000"));
      });

      it("should transfer unused tranches back", async function () {
        expect(await depositTranches[0].balanceOf(deployerAddress)).to.eq("0");
        expect(await depositTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("800"));
      });

      it("should leave no dust", async function () {
        expect(await depositTranches[0].balanceOf(router.target)).to.eq("0");
        expect(await depositTranches[1].balanceOf(router.target)).to.eq("0");
        expect(await perp.balanceOf(router.target)).to.eq("0");
        expect(await collateralToken.balanceOf(router.target)).to.eq("0");
      });
    });
  });

  describe("#redeem2", function () {
    let r: any;
    beforeEach(async function () {
      expect(await collateralToken.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("97600"));

      await perp.approve(router.target, toFixedPtAmt("100"));
      await vault.approve(router.target, toFixedPtAmt("100000000"));
      r = await router.redeem2.staticCall(balancer.target, {
        perpAmt: toFixedPtAmt("100"),
        noteAmt: toFixedPtAmt("100000000"),
      });
      await router.redeem2(balancer.target, {
        perpAmt: toFixedPtAmt("100"),
        noteAmt: toFixedPtAmt("100000000"),
      });
    });

    it("should return redeemed tokens", async function () {
      expect(r[0].token).to.eq(collateralToken.target);
      expect(r[0].amount).to.eq(toFixedPtAmt("140"));
      expect(r[2].token).to.eq(perpTranches[1].target);
      expect(r[2].amount).to.eq(toFixedPtAmt("20"));
      expect(r[3].token).to.eq(perpTranches[2].target);
      expect(r[3].amount).to.eq(toFixedPtAmt("20"));
      expect(r[1].token).to.eq(perpTranches[3].target);
      expect(r[1].amount).to.eq(toFixedPtAmt("20"));
    });

    it("should transfer underlying", async function () {
      expect(await collateralToken.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("97740"));
    });

    it("should leave no dust", async function () {
      expect(await perpTranches[0].balanceOf(router.target)).to.eq(0n);
      expect(await perpTranches[1].balanceOf(router.target)).to.eq(0n);
      expect(await perpTranches[2].balanceOf(router.target)).to.eq(0n);
      expect(await perpTranches[3].balanceOf(router.target)).to.eq(0n);
      expect(await remTranches[0].balanceOf(router.target)).to.eq(0n);
      expect(await remTranches[1].balanceOf(router.target)).to.eq(0n);
      expect(await remTranches[2].balanceOf(router.target)).to.eq(0n);
      expect(await remTranches[3].balanceOf(router.target)).to.eq(0n);
      expect(await perp.balanceOf(router.target)).to.eq(0n);
      expect(await vault.balanceOf(router.target)).to.eq(0n);
      expect(await collateralToken.balanceOf(router.target)).to.eq(0n);
    });
  });
});
