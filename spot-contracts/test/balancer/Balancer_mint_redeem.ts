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
  redeemVaultNotes,
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
    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);

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
    await balancer.addRebalancer(await deployer.getAddress());

    perpTranches = [];
    remTranches = [];
    for (let i = 0; i < 4; i++) {
      const bond = await getDepositBond(perp);
      const tranches = await getTranches(bond);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
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
    depositBond = await bondAt(await perp.depositBond());
    depositTranches = await getTranches(depositBond);

    await checkVaultComposition(
      vault,
      [collateralToken, ...remTranches],
      [toFixedPtAmt("400"), toFixedPtAmt("400"), toFixedPtAmt("400"), toFixedPtAmt("400"), toFixedPtAmt("400")],
    );
  });

  async function checkDR(dr) {
    expect(await balancer.deviationRatio()).to.eq(dr);
    expect(await perp.deviationRatio()).to.eq(dr);
    expect(await vault.deviationRatio()).to.eq(dr);
  }

  describe("mint2", function () {
    let mintAmts: any;
    describe("when dr = 0", function () {
      beforeEach(async function () {
        await redeemVaultNotes(vault, toFixedPtAmt("2000000000"), deployer);
        await checkDR(0n);
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
      });

      it("should move dr closer to 1", async function () {
        await balancer.mint2(toFixedPtAmt("1000"));
        await checkDR(toPerc("0.17241379"));
      });
    });

    describe("when dr > 1", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("5000"), deployer);
        await checkDR(toPerc("1.75"));
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
      });

      it("should move dr closer to 1", async function () {
        await balancer.mint2(toFixedPtAmt("1000"));
        await checkDR(toPerc("1.62068964"));
      });
    });

    describe("when dr < 1", function () {
      beforeEach(async function () {
        await checkDR(toPerc("0.5"));
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
      });

      it("should move dr closer to 1", async function () {
        await balancer.mint2(toFixedPtAmt("1000"));
        await checkDR(toPerc("0.58620689"));
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
          [collateralToken, ...remTranches.slice(-4), depositTranches[1]],
          [
            toFixedPtAmt("566.666666666666666668"),
            toFixedPtAmt("400"),
            toFixedPtAmt("400"),
            toFixedPtAmt("400"),
            toFixedPtAmt("400"),
            toFixedPtAmt("666.666666666666666665"),
          ],
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
          .to.emit(perp, "Transfer")
          .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("1.666666666666666667"));
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
          [collateralToken, ...remTranches.slice(-4), depositTranches[1]],
          [
            toFixedPtAmt("3566.666666666666666668"),
            toFixedPtAmt("400"),
            toFixedPtAmt("400"),
            toFixedPtAmt("400"),
            toFixedPtAmt("400"),
            toFixedPtAmt("666.666666666666666665"),
          ],
        );
      });
    });
  });

  describe("#redeem2", function () {
    let txFn: any;
    describe("when fee is zero", function () {
      describe("when spot > stampl", function () {
        beforeEach(async function () {
          await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
          await balancer.mintVaultNotes(toFixedPtAmt("1000"));
          await perp.approve(balancer.target, toFixedPtAmt("100"));
          await vault.approve(balancer.target, toFixedPtAmt("100000000"));
          txFn = () =>
            balancer.redeem2({
              perpAmt: toFixedPtAmt("100"),
              noteAmt: toFixedPtAmt("100000000"),
            });
        });

        it("should return redeemed tokens", async function () {
          const r = await balancer.redeem2.staticCall({
            perpAmt: toFixedPtAmt("100"),
            noteAmt: toFixedPtAmt("100000000"),
          });

          await txFn();
          expect(r[0]).to.eq(toFixedPtAmt("134.999999999999998"));

          const perpTokens = r[1];
          expect(perpTokens[0].token).to.eq(perpTranches[3].target);
          expect(perpTokens[0].amount).to.eq(toFixedPtAmt("21.6666666666666668"));
          expect(perpTokens[1].token).to.eq(perpTranches[1].target);
          expect(perpTokens[1].amount).to.eq(toFixedPtAmt("21.6666666666666668"));
          expect(perpTokens[2].token).to.eq(perpTranches[2].target);
          expect(perpTokens[2].amount).to.eq(toFixedPtAmt("21.6666666666666668"));

          const vaultTokens = r[2];
          expect(vaultTokens.length).to.eq(0);
        });

        it("should burn perps", async function () {
          await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-100")]);
        });

        it("should burn vault notes", async function () {
          await expect(txFn).to.changeTokenBalances(vault, [deployer], [toFixedPtAmt("-100000000")]);
        });

        it("should transfer collateralTokens", async function () {
          await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("134.999999999999998")]);
        });

        it("should transfer tranches", async function () {
          await expect(txFn).to.changeTokenBalances(perpTranches[1], [deployer], [toFixedPtAmt("21.6666666666666668")]);
        });

        it("should transfer tranches", async function () {
          await expect(txFn).to.changeTokenBalances(perpTranches[2], [deployer], [toFixedPtAmt("21.6666666666666668")]);
        });

        it("should transfer tranches", async function () {
          await expect(txFn).to.changeTokenBalances(perpTranches[3], [deployer], [toFixedPtAmt("21.6666666666666668")]);
        });

        it("should leave no dust", async function () {
          await txFn();
          expect(await perpTranches[0].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[1].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[2].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[3].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[0].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[1].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[2].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[3].balanceOf(balancer.target)).to.eq(0n);
          expect(await perp.balanceOf(balancer.target)).to.eq(0n);
          expect(await vault.balanceOf(balancer.target)).to.eq(0n);
          expect(await collateralToken.balanceOf(balancer.target)).to.eq(0n);
        });
      });

      describe("when spot < stampl", function () {
        beforeEach(async function () {
          await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
          await balancer.mintVaultNotes(toFixedPtAmt("1000"));
          await perp.approve(balancer.target, toFixedPtAmt("10"));
          await vault.approve(balancer.target, toFixedPtAmt("100000000"));
          txFn = () =>
            balancer.redeem2({
              perpAmt: toFixedPtAmt("10"),
              noteAmt: toFixedPtAmt("100000000"),
            });
        });

        it("should return redeemed tokens", async function () {
          const r = await balancer.redeem2.staticCall({
            perpAmt: toFixedPtAmt("10"),
            noteAmt: toFixedPtAmt("100000000"),
          });

          await txFn();
          expect(r[0]).to.eq(toFixedPtAmt("100"));

          const perpTokens = r[1];
          expect(perpTokens.length).to.eq(0);

          const vaultTokens = r[2];
          expect(vaultTokens[0].token).to.eq(remTranches[3].target);
          expect(vaultTokens[0].amount).to.eq(toFixedPtAmt("3.333333333333333333"));
          expect(vaultTokens[1].token).to.eq(remTranches[1].target);
          expect(vaultTokens[1].amount).to.eq(toFixedPtAmt("3.333333333333333333"));
          expect(vaultTokens[2].token).to.eq(remTranches[2].target);
          expect(vaultTokens[2].amount).to.eq(toFixedPtAmt("3.333333333333333333"));
        });

        it("should burn perps", async function () {
          await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-10")]);
        });

        it("should burn vault notes", async function () {
          await expect(txFn).to.changeTokenBalances(vault, [deployer], [toFixedPtAmt("-100000000")]);
        });

        it("should transfer collateralTokens", async function () {
          await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("100")]);
        });

        it("should transfer tranches", async function () {
          await expect(txFn).to.changeTokenBalances(remTranches[1], [deployer], [toFixedPtAmt("3.333333333333333333")]);
        });

        it("should transfer tranches", async function () {
          await expect(txFn).to.changeTokenBalances(remTranches[2], [deployer], [toFixedPtAmt("3.333333333333333333")]);
        });

        it("should transfer tranches", async function () {
          await expect(txFn).to.changeTokenBalances(remTranches[3], [deployer], [toFixedPtAmt("3.333333333333333333")]);
        });

        it("should leave no dust", async function () {
          await txFn();
          expect(await perpTranches[0].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[1].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[2].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[3].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[0].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[1].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[2].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[3].balanceOf(balancer.target)).to.eq(0n);
          expect(await perp.balanceOf(balancer.target)).to.eq(0n);
          expect(await vault.balanceOf(balancer.target)).to.eq(0n);
          expect(await collateralToken.balanceOf(balancer.target)).to.eq(0n);
        });
      });

      describe("when spot = stampl", function () {
        beforeEach(async function () {
          await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
          await balancer.mintVaultNotes(toFixedPtAmt("1000"));
          await perp.approve(balancer.target, toFixedPtAmt("20"));
          await vault.approve(balancer.target, toFixedPtAmt("200000000"));
          txFn = () =>
            balancer.redeem2({
              perpAmt: toFixedPtAmt("13.6"),
              noteAmt: toFixedPtAmt("102000000"),
            });
        });

        it("should return redeemed tokens", async function () {
          const r = await balancer.redeem2.staticCall({
            perpAmt: toFixedPtAmt("13.6"),
            noteAmt: toFixedPtAmt("102000000"),
          });

          await txFn();
          expect(r[0]).to.eq(toFixedPtAmt("115.6"));

          const perpTokens = r[1];
          expect(perpTokens.length).to.eq(0);

          const vaultTokens = r[2];
          expect(vaultTokens.length).to.eq(0);
        });

        it("should burn perps", async function () {
          await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-13.6")]);
        });

        it("should burn vault notes", async function () {
          await expect(txFn).to.changeTokenBalances(vault, [deployer], [toFixedPtAmt("-102000000")]);
        });

        it("should transfer collateralTokens", async function () {
          await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("115.6")]);
        });

        it("should leave no dust", async function () {
          await txFn();
          expect(await perpTranches[0].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[1].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[2].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[3].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[0].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[1].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[2].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[3].balanceOf(balancer.target)).to.eq(0n);
          expect(await perp.balanceOf(balancer.target)).to.eq(0n);
          expect(await vault.balanceOf(balancer.target)).to.eq(0n);
          expect(await collateralToken.balanceOf(balancer.target)).to.eq(0n);
        });
      });
    });

    describe("when fee > zero", function () {
      beforeEach(async function () {
        await setFees(balancer, {
          perpBurnFeePerc: toPerc("0.01"),
          vaultBurnFeePerc: toPerc("0.05"),
        });
      });
      describe("when spot > stampl", function () {
        beforeEach(async function () {
          await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
          await balancer.mintVaultNotes(toFixedPtAmt("1000"));
          await perp.approve(balancer.target, toFixedPtAmt("100"));
          await vault.approve(balancer.target, toFixedPtAmt("100000000"));
          txFn = () =>
            balancer.redeem2({
              perpAmt: toFixedPtAmt("100"),
              noteAmt: toFixedPtAmt("100000000"),
            });
        });

        it("should return redeemed tokens", async function () {
          const r = await balancer.redeem2.staticCall({
            perpAmt: toFixedPtAmt("100"),
            noteAmt: toFixedPtAmt("100000000"),
          });

          await txFn();
          expect(r[0]).to.eq(toFixedPtAmt("129.249999999999999"));

          const perpTokens = r[1];
          expect(perpTokens[0].token).to.eq(perpTranches[3].target);
          expect(perpTokens[0].amount).to.eq(toFixedPtAmt("21.5833333333333334"));
          expect(perpTokens[1].token).to.eq(perpTranches[1].target);
          expect(perpTokens[1].amount).to.eq(toFixedPtAmt("21.5833333333333334"));
          expect(perpTokens[2].token).to.eq(perpTranches[2].target);
          expect(perpTokens[2].amount).to.eq(toFixedPtAmt("21.5833333333333334"));

          const vaultTokens = r[2];
          expect(vaultTokens.length).to.eq(0);
        });

        it("should burn perps", async function () {
          await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-100")]);
        });

        it("should burn vault notes", async function () {
          await expect(txFn).to.changeTokenBalances(vault, [deployer], [toFixedPtAmt("-100000000")]);
        });

        it("should transfer collateralTokens", async function () {
          await expect(txFn).to.changeTokenBalances(
            collateralToken,
            [deployer],
            [toFixedPtAmt("129.249999999999999000")],
          );
        });

        it("should transfer tranches", async function () {
          await expect(txFn).to.changeTokenBalances(perpTranches[1], [deployer], [toFixedPtAmt("21.5833333333333334")]);
        });

        it("should transfer tranches", async function () {
          await expect(txFn).to.changeTokenBalances(perpTranches[2], [deployer], [toFixedPtAmt("21.5833333333333334")]);
        });

        it("should transfer tranches", async function () {
          await expect(txFn).to.changeTokenBalances(perpTranches[3], [deployer], [toFixedPtAmt("21.5833333333333334")]);
        });

        it("should leave no dust", async function () {
          await txFn();
          expect(await perpTranches[0].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[1].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[2].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[3].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[0].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[1].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[2].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[3].balanceOf(balancer.target)).to.eq(0n);
          expect(await perp.balanceOf(balancer.target)).to.eq(0n);
          expect(await vault.balanceOf(balancer.target)).to.eq(0n);
          expect(await collateralToken.balanceOf(balancer.target)).to.eq(0n);
        });

        it("should burn perp fees", async function () {
          await expect(txFn())
            .to.emit(perp, "Transfer")
            .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("1"));
        });

        it("should burn vault fees", async function () {
          await expect(txFn())
            .to.emit(vault, "Transfer")
            .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("5000000"));
        });
      });

      describe("when spot < stampl", function () {
        beforeEach(async function () {
          await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
          await balancer.mintVaultNotes(toFixedPtAmt("1000"));
          await perp.approve(balancer.target, toFixedPtAmt("10"));
          await vault.approve(balancer.target, toFixedPtAmt("100000000"));
          txFn = () =>
            balancer.redeem2({
              perpAmt: toFixedPtAmt("10"),
              noteAmt: toFixedPtAmt("100000000"),
            });
        });

        it("should return redeemed tokens", async function () {
          const r = await balancer.redeem2.staticCall({
            perpAmt: toFixedPtAmt("10"),
            noteAmt: toFixedPtAmt("100000000"),
          });

          await txFn();
          expect(r[0]).to.eq(toFixedPtAmt("96.6"));

          const perpTokens = r[1];
          expect(perpTokens.length).to.eq(0);

          const vaultTokens = r[2];
          expect(vaultTokens[0].token).to.eq(remTranches[3].target);
          expect(vaultTokens[0].amount).to.eq(toFixedPtAmt("2.766666666666666666"));
          expect(vaultTokens[1].token).to.eq(remTranches[1].target);
          expect(vaultTokens[1].amount).to.eq(toFixedPtAmt("2.766666666666666666"));
          expect(vaultTokens[2].token).to.eq(remTranches[2].target);
          expect(vaultTokens[2].amount).to.eq(toFixedPtAmt("2.766666666666666666"));
        });

        it("should burn perps", async function () {
          await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-10")]);
        });

        it("should burn vault notes", async function () {
          await expect(txFn).to.changeTokenBalances(vault, [deployer], [toFixedPtAmt("-100000000")]);
        });

        it("should transfer collateralTokens", async function () {
          await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("96.6")]);
        });

        it("should transfer tranches", async function () {
          await expect(txFn).to.changeTokenBalances(remTranches[1], [deployer], [toFixedPtAmt("2.766666666666666666")]);
        });

        it("should transfer tranches", async function () {
          await expect(txFn).to.changeTokenBalances(remTranches[2], [deployer], [toFixedPtAmt("2.766666666666666666")]);
        });

        it("should transfer tranches", async function () {
          await expect(txFn).to.changeTokenBalances(remTranches[3], [deployer], [toFixedPtAmt("2.766666666666666666")]);
        });

        it("should leave no dust", async function () {
          await txFn();
          expect(await perpTranches[0].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[1].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[2].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[3].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[0].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[1].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[2].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[3].balanceOf(balancer.target)).to.eq(0n);
          expect(await perp.balanceOf(balancer.target)).to.eq(0n);
          expect(await vault.balanceOf(balancer.target)).to.eq(0n);
          expect(await collateralToken.balanceOf(balancer.target)).to.eq(0n);
        });

        it("should burn perp fees", async function () {
          await expect(txFn())
            .to.emit(perp, "Transfer")
            .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("0.1"));
        });

        it("should burn vault fees", async function () {
          await expect(txFn())
            .to.emit(vault, "Transfer")
            .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("5000000"));
        });
      });

      describe("when spot = stampl", function () {
        beforeEach(async function () {
          await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
          await balancer.mintVaultNotes(toFixedPtAmt("1000"));
          await perp.approve(balancer.target, toFixedPtAmt("20"));
          await vault.approve(balancer.target, toFixedPtAmt("200000000"));
          txFn = () =>
            balancer.redeem2({
              perpAmt: toFixedPtAmt("14"),
              noteAmt: toFixedPtAmt("109421052.63"),
            });
        });

        it("should return redeemed tokens", async function () {
          const r = await balancer.redeem2.staticCall({
            perpAmt: toFixedPtAmt("14"),
            noteAmt: toFixedPtAmt("109421052.63"),
          });

          await txFn();
          expect(r[0]).to.eq(toFixedPtAmt("117.80999999835"));

          const perpTokens = r[1];
          expect(perpTokens.length).to.eq(0);

          const vaultTokens = r[2];
          expect(vaultTokens.length).to.eq(0);
        });

        it("should burn perps", async function () {
          await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-14")]);
        });

        it("should burn vault notes", async function () {
          await expect(txFn).to.changeTokenBalances(vault, [deployer], [toFixedPtAmt("-109421052.63")]);
        });

        it("should transfer collateralTokens", async function () {
          await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("117.80999999835")]);
        });

        it("should leave no dust", async function () {
          await txFn();
          expect(await perpTranches[0].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[1].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[2].balanceOf(balancer.target)).to.eq(0n);
          expect(await perpTranches[3].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[0].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[1].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[2].balanceOf(balancer.target)).to.eq(0n);
          expect(await remTranches[3].balanceOf(balancer.target)).to.eq(0n);
          expect(await perp.balanceOf(balancer.target)).to.eq(0n);
          expect(await vault.balanceOf(balancer.target)).to.eq(0n);
          expect(await collateralToken.balanceOf(balancer.target)).to.eq(0n);
        });

        it("should burn perp fees", async function () {
          await expect(txFn())
            .to.emit(perp, "Transfer")
            .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("0.14"));
        });

        it("should burn vault fees", async function () {
          await expect(txFn())
            .to.emit(vault, "Transfer")
            .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("5471052.6315"));
        });
      });
    });
  });

  describe("#rebalance", function () {
    let txFn: any;

    describe("when invoked by a non-whitelisted address", async function () {
      it("should revert", async function () {
        await balancer.removeRebalancer(await deployer.getAddress());
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
        await balancer.mintVaultNotes(toFixedPtAmt("1000"));
        await perp.approve(balancer.target, toFixedPtAmt("100"));
        await vault.approve(balancer.target, toFixedPtAmt("100000000"));
        expect(
          balancer.rebalance({
            perpAmt: toFixedPtAmt("100"),
            noteAmt: toFixedPtAmt("100000000"),
          }),
        ).to.be.revertedWithCustomError(balancer, "UnauthorizedCall");
      });
    });

    describe("when spot > stampl", function () {
      beforeEach(async function () {
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
        await balancer.mintVaultNotes(toFixedPtAmt("1000"));
        await perp.approve(balancer.target, toFixedPtAmt("100"));
        await vault.approve(balancer.target, toFixedPtAmt("100000000"));
        txFn = () =>
          balancer.rebalance({
            perpAmt: toFixedPtAmt("100"),
            noteAmt: toFixedPtAmt("100000000"),
          });
      });

      it("should return rebalanced tokens", async function () {
        const r = await balancer.rebalance.staticCall({
          perpAmt: toFixedPtAmt("100"),
          noteAmt: toFixedPtAmt("100000000"),
        });

        await txFn();
        expect(r[0][0]).to.eq(toFixedPtAmt("22.499999999999999666"));
        expect(r[0][1]).to.eq(toFixedPtAmt("112499999.999999998271931033"));

        const perpTokens = r[1];
        expect(perpTokens[0].token).to.eq(perpTranches[3].target);
        expect(perpTokens[0].amount).to.eq(toFixedPtAmt("21.6666666666666668"));
        expect(perpTokens[1].token).to.eq(perpTranches[1].target);
        expect(perpTokens[1].amount).to.eq(toFixedPtAmt("21.6666666666666668"));
        expect(perpTokens[2].token).to.eq(perpTranches[2].target);
        expect(perpTokens[2].amount).to.eq(toFixedPtAmt("21.6666666666666668"));

        const vaultTokens = r[2];
        expect(vaultTokens.length).to.eq(0);
      });

      it("should re-mint perps", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-77.500000000000000334")]);
      });

      it("should re-mint vault notes", async function () {
        await expect(txFn).to.changeTokenBalances(vault, [deployer], [toFixedPtAmt("12499999.999999998271931033")]);
      });

      it("should NOT transfer collateralTokens", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], ["0"]);
      });

      it("should transfer tranches", async function () {
        await expect(txFn).to.changeTokenBalances(perpTranches[1], [deployer], [toFixedPtAmt("21.6666666666666668")]);
      });

      it("should transfer tranches", async function () {
        await expect(txFn).to.changeTokenBalances(perpTranches[2], [deployer], [toFixedPtAmt("21.6666666666666668")]);
      });

      it("should transfer tranches", async function () {
        await expect(txFn).to.changeTokenBalances(perpTranches[3], [deployer], [toFixedPtAmt("21.6666666666666668")]);
      });

      it("should leave no dust", async function () {
        await txFn();
        expect(await perpTranches[0].balanceOf(balancer.target)).to.eq(0n);
        expect(await perpTranches[1].balanceOf(balancer.target)).to.eq(0n);
        expect(await perpTranches[2].balanceOf(balancer.target)).to.eq(0n);
        expect(await perpTranches[3].balanceOf(balancer.target)).to.eq(0n);
        expect(await remTranches[0].balanceOf(balancer.target)).to.eq(0n);
        expect(await remTranches[1].balanceOf(balancer.target)).to.eq(0n);
        expect(await remTranches[2].balanceOf(balancer.target)).to.eq(0n);
        expect(await remTranches[3].balanceOf(balancer.target)).to.eq(0n);
        expect(await perp.balanceOf(balancer.target)).to.eq(0n);
        expect(await vault.balanceOf(balancer.target)).to.eq(0n);
        expect(await collateralToken.balanceOf(balancer.target)).to.eq(0n);
      });
    });

    describe("when spot < stampl", function () {
      beforeEach(async function () {
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
        await balancer.mintVaultNotes(toFixedPtAmt("1000"));
        await perp.approve(balancer.target, toFixedPtAmt("10"));
        await vault.approve(balancer.target, toFixedPtAmt("100000000"));
        txFn = () =>
          balancer.rebalance({
            perpAmt: toFixedPtAmt("10"),
            noteAmt: toFixedPtAmt("100000000"),
          });
      });

      it("should return rebalanced tokens", async function () {
        const r = await balancer.rebalance.staticCall({
          perpAmt: toFixedPtAmt("10"),
          noteAmt: toFixedPtAmt("100000000"),
        });

        await txFn();
        expect(r[0][0]).to.eq(toFixedPtAmt("16.666666666666666666"));
        expect(r[0][1]).to.eq(toFixedPtAmt("83333333.333333333333971263"));

        const perpTokens = r[1];
        expect(perpTokens.length).to.eq(0);

        const vaultTokens = r[2];
        expect(vaultTokens[0].token).to.eq(remTranches[3].target);
        expect(vaultTokens[0].amount).to.eq(toFixedPtAmt("3.333333333333333333"));
        expect(vaultTokens[1].token).to.eq(remTranches[1].target);
        expect(vaultTokens[1].amount).to.eq(toFixedPtAmt("3.333333333333333333"));
        expect(vaultTokens[2].token).to.eq(remTranches[2].target);
        expect(vaultTokens[2].amount).to.eq(toFixedPtAmt("3.333333333333333333"));
      });

      it("should re-mint perps", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("6.666666666666666666")]);
      });

      it("should re-mint vault notes", async function () {
        await expect(txFn).to.changeTokenBalances(vault, [deployer], [toFixedPtAmt("-16666666.666666666666028737")]);
      });

      it("should NOT transfer collateralTokens", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], ["0"]);
      });

      it("should transfer tranches", async function () {
        await expect(txFn).to.changeTokenBalances(remTranches[1], [deployer], [toFixedPtAmt("3.333333333333333333")]);
      });

      it("should transfer tranches", async function () {
        await expect(txFn).to.changeTokenBalances(remTranches[2], [deployer], [toFixedPtAmt("3.333333333333333333")]);
      });

      it("should transfer tranches", async function () {
        await expect(txFn).to.changeTokenBalances(remTranches[3], [deployer], [toFixedPtAmt("3.333333333333333333")]);
      });

      it("should leave no dust", async function () {
        await txFn();
        expect(await perpTranches[0].balanceOf(balancer.target)).to.eq(0n);
        expect(await perpTranches[1].balanceOf(balancer.target)).to.eq(0n);
        expect(await perpTranches[2].balanceOf(balancer.target)).to.eq(0n);
        expect(await perpTranches[3].balanceOf(balancer.target)).to.eq(0n);
        expect(await remTranches[0].balanceOf(balancer.target)).to.eq(0n);
        expect(await remTranches[1].balanceOf(balancer.target)).to.eq(0n);
        expect(await remTranches[2].balanceOf(balancer.target)).to.eq(0n);
        expect(await remTranches[3].balanceOf(balancer.target)).to.eq(0n);
        expect(await perp.balanceOf(balancer.target)).to.eq(0n);
        expect(await vault.balanceOf(balancer.target)).to.eq(0n);
        expect(await collateralToken.balanceOf(balancer.target)).to.eq(0n);
      });
    });

    describe("when spot = stampl", function () {
      beforeEach(async function () {
        await collateralToken.approve(balancer.target, toFixedPtAmt("1000"));
        await balancer.mintVaultNotes(toFixedPtAmt("1000"));
        await perp.approve(balancer.target, toFixedPtAmt("20"));
        await vault.approve(balancer.target, toFixedPtAmt("200000000"));
        txFn = () =>
          balancer.rebalance({
            perpAmt: toFixedPtAmt("13.6"),
            noteAmt: toFixedPtAmt("102000000"),
          });
      });

      it("should return redeemed tokens", async function () {
        const r = await balancer.rebalance.staticCall({
          perpAmt: toFixedPtAmt("13.6"),
          noteAmt: toFixedPtAmt("102000000"),
        });

        await txFn();
        expect(r[0][0]).to.eq(toFixedPtAmt("19.266666666666666666"));
        expect(r[0][1]).to.eq(toFixedPtAmt("96333333.333333333334"));

        const perpTokens = r[1];
        expect(perpTokens.length).to.eq(0);

        const vaultTokens = r[2];
        expect(vaultTokens.length).to.eq(0);
      });

      it("should re-mint perps", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("5.666666666666666666")]);
      });

      it("should re-mint vault notes", async function () {
        await expect(txFn).to.changeTokenBalances(vault, [deployer], [toFixedPtAmt("-5666666.666666666666")]);
      });

      it("should NOT transfer collateralTokens", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], ["0"]);
      });

      it("should leave no dust", async function () {
        await txFn();
        expect(await perpTranches[0].balanceOf(balancer.target)).to.eq(0n);
        expect(await perpTranches[1].balanceOf(balancer.target)).to.eq(0n);
        expect(await perpTranches[2].balanceOf(balancer.target)).to.eq(0n);
        expect(await perpTranches[3].balanceOf(balancer.target)).to.eq(0n);
        expect(await remTranches[0].balanceOf(balancer.target)).to.eq(0n);
        expect(await remTranches[1].balanceOf(balancer.target)).to.eq(0n);
        expect(await remTranches[2].balanceOf(balancer.target)).to.eq(0n);
        expect(await remTranches[3].balanceOf(balancer.target)).to.eq(0n);
        expect(await perp.balanceOf(balancer.target)).to.eq(0n);
        expect(await vault.balanceOf(balancer.target)).to.eq(0n);
        expect(await collateralToken.balanceOf(balancer.target)).to.eq(0n);
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

      it("should transfer collateralTokens", async function () {
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

      it("should transfer collateralTokens", async function () {
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
        await checkVaultComposition(
          vault,
          [collateralToken, ...remTranches.slice(-4)],
          [toFixedPtAmt("1400"), toFixedPtAmt("400"), toFixedPtAmt("400"), toFixedPtAmt("400"), toFixedPtAmt("400")],
        );
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
        await checkVaultComposition(
          vault,
          [collateralToken, ...remTranches.slice(-4)],
          [toFixedPtAmt("1400"), toFixedPtAmt("400"), toFixedPtAmt("400"), toFixedPtAmt("400"), toFixedPtAmt("400")],
        );
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

      it("should transfer collateralTokens", async function () {
        await expect(() => balancer.redeemVaultNotes(toFixedPtAmt("100000000"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("33.333333333333333333")],
        );
      });

      it("should transfer tranches", async function () {
        await expect(() => balancer.redeemVaultNotes(toFixedPtAmt("100000000"))).to.changeTokenBalances(
          depositTranches[1],
          [deployer],
          [toFixedPtAmt("37.333333333333333333")],
        );
      });

      it("should return the redemptionAmts amount", async function () {
        expect(redemptionAmts[0].token).to.eq(collateralToken.target);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("33.333333333333333333"));
        expect(redemptionAmts[1].token).to.eq(depositTranches[1].target);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("37.333333333333333333"));
      });

      it("should have the updated composition", async function () {
        await balancer.redeemVaultNotes(toFixedPtAmt("100000000"));
        await checkVaultComposition(
          vault,
          [collateralToken, ...remTranches.slice(-3), depositTranches[1]],
          [
            toFixedPtAmt("966.666666666666666667"),
            toFixedPtAmt("77.333333333333333334"),
            toFixedPtAmt("386.666666666666666667"),
            toFixedPtAmt("386.666666666666666667"),
            toFixedPtAmt("1082.666666666666666667"),
          ],
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

      it("should transfer collateralTokens", async function () {
        await expect(() => balancer.redeemVaultNotes(toFixedPtAmt("100000000"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("30")],
        );
      });

      it("should transfer tranches", async function () {
        await expect(() => balancer.redeemVaultNotes(toFixedPtAmt("100000000"))).to.changeTokenBalances(
          depositTranches[1],
          [deployer],
          [toFixedPtAmt("33.6")],
        );
      });

      it("should return the redemptionAmts amount", async function () {
        expect(redemptionAmts[0].token).to.eq(collateralToken.target);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("30"));
        expect(redemptionAmts[1].token).to.eq(depositTranches[1].target);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("33.6"));
      });

      it("should have the updated composition", async function () {
        await balancer.redeemVaultNotes(toFixedPtAmt("100000000"));
        await checkVaultComposition(
          vault,
          [collateralToken, ...remTranches.slice(-3), depositTranches[1]],
          [
            toFixedPtAmt("970"),
            toFixedPtAmt("77.6"),
            toFixedPtAmt("388.0"),
            toFixedPtAmt("388.0"),
            toFixedPtAmt("1086.4"),
          ],
        );
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
        await mintVaultNotes(vault, toFixedPtAmt("2000"), deployer);
        await checkDR(toPerc("1"));
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
          [collateralToken, ...remTranches.slice(-4), depositTranches[1]],
          [
            toFixedPtAmt("2000"),
            toFixedPtAmt("400"),
            toFixedPtAmt("400"),
            toFixedPtAmt("400"),
            toFixedPtAmt("400"),
            toFixedPtAmt("400"),
          ],
        );
      });

      it("should reduce the system dr", async function () {
        await balancer.swapUnderlyingForPerps(toFixedPtAmt("100"));
        await checkDR(toPerc("0.88888888"));
      });
    });

    describe("when fee > 0", function () {
      beforeEach(async function () {
        await setFees(balancer, {
          protocolSwapSharePerc: toPerc("0.25"),
          underlyingToPerpSwapFeePerc: toPerc("0.15"),
        });
        await mintVaultNotes(vault, toFixedPtAmt("2000"), deployer);
        await checkDR(toPerc("1"));
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
          [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("86.875")],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, ...remTranches.slice(-4), depositTranches[1]],
          [
            toFixedPtAmt("2061.875"),
            toFixedPtAmt("400"),
            toFixedPtAmt("400"),
            toFixedPtAmt("400"),
            toFixedPtAmt("400"),
            toFixedPtAmt("347.5"),
          ],
        );
      });

      it("should reduce the system dr", async function () {
        await balancer.swapUnderlyingForPerps(toFixedPtAmt("100"));
        await checkDR(toPerc("0.90415785"));
      });

      it("should burn perp fees", async function () {
        await expect(balancer.swapUnderlyingForPerps(toFixedPtAmt("100")))
          .to.emit(perp, "Transfer")
          .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("1.875"));
      });

      it("should settle vault fees", async function () {
        await expect(balancer.swapUnderlyingForPerps(toFixedPtAmt("100")))
          .to.emit(collateralToken, "Transfer")
          .withArgs(balancer.target, vault.target, toFixedPtAmt("9.375"));
      });

      it("should settle protocol fees", async function () {
        await expect(balancer.swapUnderlyingForPerps(toFixedPtAmt("100")))
          .to.emit(collateralToken, "Transfer")
          .withArgs(balancer.target, await otherUser.getAddress(), toFixedPtAmt("3.75"));
      });

      it("should leave no dust", async function () {
        expect(await collateralToken.balanceOf(balancer.target)).to.eq(0);
        expect(await perp.balanceOf(balancer.target)).to.eq(0);
      });
    });
  });

  describe("swapPerpsForUnderlying", function () {
    let swapAmt: any;
    describe("when fee = 0", function () {
      beforeEach(async function () {
        await mintVaultNotes(vault, toFixedPtAmt("2000"), deployer);
        await checkDR(toPerc("1"));
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
          [collateralToken, ...remTranches.slice(-4)],
          [toFixedPtAmt("2700"), toFixedPtAmt("400"), toFixedPtAmt("300"), toFixedPtAmt("300"), toFixedPtAmt("300")],
        );
      });

      it("should increase the system dr", async function () {
        await balancer.swapPerpsForUnderlying(toFixedPtAmt("100"));
        await checkDR(toPerc("1.14285713"));
      });
    });

    describe("when fee > 0", function () {
      beforeEach(async function () {
        await setFees(balancer, {
          protocolSwapSharePerc: toPerc("0.25"),
          perpToUnderlyingSwapFeePerc: toPerc("0.1"),
        });
        await mintVaultNotes(vault, toFixedPtAmt("2000"), deployer);
        await checkDR(toPerc("1"));
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
          [toFixedPtAmt("90")],
        );
      });

      it("should return the swap amount", async function () {
        expect(swapAmt).to.eq(toFixedPtAmt("90"));
      });

      it("should have the updated composition", async function () {
        await balancer.swapPerpsForUnderlying(toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...perpTranches.slice(-3)],
          [toFixedPtAmt("175.3125"), toFixedPtAmt("175.3125"), toFixedPtAmt("175.3125"), toFixedPtAmt("175.3125")],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, ...remTranches.slice(-4)],
          [
            toFixedPtAmt("2702.5"),
            toFixedPtAmt("400"),
            toFixedPtAmt("301.25"),
            toFixedPtAmt("301.25"),
            toFixedPtAmt("301.25"),
          ],
        );
      });

      it("should increase the system dr", async function () {
        await balancer.swapPerpsForUnderlying(toFixedPtAmt("100"));
        await checkDR(toPerc("1.14260248"));
      });

      it("should burn perp fees", async function () {
        await expect(balancer.swapPerpsForUnderlying(toFixedPtAmt("100")))
          .to.emit(perp, "Transfer")
          .withArgs(balancer.target, ethers.ZeroAddress, toFixedPtAmt("1.25"));
      });

      it("should settle vault fees", async function () {
        await expect(balancer.swapPerpsForUnderlying(toFixedPtAmt("100")))
          .to.emit(collateralToken, "Transfer")
          .withArgs(balancer.target, vault.target, toFixedPtAmt("6.25"));
      });

      it("should settle protocol fees", async function () {
        await expect(balancer.swapPerpsForUnderlying(toFixedPtAmt("100")))
          .to.emit(collateralToken, "Transfer")
          .withArgs(balancer.target, await otherUser.getAddress(), toFixedPtAmt("2.5"));
      });

      it("should leave no dust", async function () {
        expect(await collateralToken.balanceOf(balancer.target)).to.eq(0);
        expect(await perp.balanceOf(balancer.target)).to.eq(0);
      });
    });
  });
});
