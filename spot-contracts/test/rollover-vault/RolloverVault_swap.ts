import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer, constants, Transaction } from "ethers";
import { smock } from "@defi-wonderland/smock";

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
  checkReserveComposition,
  checkVaultAssetComposition,
  rebase,
} from "../helpers";
use(smock.matchers);

let vault: Contract;
let perp: Contract;
let bondFactory: Contract;
let collateralToken: Contract;
let rebaseOracle: Contract;
let issuer: Contract;
let feePolicy: Contract;
let deployer: Signer;
let reserveTranches: Contract[][] = [];
let remainingJuniorTranches: Contract[][] = [];
let currentBondIn: Contract;
let currentTranchesIn: Contract[];

describe("RolloverVault", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];

    bondFactory = await setupBondFactory();
    ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));

    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await upgrades.deployProxy(
      BondIssuer.connect(deployer),
      [bondFactory.address, collateralToken.address, 4800, [200, 800], 1200, 0],
      {
        initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
      },
    );

    const FeePolicy = await ethers.getContractFactory("FeePolicy");
    feePolicy = await smock.fake(FeePolicy);
    await feePolicy.decimals.returns(8);
    await feePolicy.computePerpMintFeePerc.returns(0);
    await feePolicy.computePerpBurnFeePerc.returns(0);
    await feePolicy.computePerpRolloverFeePerc.returns(0);

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await upgrades.deployProxy(
      PerpetualTranche.connect(deployer),
      ["PerpetualTranche", "PERP", collateralToken.address, issuer.address, feePolicy.address],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );
    await perp.updateTolerableTrancheMaturity(1200, 4800);
    await advancePerpQueueToBondMaturity(perp, await getDepositBond(perp));

    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    vault = await upgrades.deployProxy(RolloverVault.connect(deployer));
    await collateralToken.approve(vault.address, toFixedPtAmt("1"));
    await vault.init("RolloverVault", "VSHARE", perp.address, feePolicy.address);
    await perp.updateVault(vault.address);

    reserveTranches = [];
    remainingJuniorTranches = [];
    for (let i = 0; i < 4; i++) {
      const bond = await getDepositBond(perp);
      const tranches = await getTranches(bond);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);

      await tranches[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

      reserveTranches.push(tranches[0]);
      remainingJuniorTranches.push(tranches[1]);
      await advancePerpQueue(perp, 1200);
    }

    await checkReserveComposition(
      perp,
      [collateralToken, ...reserveTranches.slice(-3)],
      [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
    );
    await checkVaultAssetComposition(vault, [collateralToken], [0]);
    expect(await vault.assetCount()).to.eq(1);

    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
    currentBondIn = await bondAt(await perp.callStatic.getDepositBond());
    currentTranchesIn = await getTranches(currentBondIn);
    await collateralToken.transfer(vault.address, toFixedPtAmt("1000"));
    await vault.deploy();
    await collateralToken.transfer(vault.address, toFixedPtAmt("1000"));

    await checkVaultAssetComposition(
      vault,
      [collateralToken, currentTranchesIn[1]],
      [toFixedPtAmt("1200"), toFixedPtAmt("800")],
    );
    expect(await vault.assetCount()).to.eq(2);

    await collateralToken.approve(vault.address, toFixedPtAmt("10000"));
    await perp.approve(vault.address, toFixedPtAmt("10000"));
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#swapUnderlyingForPerps", function () {
    describe("when fee is zero", function () {
      beforeEach(async function () {
        await feePolicy.computePerpMintFeePerc.returns(0);
        await feePolicy.computeUnderlyingToPerpVaultSwapFeePerc.returns(0);
      });

      describe("when perp price is 1", function () {
        it("should compute swap amount", async function () {
          const s = await vault.callStatic.computeUnderlyingToPerpSwapAmt(toFixedPtAmt("100"));
          expect(s[0]).to.eq(toFixedPtAmt("100"));
          expect(s[1]).to.eq(0);
          expect(s[2].perpTVL).to.eq(toFixedPtAmt("800"));
          expect(s[2].vaultTVL).to.eq(toFixedPtAmt("2000"));
          expect(s[2].seniorTR).to.eq("200");
        });

        it("should update vault after swap", async function () {
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1]],
            [toFixedPtAmt("1200"), toFixedPtAmt("800")],
          );

          await vault.swapUnderlyingForPerps(toFixedPtAmt("100"));

          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1]],
            [toFixedPtAmt("800"), toFixedPtAmt("1200")],
          );
        });
      });

      describe("when perp price > 1", function () {
        beforeEach(async function () {
          await collateralToken.transfer(perp.address, toFixedPtAmt("800"));
        });

        it("should compute swap amount", async function () {
          const s = await vault.callStatic.computeUnderlyingToPerpSwapAmt(toFixedPtAmt("100"));
          expect(s[0]).to.eq(toFixedPtAmt("50"));
          expect(s[1]).to.eq(0);
          expect(s[2].perpTVL).to.eq(toFixedPtAmt("1600"));
          expect(s[2].vaultTVL).to.eq(toFixedPtAmt("2000"));
          expect(s[2].seniorTR).to.eq("200");
        });

        it("should update vault after swap", async function () {
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1]],
            [toFixedPtAmt("1200"), toFixedPtAmt("800")],
          );

          await vault.swapUnderlyingForPerps(toFixedPtAmt("100"));

          await checkVaultAssetComposition(
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
          const s = await vault.callStatic.computeUnderlyingToPerpSwapAmt(toFixedPtAmt("100"));
          expect(s[0]).to.eq(toFixedPtAmt("200"));
          expect(s[1]).to.eq(0);
          expect(s[2].perpTVL).to.eq(toFixedPtAmt("400"));
          expect(s[2].vaultTVL).to.eq(toFixedPtAmt("120"));
          expect(s[2].seniorTR).to.eq("200");
        });
        it("should update vault after swap", async function () {
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1]],
            [toFixedPtAmt("120"), toFixedPtAmt("800")],
          );

          await vault.swapUnderlyingForPerps(toFixedPtAmt("100"));

          await checkVaultAssetComposition(
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
          const s = await vault.callStatic.computeUnderlyingToPerpSwapAmt(toFixedPtAmt("100"));
          expect(s[0]).to.eq(toFixedPtAmt("100"));
          expect(s[1]).to.eq(0);
          expect(s[2].perpTVL).to.eq(toFixedPtAmt("800"));
          expect(s[2].vaultTVL).to.eq(toFixedPtAmt("1780"));
          expect(s[2].seniorTR).to.eq("200");
        });

        it("should update vault after swap", async function () {
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1]],
            [toFixedPtAmt("1080"), toFixedPtAmt("800")],
          );

          await vault.swapUnderlyingForPerps(toFixedPtAmt("100"));

          await checkVaultAssetComposition(
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
          const s = await vault.callStatic.computeUnderlyingToPerpSwapAmt(toFixedPtAmt("100"));
          expect(s[0]).to.eq(toFixedPtAmt("100"));
          expect(s[1]).to.eq(0);
          expect(s[2].perpTVL).to.eq(toFixedPtAmt("800"));
          expect(s[2].vaultTVL).to.eq(toFixedPtAmt("2220"));
          expect(s[2].seniorTR).to.eq("200");
        });

        it("should update vault after swap", async function () {
          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1]],
            [toFixedPtAmt("1320"), toFixedPtAmt("800")],
          );

          await vault.swapUnderlyingForPerps(toFixedPtAmt("100"));

          await checkVaultAssetComposition(
            vault,
            [collateralToken, currentTranchesIn[1]],
            [toFixedPtAmt("870"), toFixedPtAmt("1200")],
          );
        });
      });
    });

    describe("when fee is not zero", function () {
      beforeEach(async function () {
        await feePolicy.computePerpMintFeePerc.returns(toPercFixedPtAmt("0.05"));
        await feePolicy.computeUnderlyingToPerpVaultSwapFeePerc.returns(toPercFixedPtAmt("0.1"));
      });

      it("should compute swap amount", async function () {
        const s = await vault.callStatic.computeUnderlyingToPerpSwapAmt(toFixedPtAmt("100"));
        expect(s[0]).to.eq(toFixedPtAmt("85"));
        expect(s[1]).to.eq(toFixedPtAmt("5"));
        expect(s[2].perpTVL).to.eq(toFixedPtAmt("800"));
        expect(s[2].vaultTVL).to.eq(toFixedPtAmt("2000"));
        expect(s[2].seniorTR).to.eq("200");
      });
    });

    describe("when swap amount is zero", function () {
      it("should be reverted", async function () {
        await expect(vault.swapUnderlyingForPerps(0)).to.be.revertedWithCustomError(vault, "UnacceptableSwap");
      });
    });

    describe("when absolute liquidity is too low", function () {
      beforeEach(async function () {
        await vault.updateMinUnderlyingBal(toFixedPtAmt("1000"));
        await vault.updateMinUnderlyingPerc(0);
      });
      it("should be reverted", async function () {
        await expect(vault.swapUnderlyingForPerps(toFixedPtAmt("50"))).to.be.revertedWithCustomError(
          vault,
          "InsufficientLiquidity",
        );
        await expect(vault.swapUnderlyingForPerps(toFixedPtAmt("1"))).not.to.be.reverted;
      });
    });

    describe("when percentage of liquidity is too low", function () {
      beforeEach(async function () {
        await vault.updateMinUnderlyingBal(0);
        await vault.updateMinUnderlyingPerc(toPercFixedPtAmt("0.40"));
      });
      it("should be reverted", async function () {
        await expect(vault.swapUnderlyingForPerps(toFixedPtAmt("100"))).to.be.revertedWithCustomError(
          vault,
          "InsufficientLiquidity",
        );
        await expect(vault.swapUnderlyingForPerps(toFixedPtAmt("99"))).not.to.be.reverted;
      });
    });

    describe("when fee is 100%", function () {
      it("should be reverted", async function () {
        await feePolicy.computePerpMintFeePerc.returns(0);
        await feePolicy.computeUnderlyingToPerpVaultSwapFeePerc.returns(toPercFixedPtAmt("1"));
        await expect(vault.swapUnderlyingForPerps(toFixedPtAmt("100"))).to.be.revertedWithCustomError(
          vault,
          "UnacceptableSwap",
        );
      });
    });

    describe("when fee is greater than 100%", function () {
      it("should be reverted", async function () {
        await feePolicy.computePerpMintFeePerc.returns(toPercFixedPtAmt("0.05"));
        await feePolicy.computeUnderlyingToPerpVaultSwapFeePerc.returns(toPercFixedPtAmt("1"));
        await expect(vault.swapUnderlyingForPerps(toFixedPtAmt("100"))).to.be.reverted;
      });
    });

    describe("on successful swap with zero fees", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        await feePolicy.computePerpMintFeePerc.returns(0);
        await feePolicy.computeUnderlyingToPerpVaultSwapFeePerc.returns(0);
        txFn = () => vault.swapUnderlyingForPerps(toFixedPtAmt("100"));
      });

      it("should mint perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(constants.AddressZero, vault.address, toFixedPtAmt("100"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("900"));
        expect(await perp.balanceOf(vault.address)).to.eq(0);
      });

      it("should return the perp amt", async function () {
        expect(await vault.callStatic.swapUnderlyingForPerps(toFixedPtAmt("100"))).to.eq(toFixedPtAmt("100"));
      });

      it("should transfer underlying from the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("-100")]);
      });

      it("should transfer back perps to the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("100")]);
      });

      it("should update the vault assets", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("300")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("800"), toFixedPtAmt("1200")],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2000"));
      });
    });

    describe("on successful swap with zero perp fees", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        await feePolicy.computePerpMintFeePerc.returns(0);
        await feePolicy.computeUnderlyingToPerpVaultSwapFeePerc.returns(toPercFixedPtAmt("0.1"));
        txFn = () => vault.swapUnderlyingForPerps(toFixedPtAmt("100"));
      });

      it("should mint perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(constants.AddressZero, vault.address, toFixedPtAmt("90"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("890"));
        expect(await perp.balanceOf(vault.address)).to.eq(0);
      });

      it("should return the perp amt", async function () {
        expect(await vault.callStatic.swapUnderlyingForPerps(toFixedPtAmt("100"))).to.eq(toFixedPtAmt("90"));
      });

      it("should transfer underlying from the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("-100")]);
      });

      it("should transfer back perps to the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("90")]);
      });

      it("should update the vault assets", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("290")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("850"), toFixedPtAmt("1160")],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2010"));
      });
    });

    describe("on successful swap", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        await feePolicy.computePerpMintFeePerc.returns(toPercFixedPtAmt("0.05"));
        await feePolicy.computeUnderlyingToPerpVaultSwapFeePerc.returns(toPercFixedPtAmt("0.1"));
        txFn = () => vault.swapUnderlyingForPerps(toFixedPtAmt("100"));
      });

      it("should mint perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(constants.AddressZero, vault.address, toFixedPtAmt("90"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("885"));
        expect(await perp.balanceOf(vault.address)).to.eq(0);
      });

      it("should burn perps as fee", async function () {
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.address, constants.AddressZero, toFixedPtAmt("5"));
      });

      it("should return the perp amt", async function () {
        expect(await vault.callStatic.swapUnderlyingForPerps(toFixedPtAmt("100"))).to.eq(toFixedPtAmt("85"));
      });

      it("should transfer underlying from the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("-100")]);
      });

      it("should transfer back perps to the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("85")]);
      });

      it("should update the vault assets", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("290")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("850"), toFixedPtAmt("1160")],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2010"));
      });
    });

    describe("on successful swap with imperfect rounding", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        await feePolicy.computePerpMintFeePerc.returns(toPercFixedPtAmt("0.1"));
        await feePolicy.computeUnderlyingToPerpVaultSwapFeePerc.returns(toPercFixedPtAmt("0.1"));
        txFn = () => vault.swapUnderlyingForPerps(toFixedPtAmt("100.999999999999999999"));
      });

      it("should mint perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(constants.AddressZero, vault.address, toFixedPtAmt("90.899999999999999999"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("880.799999999999999999"));
        expect(await perp.balanceOf(vault.address)).to.eq(0);
      });

      it("should burn perps as fee", async function () {
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.address, constants.AddressZero, toFixedPtAmt("10.1"));
      });

      it("should return the perp amt", async function () {
        expect(await vault.callStatic.swapUnderlyingForPerps(toFixedPtAmt("100.999999999999999999"))).to.eq(
          toFixedPtAmt("80.799999999999999999"),
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
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("80.799999999999999999")]);
      });

      it("should update the vault assets", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("290.899999999999999999")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("846.500000000000000004"), toFixedPtAmt("1163.599999999999999996")],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2010.10"));
      });
    });

    describe("on successful swap when deposit bond is fresh", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        await advancePerpQueueToBondMaturity(perp, await getDepositBond(perp));
        await feePolicy.computePerpMintFeePerc.returns(toPercFixedPtAmt("0.05"));
        await feePolicy.computeUnderlyingToPerpVaultSwapFeePerc.returns(toPercFixedPtAmt("0.1"));
        txFn = () => vault.swapUnderlyingForPerps(toFixedPtAmt("100"));
      });

      it("should mint perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(constants.AddressZero, vault.address, toFixedPtAmt("90"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("885"));
        expect(await perp.balanceOf(vault.address)).to.eq(0);
      });

      it("should burn perps as fee", async function () {
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.address, constants.AddressZero, toFixedPtAmt("5"));
      });

      it("should return the perp amt", async function () {
        expect(await vault.callStatic.swapUnderlyingForPerps(toFixedPtAmt("100"))).to.eq(toFixedPtAmt("85"));
      });

      it("should transfer underlying from the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("-100")]);
      });

      it("should transfer back perps to the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("85")]);
      });

      it("should update the vault assets", async function () {
        const depositBond = await bondAt(perp.callStatic.getDepositBond());
        const depositTranches = await getTranches(depositBond);
        await checkReserveComposition(perp, [collateralToken], [toFixedPtAmt("800")]);

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkReserveComposition(
          perp,
          [collateralToken, depositTranches[0]],
          [toFixedPtAmt("800"), toFixedPtAmt("90")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], depositTranches[1]],
          [toFixedPtAmt("850"), toFixedPtAmt("800"), toFixedPtAmt("360")],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2010"));
      });
    });
  });

  describe("#swapPerpsForUnderlying", function () {
    describe("when fee is zero", function () {
      beforeEach(async function () {
        await feePolicy.computePerpBurnFeePerc.returns(0);
        await feePolicy.computePerpToUnderlyingVaultSwapFeePerc.returns(0);
      });

      describe("when perp price is 1", function () {
        it("should compute swap amount", async function () {
          const s = await vault.callStatic.computePerpToUnderlyingSwapAmt(toFixedPtAmt("100"));
          expect(s[0]).to.eq(toFixedPtAmt("100"));
          expect(s[1]).to.eq(0);
          expect(s[2].perpTVL).to.eq(toFixedPtAmt("800"));
          expect(s[2].vaultTVL).to.eq(toFixedPtAmt("2000"));
          expect(s[2].seniorTR).to.eq("200");
        });
      });

      describe("when perp price > 1", function () {
        beforeEach(async function () {
          await collateralToken.transfer(perp.address, toFixedPtAmt("800"));
        });
        it("should compute swap amount", async function () {
          const s = await vault.callStatic.computePerpToUnderlyingSwapAmt(toFixedPtAmt("100"));
          expect(s[0]).to.eq(toFixedPtAmt("200"));
          expect(s[1]).to.eq(0);
          expect(s[2].perpTVL).to.eq(toFixedPtAmt("1600"));
          expect(s[2].vaultTVL).to.eq(toFixedPtAmt("2000"));
          expect(s[2].seniorTR).to.eq("200");
        });
      });

      describe("when perp price < 1", function () {
        beforeEach(async function () {
          await rebase(collateralToken, rebaseOracle, -0.9);
        });
        it("should compute swap amount", async function () {
          const s = await vault.callStatic.computePerpToUnderlyingSwapAmt(toFixedPtAmt("100"));
          expect(s[0]).to.eq(toFixedPtAmt("50"));
          expect(s[1]).to.eq(0);
          expect(s[2].perpTVL).to.eq(toFixedPtAmt("400"));
          expect(s[2].vaultTVL).to.eq(toFixedPtAmt("120"));
          expect(s[2].seniorTR).to.eq("200");
        });
      });
    });

    describe("when fee is not zero", function () {
      beforeEach(async function () {
        await feePolicy.computePerpBurnFeePerc.returns(toPercFixedPtAmt("0.05"));
        await feePolicy.computePerpToUnderlyingVaultSwapFeePerc.returns(toPercFixedPtAmt("0.15"));
      });

      it("should compute swap amount", async function () {
        const s = await vault.callStatic.computePerpToUnderlyingSwapAmt(toFixedPtAmt("100"));
        expect(s[0]).to.eq(toFixedPtAmt("80"));
        expect(s[1]).to.eq(toFixedPtAmt("5"));
        expect(s[2].perpTVL).to.eq(toFixedPtAmt("800"));
        expect(s[2].vaultTVL).to.eq(toFixedPtAmt("2000"));
        expect(s[2].seniorTR).to.eq("200");
      });
    });

    describe("when swap amount is zero", function () {
      it("should be reverted", async function () {
        await expect(vault.swapPerpsForUnderlying(0)).to.be.revertedWithCustomError(vault, "UnacceptableSwap");
      });
    });

    describe("when fee is 100%", function () {
      it("should be reverted", async function () {
        await feePolicy.computePerpBurnFeePerc.returns(0);
        await feePolicy.computePerpToUnderlyingVaultSwapFeePerc.returns(toPercFixedPtAmt("1"));
        await expect(vault.swapPerpsForUnderlying(toFixedPtAmt("100"))).to.be.revertedWithCustomError(
          vault,
          "UnacceptableSwap",
        );
      });
    });

    describe("when fee is greater than 100%", function () {
      it("should be reverted", async function () {
        await feePolicy.computePerpBurnFeePerc.returns(toPercFixedPtAmt("0.05"));
        await feePolicy.computePerpToUnderlyingVaultSwapFeePerc.returns(toPercFixedPtAmt("1"));
        await expect(vault.swapPerpsForUnderlying(toFixedPtAmt("100"))).to.be.reverted;
      });
    });

    describe("on successful swap with zero fees", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        await feePolicy.computePerpBurnFeePerc.returns(0);
        await feePolicy.computePerpToUnderlyingVaultSwapFeePerc.returns(0);
        txFn = () => vault.swapPerpsForUnderlying(toFixedPtAmt("100"));
      });

      it("should redeem perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.address, constants.AddressZero, toFixedPtAmt("100"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("700"));
        expect(await perp.balanceOf(vault.address)).to.eq(0);
      });

      it("should return the underlying amt", async function () {
        expect(await vault.callStatic.swapPerpsForUnderlying(toFixedPtAmt("100"))).to.eq(toFixedPtAmt("100"));
      });

      it("should transfer perps from the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-100")]);
      });

      it("should transfer back underlying to the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("100")]);
      });

      it("should update the vault assets", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("175"), toFixedPtAmt("175"), toFixedPtAmt("175"), toFixedPtAmt("175")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], ...reserveTranches.slice(-3)],
          [toFixedPtAmt("1225"), toFixedPtAmt("700"), toFixedPtAmt("25"), toFixedPtAmt("25"), toFixedPtAmt("25")],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2000"));
      });
    });

    describe("on successful swap with zero perp fees", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        await feePolicy.computePerpBurnFeePerc.returns(0);
        await feePolicy.computePerpToUnderlyingVaultSwapFeePerc.returns(toPercFixedPtAmt("0.1"));
        txFn = () => vault.swapPerpsForUnderlying(toFixedPtAmt("100"));
      });

      it("should redeem perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.address, constants.AddressZero, toFixedPtAmt("100"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("700"));
        expect(await perp.balanceOf(vault.address)).to.eq(0);
      });

      it("should return the underlying amt", async function () {
        expect(await vault.callStatic.swapPerpsForUnderlying(toFixedPtAmt("100"))).to.eq(toFixedPtAmt("90"));
      });

      it("should transfer perps from the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-100")]);
      });

      it("should transfer back underlying to the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("90")]);
      });

      it("should update the vault assets", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("175"), toFixedPtAmt("175"), toFixedPtAmt("175"), toFixedPtAmt("175")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], ...reserveTranches.slice(-3)],
          [toFixedPtAmt("1235"), toFixedPtAmt("700"), toFixedPtAmt("25"), toFixedPtAmt("25"), toFixedPtAmt("25")],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2010"));
      });
    });

    describe("on successful swap", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        await feePolicy.computePerpBurnFeePerc.returns(toPercFixedPtAmt("0.1"));
        await feePolicy.computePerpToUnderlyingVaultSwapFeePerc.returns(toPercFixedPtAmt("0.15"));
        txFn = () => vault.swapPerpsForUnderlying(toFixedPtAmt("100"));
      });

      it("should redeem perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.address, constants.AddressZero, toFixedPtAmt("90"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("700"));
        expect(await perp.balanceOf(vault.address)).to.eq(0);
      });

      it("should burn perps as fee", async function () {
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.address, constants.AddressZero, toFixedPtAmt("10"));
      });

      it("should return the underlying amt", async function () {
        expect(await vault.callStatic.swapPerpsForUnderlying(toFixedPtAmt("100"))).to.eq(toFixedPtAmt("75"));
      });

      it("should transfer perps from the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-100")]);
      });

      it("should transfer back underlying to the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("75")]);
      });

      it("should update the vault assets", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            0,
            toFixedPtAmt("177.215189873417721519"),
            toFixedPtAmt("177.215189873417721519"),
            toFixedPtAmt("177.215189873417721519"),
            toFixedPtAmt("177.215189873417721519"),
          ],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            toFixedPtAmt("1238.924050632911392"),
            toFixedPtAmt("708.8607594936708864"),
            toFixedPtAmt("22.784810126582278481"),
            toFixedPtAmt("22.784810126582278481"),
            toFixedPtAmt("22.784810126582278481"),
            toFixedPtAmt("0.000000000000000081"),
          ],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2016.139240506329113843"));
      });
    });

    describe("on successful swap with imperfect rounding", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        await feePolicy.computePerpBurnFeePerc.returns(toPercFixedPtAmt("0.1"));
        await feePolicy.computePerpToUnderlyingVaultSwapFeePerc.returns(toPercFixedPtAmt("0.1"));
        txFn = () => vault.swapPerpsForUnderlying(toFixedPtAmt("100.999999999999999999"));
      });

      it("should redeem perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.address, constants.AddressZero, toFixedPtAmt("90.899999999999999999"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("699.000000000000000001"));
        expect(await perp.balanceOf(vault.address)).to.eq(0);
      });

      it("should burn perps as fee", async function () {
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.address, constants.AddressZero, toFixedPtAmt("10.1"));
      });

      it("should return the underlying amt", async function () {
        expect(await vault.callStatic.swapPerpsForUnderlying(toFixedPtAmt("100.999999999999999999"))).to.eq(
          toFixedPtAmt("80.799999999999999999"),
        );
      });

      it("should transfer perps from the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-100.999999999999999999")]);
      });

      it("should transfer back underlying to the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("80.799999999999999999")]);
      });

      it("should update the vault assets", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            0,
            toFixedPtAmt("176.984428408659323966"),
            toFixedPtAmt("176.984428408659323966"),
            toFixedPtAmt("176.984428408659323966"),
            toFixedPtAmt("176.984428408659323966"),
          ],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            toFixedPtAmt("1234.277857956703380001"),
            toFixedPtAmt("707.937713634637296000"),
            toFixedPtAmt("23.015571591340676034"),
            toFixedPtAmt("23.015571591340676034"),
            toFixedPtAmt("23.015571591340676034"),
            toFixedPtAmt("0.000000000000000034"),
          ],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2011.262286365362704103"));
      });
    });

    describe("on successful swap with some the juniors in the vault", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        await feePolicy.computePerpBurnFeePerc.returns(toPercFixedPtAmt("0.1"));
        await feePolicy.computePerpToUnderlyingVaultSwapFeePerc.returns(toPercFixedPtAmt("0.15"));
        remainingJuniorTranches[1].transfer(vault.address, toFixedPtAmt("100"));
        remainingJuniorTranches[2].transfer(vault.address, toFixedPtAmt("100"));
        remainingJuniorTranches[3].transfer(vault.address, toFixedPtAmt("100"));
        txFn = () => vault.swapPerpsForUnderlying(toFixedPtAmt("200"));
      });

      it("should redeem perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.address, constants.AddressZero, toFixedPtAmt("180"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("600"));
        expect(await perp.balanceOf(vault.address)).to.eq(0);
      });

      it("should burn perps as fee", async function () {
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.address, constants.AddressZero, toFixedPtAmt("20"));
      });

      it("should return the underlying amt", async function () {
        expect(await vault.callStatic.swapPerpsForUnderlying(toFixedPtAmt("200"))).to.eq(toFixedPtAmt("150"));
      });

      it("should transfer perps from the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-200")]);
      });

      it("should transfer back underlying to the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("150")]);
      });

      it("should update the vault assets", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            0,
            toFixedPtAmt("153.846153846153846154"),
            toFixedPtAmt("153.846153846153846154"),
            toFixedPtAmt("153.846153846153846154"),
            toFixedPtAmt("153.846153846153846154"),
          ],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1], ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            toFixedPtAmt("1655.769230769230769000"),
            toFixedPtAmt("615.384615384615384800"),
            toFixedPtAmt("21.153846153846153846"),
            toFixedPtAmt("21.153846153846153846"),
            toFixedPtAmt("21.153846153846153846"),
            toFixedPtAmt("0.000000000000000046"),
          ],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2000"));
        await txFn();
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2334.615384615384615338"));
      });
    });

    describe("on successful swap with all the juniors in the vault", function () {
      let txFn: Promise<Transaction>;
      beforeEach(async function () {
        await feePolicy.computePerpBurnFeePerc.returns(toPercFixedPtAmt("0.1"));
        await feePolicy.computePerpToUnderlyingVaultSwapFeePerc.returns(toPercFixedPtAmt("0.15"));

        remainingJuniorTranches[1].transfer(vault.address, toFixedPtAmt("800"));
        remainingJuniorTranches[2].transfer(vault.address, toFixedPtAmt("800"));
        remainingJuniorTranches[3].transfer(vault.address, toFixedPtAmt("800"));

        txFn = () => vault.swapPerpsForUnderlying(toFixedPtAmt("200"));
      });

      it("should redeem perps for swap and leave none left over", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("800"));
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.address, constants.AddressZero, toFixedPtAmt("180"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("600"));
        expect(await perp.balanceOf(vault.address)).to.eq(0);
      });

      it("should burn perps as fee", async function () {
        await expect(txFn())
          .to.emit(perp, "Transfer")
          .withArgs(vault.address, constants.AddressZero, toFixedPtAmt("20"));
      });

      it("should return the underlying amt", async function () {
        expect(await vault.callStatic.swapPerpsForUnderlying(toFixedPtAmt("200"))).to.eq(toFixedPtAmt("150"));
      });

      it("should transfer perps from the user", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-200")]);
      });

      it("should transfer back underlying to the user", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer], [toFixedPtAmt("150")]);
      });

      it("should update the vault assets", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [0, toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
        );

        await checkVaultAssetComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1200"), toFixedPtAmt("800")],
        );

        await txFn();

        await checkReserveComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            0,
            toFixedPtAmt("153.846153846153846154"),
            toFixedPtAmt("153.846153846153846154"),
            toFixedPtAmt("153.846153846153846154"),
            toFixedPtAmt("153.846153846153846154"),
          ],
        );

        await checkVaultAssetComposition(
          vault,
          [
            collateralToken,
            currentTranchesIn[1],
            remainingJuniorTranches[1],
            remainingJuniorTranches[2],
            remainingJuniorTranches[3],
            ...reserveTranches.slice(-3),
            currentTranchesIn[0],
          ],
          [
            toFixedPtAmt("1973.076923076923076"),
            toFixedPtAmt("615.3846153846153848"),
            toFixedPtAmt("615.3846153846153848"),
            toFixedPtAmt("615.3846153846153848"),
            toFixedPtAmt("615.3846153846153848"),
            toFixedPtAmt("0.000000000000000046"),
            toFixedPtAmt("0.000000000000000046"),
            toFixedPtAmt("0.000000000000000046"),
            toFixedPtAmt("0.000000000000000046"),
          ],
        );
      });

      it("should update the vault tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2000")); // + 2400 transferred in
        await txFn();
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("4434.6153846153846152"));
      });
    });

    describe("when vault reduces underlying liquidity", function () {
      it("should be reverted", async function () {
        await feePolicy.computePerpBurnFeePerc.returns(toPercFixedPtAmt("0.1"));
        await feePolicy.computePerpToUnderlyingVaultSwapFeePerc.returns(toPercFixedPtAmt("0.15"));
        await vault.swapPerpsForUnderlying(toFixedPtAmt("800"));

        const bond = await getDepositBond(perp);
        const tranches = await getTranches(bond);
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));
        await expect(vault.swapPerpsForUnderlying(toFixedPtAmt("1"))).to.be.revertedWithCustomError(
          vault,
          "InsufficientLiquidity",
        );
      });
    });
  });
});
