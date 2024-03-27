import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { constants, Contract, Signer } from "ethers";
import { smock } from "@defi-wonderland/smock";
import {
  setupCollateralToken,
  setupBondFactory,
  bondAt,
  getTranches,
  toFixedPtAmt,
  advancePerpQueue,
  advanceTime,
  mintCollteralToken,
} from "./helpers";
use(smock.matchers);

let perp: Contract,
  bondFactory: Contract,
  collateralToken: Contract,
  issuer: Contract,
  feePolicy: Contract,
  vault: Contract,
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
    issuer = await upgrades.deployProxy(
      BondIssuer.connect(deployer),
      [bondFactory.address, collateralToken.address, 3600, [200, 800], 1200, 0],
      {
        initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
      },
    );

    const FeePolicy = await ethers.getContractFactory("FeePolicy");
    feePolicy = await smock.fake(FeePolicy);
    await feePolicy.computePerpRolloverFeePerc.returns("0");
    await feePolicy.decimals.returns(8);

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await upgrades.deployProxy(
      PerpetualTranche.connect(deployer),
      ["PerpetualTranche", "PERP", collateralToken.address, issuer.address, feePolicy.address],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );
    await perp.updateTolerableTrancheMaturity(600, 3600);
    await advancePerpQueue(perp, 3600);

    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    vault = await smock.fake(RolloverVault);
    await vault.getTVL.returns("0");
    await perp.updateVault(vault.address);

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
      expect(r[1][0].token).to.eq(depositTranches[0].address);
      expect(r[1][0].amount).to.eq(toFixedPtAmt("200"));
      expect(r[1][1].token).to.eq(depositTranches[1].address);
      expect(r[1][1].amount).to.eq(toFixedPtAmt("800"));
    });
  });

  describe("#trancheAndDeposit", function () {
    beforeEach(async function () {
      await mintCollteralToken(collateralToken, toFixedPtAmt("1100"), deployer);
      await collateralToken.transfer(router.address, toFixedPtAmt("100"));
    });

    describe("when deposit bond is incorrect", function () {
      beforeEach(async function () {
        await collateralToken.approve(router.address, constants.MaxUint256);
        await advancePerpQueue(perp, 7200);
      });
      it("should revert", async function () {
        await expect(
          router.trancheAndDeposit(perp.address, depositBond.address, toFixedPtAmt("1000")),
        ).to.revertedWithCustomError(perp, "UnexpectedAsset");
      });
    });

    describe("when deposit bond is not issued", function () {
      beforeEach(async function () {
        await collateralToken.approve(router.address, constants.MaxUint256);
        await advanceTime(7200);
      });
      it("should not revert", async function () {
        const depositBond = await bondAt(await perp.callStatic.getDepositBond());
        await expect(router.trancheAndDeposit(perp.address, depositBond.address, toFixedPtAmt("1000"))).not.to.be
          .reverted;
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

      it("should dust collateral tokens back", async function () {
        expect(await collateralToken.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("100"));
      });

      it("should transfer unused tranches back", async function () {
        expect(await depositTranches[0].balanceOf(deployerAddress)).to.eq("0");
        expect(await depositTranches[1].balanceOf(deployerAddress)).to.eq(toFixedPtAmt("800"));
      });

      it("should leave no dust", async function () {
        expect(await depositTranches[0].balanceOf(router.address)).to.eq("0");
        expect(await depositTranches[1].balanceOf(router.address)).to.eq("0");
        expect(await perp.balanceOf(router.address)).to.eq("0");
        expect(await collateralToken.balanceOf(router.address)).to.eq("0");
      });
    });
  });
});
