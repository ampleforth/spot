import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer, Transaction } from "ethers";
import {
  setupCollateralToken,
  mintCollteralToken,
  setupBondFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toPercFixedPtAmt,
  getDepositBond,
  advancePerpQueue,
  advancePerpQueueToBondMaturity,
  checkPerpComposition,
  checkVaultComposition,
  rebase,
  DMock,
} from "../helpers";

let vault: Contract;
let perp: Contract;
let bondFactory: Contract;
let collateralToken: Contract;
let rebaseOracle: Contract;
let issuer: Contract;
let balancer: Contract;
let deployer: Signer;
let reserveTranches: Contract[][] = [];
let remainingJuniorTranches: Contract[][] = [];
let currentBondIn: Contract;
let currentTranchesIn: Contract[];

describe("RolloverVault", function () {
  beforeEach(async function () {
    await network.provider.request({ method: "hardhat_reset" });

    const accounts = await ethers.getSigners();
    deployer = accounts[0];

    bondFactory = await setupBondFactory();
    ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));

    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await upgrades.deployProxy(
      BondIssuer.connect(deployer),
      [bondFactory.target, collateralToken.target, 4800, [200, 800], 1200, 0],
      {
        initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
      },
    );

    balancer = new DMock(await ethers.getContractFactory("Balancer"));
    await balancer.deploy();
    await balancer.mockMethod("decimals()", [8]);
    await balancer.mockMethod("computeDeviationRatio((uint256,uint256,uint256))", [toPercFixedPtAmt("1")]);
    await balancer.mockMethod("computeRolloverFeePerc(uint256)", [0n]);

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
    await collateralToken.approve(vault.target, toFixedPtAmt("1"));
    await vault.init("RolloverVault", "VSHARE", perp.target);
    await vault.updateBalancer(balancer.target);
    await perp.updateVault(await deployer.getAddress());

    reserveTranches = [];
    remainingJuniorTranches = [];
    for (let i = 0; i < 4; i++) {
      const bond = await getDepositBond(perp);
      const tranches = await getTranches(bond);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);

      await tranches[0].approve(perp.target, toFixedPtAmt("200"));
      await perp.deposit(tranches[0].target, toFixedPtAmt("200"));

      reserveTranches.push(tranches[0]);
      remainingJuniorTranches.push(tranches[1]);
      await advancePerpQueue(perp, 1200);
    }

    await perp.updateVault(vault.target);
    await perp.updateBalancer(balancer.target);

    await checkPerpComposition(
      perp,
      [collateralToken, ...reserveTranches.slice(-3)],
      [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
    );
    await checkVaultComposition(vault, [collateralToken], [0]);
    expect(await vault.assetCount()).to.eq(1);

    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
    currentBondIn = await bondAt(await perp.depositBond());
    currentTranchesIn = await getTranches(currentBondIn);
    await collateralToken.transfer(vault.target, toFixedPtAmt("1000"));
    await vault.deploy();
    await collateralToken.transfer(vault.target, toFixedPtAmt("1000"));

    await checkVaultComposition(
      vault,
      [collateralToken, currentTranchesIn[1]],
      [toFixedPtAmt("1200"), toFixedPtAmt("800")],
    );
    expect(await vault.assetCount()).to.eq(2);

    await collateralToken.approve(vault.target, toFixedPtAmt("1000"));
    await perp.approve(vault.target, toFixedPtAmt("1000"));

    await vault.updateBalancer(await deployer.getAddress());
  });

  afterEach(async function () {
    await network.provider.request({ method: "hardhat_reset" });
  });

  describe("#swapUnderlyingForPerps", function () {
    describe("when perp price is 1", function () {
      it("should compute swap amount", async function () {
        const s = await vault.swapUnderlyingForPerps.staticCall(toFixedPtAmt("100"));
        expect(s).to.eq(toFixedPtAmt("100"));
      });

      it("should update vault after swap", async function () {
        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await vault.swapUnderlyingForPerps(toFixedPtAmt("100"));

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("800"), toFixedPtAmt("1200")],
        );
      });
    });

    describe("when perp price > 1", function () {
      beforeEach(async function () {
        await collateralToken.transfer(perp.target, toFixedPtAmt("800"));
      });

      it("should compute swap amount", async function () {
        const s = await vault.swapUnderlyingForPerps.staticCall(toFixedPtAmt("100"));
        expect(s).to.eq(toFixedPtAmt("50"));
      });

      it("should update vault after swap", async function () {
        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await vault.swapUnderlyingForPerps(toFixedPtAmt("100"));

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("800"), toFixedPtAmt("1200")],
        );
      });
    });

    describe("when perp price < 1", function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.9);
      });
      it("should compute swap amount", async function () {
        const s = await vault.swapUnderlyingForPerps.staticCall(toFixedPtAmt("100"));
        expect(s).to.eq(toFixedPtAmt("200"));
      });
      it("should update vault after swap", async function () {
        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("120"), toFixedPtAmt("800")],
        );

        await vault.swapUnderlyingForPerps(toFixedPtAmt("100"));

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("120"), toFixedPtAmt("1600")],
        );
      });
    });

    describe("when perp price is 1 but deposit bond has rebased down", function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.1);
      });

      it("should compute swap amount", async function () {
        const s = await vault.swapUnderlyingForPerps.staticCall(toFixedPtAmt("100"));
        expect(s).to.eq(toFixedPtAmt("100"));
      });

      it("should update vault after swap", async function () {
        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1080"), toFixedPtAmt("800")],
        );

        await vault.swapUnderlyingForPerps(toFixedPtAmt("100"));

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("730"), toFixedPtAmt("1200")],
        );
      });
    });

    describe("when perp price is 1 but deposit bond has rebased up", function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, 0.1);
      });

      it("should compute swap amount", async function () {
        const s = await vault.swapUnderlyingForPerps.staticCall(toFixedPtAmt("100"));
        expect(s).to.eq(toFixedPtAmt("100"));
      });

      it("should update vault after swap", async function () {
        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1320"), toFixedPtAmt("800")],
        );

        await vault.swapUnderlyingForPerps(toFixedPtAmt("100"));

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("870"), toFixedPtAmt("1200")],
        );
      });
    });

    describe("when swap amount is zero", function () {
      it("should be reverted", async function () {
        await expect(vault.swapUnderlyingForPerps(0)).to.be.revertedWithCustomError(vault, "UnacceptableSwap");
      });
    });

    describe("when absolute liquidity is too low", function () {
      beforeEach(async function () {
        await vault.updateLiquidityLimits(toFixedPtAmt("1001"), "0", ethers.MaxUint256);
      });
      it("should be reverted", async function () {
        await expect(vault.swapUnderlyingForPerps(toFixedPtAmt("50"))).to.be.revertedWithCustomError(
          vault,
          "LiquidityOutOfBounds",
        );
        await expect(vault.swapUnderlyingForPerps(toFixedPtAmt("1"))).not.to.be.reverted;
      });
    });

    describe("when liquidity perc is too low", function () {
      beforeEach(async function () {
        await vault.updateLiquidityLimits("0", toPercFixedPtAmt("0.35"), ethers.MaxUint256);
      });
      it("should be reverted", async function () {
        await expect(vault.swapUnderlyingForPerps(toFixedPtAmt("50"))).to.be.revertedWithCustomError(
          vault,
          "LiquidityOutOfBounds",
        );
        await expect(vault.swapUnderlyingForPerps(toFixedPtAmt("1"))).not.to.be.reverted;
      });
    });

    describe("on successful swap", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        txFn = () => vault.swapUnderlyingForPerps(toFixedPtAmt("100"));
      });

      it("should mint perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn()).to.emit(perp, "Transfer").withArgs(ethers.ZeroAddress, vault.target, toFixedPtAmt("100"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("900"));
        expect(await perp.balanceOf(vault.target)).to.eq(0);
      });

      it("should return the perp amt", async function () {
        expect(await vault.swapUnderlyingForPerps.staticCall(toFixedPtAmt("100"))).to.eq(toFixedPtAmt("100"));
      });

      it("should transfer underlying from the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("-100")]);
      });

      it("should transfer back perps to the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("100")]);
      });

      it("should update the vault assets", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("300")],
        );

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("800"), toFixedPtAmt("1200")],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("2000"));
      });
    });

    describe("on successful swap with imperfect rounding", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        txFn = () => vault.swapUnderlyingForPerps(toFixedPtAmt("100.999999999999999999"));
      });

      it("should mint perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(ethers.ZeroAddress, vault.target, toFixedPtAmt("100.999999999999999999"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("900.999999999999999999"));
        expect(await perp.balanceOf(vault.target)).to.eq(0);
      });

      it("should return the perp amt", async function () {
        expect(await vault.swapUnderlyingForPerps.staticCall(toFixedPtAmt("100.999999999999999999"))).to.eq(
          toFixedPtAmt("100.999999999999999999"),
        );
      });

      it("should transfer underlying from the user", async function () {
        await expect(txFn).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("-100.999999999999999999")],
        );
      });

      it("should transfer back perps to the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("100.999999999999999999")]);
      });

      it("should update the vault assets", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("300.999999999999999999")],
        );

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("796.000000000000000004"), toFixedPtAmt("1203.999999999999999996")],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("2000"));
      });
    });

    describe("on successful swap when deposit bond is fresh", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, await getDepositBond(perp));
        txFn = () => vault.swapUnderlyingForPerps(toFixedPtAmt("100"));
      });

      it("should mint perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn()).to.emit(perp, "Transfer").withArgs(ethers.ZeroAddress, vault.target, toFixedPtAmt("100"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("900"));
        expect(await perp.balanceOf(vault.target)).to.eq(0);
      });

      it("should return the perp amt", async function () {
        expect(await vault.swapUnderlyingForPerps.staticCall(toFixedPtAmt("100"))).to.eq(toFixedPtAmt("100"));
      });

      it("should transfer underlying from the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("-100")]);
      });

      it("should transfer back perps to the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("100")]);
      });

      it("should update the vault assets", async function () {
        const depositBond = await bondAt(await perp.depositBond());
        const depositTranches = await getTranches(depositBond);
        await checkPerpComposition(perp, [collateralToken], [toFixedPtAmt("800")]);

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkPerpComposition(
          perp,
          [collateralToken, depositTranches[0]],
          [toFixedPtAmt("800"), toFixedPtAmt("100")],
        );

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1], depositTranches[1]],
          [toFixedPtAmt("800"), toFixedPtAmt("800"), toFixedPtAmt("400")],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("2000"));
      });
    });
  });

  describe("#swapPerpsForUnderlying", function () {
    describe("when perp price is 1", function () {
      it("should compute swap amount", async function () {
        const s = await vault.swapPerpsForUnderlying.staticCall(toFixedPtAmt("100"));
        expect(s).to.eq(toFixedPtAmt("100"));
      });
    });

    describe("when perp price > 1", function () {
      beforeEach(async function () {
        await collateralToken.transfer(perp.target, toFixedPtAmt("800"));
      });
      it("should compute swap amount", async function () {
        const s = await vault.swapPerpsForUnderlying.staticCall(toFixedPtAmt("100"));
        expect(s).to.eq(toFixedPtAmt("200"));
      });
    });

    describe("when perp price < 1", function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.9);
      });
      it("should compute swap amount", async function () {
        const s = await vault.swapPerpsForUnderlying.staticCall(toFixedPtAmt("100"));
        expect(s).to.eq(toFixedPtAmt("50"));
      });
    });

    describe("when swap amount is zero", function () {
      it("should be reverted", async function () {
        await expect(vault.swapPerpsForUnderlying(0)).to.be.revertedWithCustomError(vault, "UnacceptableSwap");
      });
    });

    describe("on successful swap", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        txFn = () => vault.swapPerpsForUnderlying(toFixedPtAmt("100"));
      });

      it("should redeem perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn()).to.emit(perp, "Transfer").withArgs(vault.target, ethers.ZeroAddress, toFixedPtAmt("100"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("700"));
        expect(await perp.balanceOf(vault.target)).to.eq(0);
      });

      it("should return the underlying amt", async function () {
        expect(await vault.swapPerpsForUnderlying.staticCall(toFixedPtAmt("100"))).to.eq(toFixedPtAmt("100"));
      });

      it("should transfer perps from the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-100")]);
      });

      it("should transfer back underlying to the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("100")]);
      });

      it("should update the vault assets", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("175"), toFixedPtAmt("175"), toFixedPtAmt("175"), toFixedPtAmt("175")],
        );

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1], ...reserveTranches.slice(-3)],
          [toFixedPtAmt("1225"), toFixedPtAmt("700"), toFixedPtAmt("25"), toFixedPtAmt("25"), toFixedPtAmt("25")],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("2000"));
      });
    });

    describe("on successful swap with imperfect rounding", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        txFn = () => vault.swapPerpsForUnderlying(toFixedPtAmt("100.999999999999999999"));
      });

      it("should redeem perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.target, ethers.ZeroAddress, toFixedPtAmt("100.999999999999999999"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("699.000000000000000001"));
        expect(await perp.balanceOf(vault.target)).to.eq(0);
      });

      it("should return the underlying amt", async function () {
        expect(await vault.swapPerpsForUnderlying.staticCall(toFixedPtAmt("100.999999999999999999"))).to.eq(
          toFixedPtAmt("100.999999999999999999"),
        );
      });

      it("should transfer perps from the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-100.999999999999999999")]);
      });

      it("should transfer back underlying to the user", async function () {
        await expect(txFn).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("100.999999999999999999")],
        );
      });

      it("should update the vault assets", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            0,
            toFixedPtAmt("174.750000000000000001"),
            toFixedPtAmt("174.750000000000000001"),
            toFixedPtAmt("174.750000000000000001"),
            toFixedPtAmt("174.750000000000000001"),
          ],
        );

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1], ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            toFixedPtAmt("1225.249999999999999001"),
            toFixedPtAmt("699.0000000000000008"),
            toFixedPtAmt("25.249999999999999999"),
            toFixedPtAmt("25.249999999999999999"),
            toFixedPtAmt("25.249999999999999999"),
            toFixedPtAmt("0.000000000000000199"),
          ],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        // NOTE: the computed tvl goes down slightly because dust assets aren't counted
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("1999.999999999999999798"));
      });
    });

    describe("on successful swap with some the juniors in the vault", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        remainingJuniorTranches[1].transfer(vault.target, toFixedPtAmt("100"));
        remainingJuniorTranches[2].transfer(vault.target, toFixedPtAmt("100"));
        remainingJuniorTranches[3].transfer(vault.target, toFixedPtAmt("100"));
        txFn = () => vault.swapPerpsForUnderlying(toFixedPtAmt("200"));
      });

      it("should redeem perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn()).to.emit(perp, "Transfer").withArgs(vault.target, ethers.ZeroAddress, toFixedPtAmt("200"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("600"));
        expect(await perp.balanceOf(vault.target)).to.eq(0);
      });

      it("should return the underlying amt", async function () {
        expect(await vault.swapPerpsForUnderlying.staticCall(toFixedPtAmt("200"))).to.eq(toFixedPtAmt("200"));
      });

      it("should transfer perps from the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-200")]);
      });

      it("should transfer back underlying to the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("200")]);
      });

      it("should update the vault assets", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("150"), toFixedPtAmt("150"), toFixedPtAmt("150"), toFixedPtAmt("150")],
        );

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1], ...reserveTranches.slice(-3)],
          [
            toFixedPtAmt("1625"),
            toFixedPtAmt("600"),
            toFixedPtAmt("25"),
            toFixedPtAmt("25"),
            toFixedPtAmt("25"),
            toFixedPtAmt("0.000000000000000046"),
          ],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("2300")); // +300 transferred in
      });
    });

    describe("on successful swap with all the juniors in the vault", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        remainingJuniorTranches[1].transfer(vault.target, toFixedPtAmt("800"));
        remainingJuniorTranches[2].transfer(vault.target, toFixedPtAmt("800"));
        remainingJuniorTranches[3].transfer(vault.target, toFixedPtAmt("800"));
        txFn = () => vault.swapPerpsForUnderlying(toFixedPtAmt("200"));
      });

      it("should redeem perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn()).to.emit(perp, "Transfer").withArgs(vault.target, ethers.ZeroAddress, toFixedPtAmt("200"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("600"));
        expect(await perp.balanceOf(vault.target)).to.eq(0);
      });

      it("should return the underlying amt", async function () {
        expect(await vault.swapPerpsForUnderlying.staticCall(toFixedPtAmt("200"))).to.eq(toFixedPtAmt("200"));
      });

      it("should transfer perps from the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-200")]);
      });

      it("should transfer back underlying to the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("200")]);
      });

      it("should update the vault assets", async function () {
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("150"), toFixedPtAmt("150"), toFixedPtAmt("150"), toFixedPtAmt("150")],
        );

        await checkVaultComposition(
          vault,
          [
            collateralToken,
            currentTranchesIn[1],
            remainingJuniorTranches[1],
            remainingJuniorTranches[2],
            remainingJuniorTranches[3],
          ],
          [toFixedPtAmt("2000"), toFixedPtAmt("600"), toFixedPtAmt("600"), toFixedPtAmt("600"), toFixedPtAmt("600")],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("2000")); // + 2400 transferred in
        await txFn();
        expect(await vault.getTVL()).to.eq(toFixedPtAmt("4400"));
      });
    });

    describe("when absolute liquidity is too low", function () {
      beforeEach(async function () {
        await vault.updateLiquidityLimits(toFixedPtAmt("1225"), "0", ethers.MaxUint256);
      });
      it("should be reverted", async function () {
        await expect(vault.swapPerpsForUnderlying(toFixedPtAmt("100"))).to.be.revertedWithCustomError(
          vault,
          "LiquidityOutOfBounds",
        );
        await vault.updateLiquidityLimits(toFixedPtAmt("1200"), "0", ethers.MaxUint256);
        await expect(vault.swapPerpsForUnderlying(toFixedPtAmt("1"))).not.to.be.reverted;
      });
    });

    describe("when liquidity perc is too high", function () {
      beforeEach(async function () {
        await vault.updateLiquidityLimits("0", "0", toPercFixedPtAmt("0.38"));
      });
      it("should be reverted", async function () {
        await expect(vault.swapPerpsForUnderlying(toFixedPtAmt("100"))).to.be.revertedWithCustomError(
          vault,
          "LiquidityOutOfBounds",
        );
        await expect(vault.swapPerpsForUnderlying(toFixedPtAmt("1"))).not.to.be.reverted;
      });
    });
  });
});
