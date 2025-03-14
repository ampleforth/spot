import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";

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
  DMock,
} from "../helpers";

let vault: Contract;
let perp: Contract;
let bondFactory: Contract;
let collateralToken: Contract;
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
    ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));

    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await upgrades.deployProxy(
      BondIssuer.connect(deployer),
      [bondFactory.target, collateralToken.target, 4800, [200, 800], 1200, 0],
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

    await feePolicy.mockMethod("computeVaultMintFeePerc()", [0]);
    await feePolicy.mockMethod("computeVaultBurnFeePerc()", [0]);
    await feePolicy.mockMethod("computeUnderlyingToPerpVaultSwapFeePerc(uint256,uint256)", [0]);
    await feePolicy.mockMethod("computePerpToUnderlyingVaultSwapFeePerc(uint256,uint256)", [0]);

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await upgrades.deployProxy(
      PerpetualTranche.connect(deployer),
      ["PerpetualTranche", "PERP", collateralToken.target, issuer.target, feePolicy.target],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );
    await perp.updateTolerableTrancheMaturity(1200, 4800);
    await advancePerpQueueToBondMaturity(perp, await getDepositBond(perp));

    const TrancheManager = await ethers.getContractFactory("TrancheManager");
    const trancheManager = await TrancheManager.deploy();
    const RolloverVault = await ethers.getContractFactory("RolloverVault", {
      libraries: {
        TrancheManager: trancheManager.target,
      },
    });
    await upgrades.silenceWarnings();
    vault = await upgrades.deployProxy(RolloverVault.connect(deployer), {
      unsafeAllow: ["external-library-linking"],
    });
    await collateralToken.approve(vault.target, toFixedPtAmt("1"));
    await vault.init("RolloverVault", "VSHARE", perp.target, feePolicy.target);
    await perp.updateVault(vault.target);

    reserveTranches = [];
    remainingJuniorTranches = [];
    for (let i = 0; i < 4; i++) {
      const bond = await getDepositBond(perp);
      const tranches = await getTranches(bond);
      await depositIntoBond(bond, toFixedPtAmt("1200"), deployer);

      await tranches[0].approve(perp.target, toFixedPtAmt("200"));
      await perp.deposit(tranches[0].target, toFixedPtAmt("200"));

      reserveTranches.push(tranches[0]);
      remainingJuniorTranches.push(tranches[1]);
      await advancePerpQueue(perp, 1200);
    }

    await checkPerpComposition(
      perp,
      [collateralToken, ...reserveTranches.slice(-3)],
      [toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
    );
    await checkVaultComposition(vault, [collateralToken], [0]);
    expect(await vault.assetCount()).to.eq(1);

    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
    currentBondIn = await bondAt(await perp.getDepositBond.staticCall());
    currentTranchesIn = await getTranches(currentBondIn);

    await collateralToken.approve(vault.target, toFixedPtAmt("10000"));
    await perp.approve(vault.target, toFixedPtAmt("10000"));

    await vault.deposit(toFixedPtAmt("1000"));
    await vault.deploy();
    await vault.deposit(toFixedPtAmt("1000"));

    await checkVaultComposition(
      vault,
      [collateralToken, currentTranchesIn[1]],
      [toFixedPtAmt("1200"), toFixedPtAmt("800")],
    );
    expect(await vault.assetCount()).to.eq(2);
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#mint2", function () {
    describe("when dr = 1", function () {
      beforeEach(async function () {
        await feePolicy.mockMethod("computeNeutralSplit(uint256,uint256)", [toFixedPtAmt("25"), toFixedPtAmt("75")]);
      });

      it("should compute amounts", async function () {
        const r = await vault.mint2.staticCall(toFixedPtAmt("100"));
        expect(r[0]).to.eq(toFixedPtAmt("25"));
        expect(r[1]).to.eq(toFixedPtAmt("75") * 1000000n);
      });

      it("should transfer underlying", async function () {
        await expect(() => vault.mint2(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("-100")],
        );
      });

      it("should mint perps", async function () {
        await expect(() => vault.mint2(toFixedPtAmt("100"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("25")],
        );
      });

      it("should mint vault notes", async function () {
        await expect(() => vault.mint2(toFixedPtAmt("100"))).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("75") * 1000000n],
        );
      });

      it("should increase tvl", async function () {
        await vault.mint2(toFixedPtAmt("100"));
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("2075"));
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("825"));
      });

      it("should have the updated composition", async function () {
        await vault.mint2(toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [toFixedPtAmt("0"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("225")],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1175"), toFixedPtAmt("900")],
        );
      });

      it("should sync vault assets", async function () {
        const tx = vault.mint2(toFixedPtAmt("100"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("1175"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].target, toFixedPtAmt("900"));
      });
    });

    describe("when dr > 1", function () {
      beforeEach(async function () {
        await feePolicy.mockMethod("computeNeutralSplit(uint256,uint256)", [toFixedPtAmt("25"), toFixedPtAmt("75")]);
        await feePolicy.mockMethod("computeDeviationRatio((uint256,uint256,uint256))", [toPercFixedPtAmt("1.25")]);
        await vault.deposit(toFixedPtAmt("1000"));
      });

      it("should compute amounts", async function () {
        const r = await vault.mint2.staticCall(toFixedPtAmt("100"));
        expect(r[0]).to.eq(toFixedPtAmt("25"));
        expect(r[1]).to.eq(toFixedPtAmt("75") * 1000000n);
      });

      it("should transfer underlying", async function () {
        await expect(() => vault.mint2(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("-100")],
        );
      });

      it("should mint perps", async function () {
        await expect(() => vault.mint2(toFixedPtAmt("100"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("25")],
        );
      });

      it("should mint vault notes", async function () {
        await expect(() => vault.mint2(toFixedPtAmt("100"))).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("75") * 1000000n],
        );
      });

      it("should increase tvl", async function () {
        await vault.mint2(toFixedPtAmt("100"));
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("3075"));
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("825"));
      });

      it("should have the updated composition", async function () {
        await vault.mint2(toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [toFixedPtAmt("0"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("225")],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("2175"), toFixedPtAmt("900")],
        );
      });

      it("should sync vault assets", async function () {
        const tx = vault.mint2(toFixedPtAmt("100"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("2175"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].target, toFixedPtAmt("900"));
      });
    });

    describe("when dr < 1", function () {
      beforeEach(async function () {
        await feePolicy.mockMethod("computeNeutralSplit(uint256,uint256)", [toFixedPtAmt("25"), toFixedPtAmt("75")]);
        await feePolicy.mockMethod("computeDeviationRatio((uint256,uint256,uint256))", [toPercFixedPtAmt("0.75")]);
        await vault.redeem(toFixedPtAmt("500") * 1000000n);
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("1500"));
      });

      it("should compute amounts", async function () {
        const r = await vault.mint2.staticCall(toFixedPtAmt("100"));
        expect(r[0]).to.eq(toFixedPtAmt("25"));
        expect(r[1]).to.eq(toFixedPtAmt("75") * 1000000n);
      });

      it("should transfer underlying", async function () {
        await expect(() => vault.mint2(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [deployer],
          [toFixedPtAmt("-100")],
        );
      });

      it("should mint perps", async function () {
        await expect(() => vault.mint2(toFixedPtAmt("100"))).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("25")],
        );
      });

      it("should mint vault notes", async function () {
        await expect(() => vault.mint2(toFixedPtAmt("100"))).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("75") * 1000000n],
        );
      });

      it("should increase tvl", async function () {
        await vault.mint2(toFixedPtAmt("100"));
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("1575"));
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("825"));
      });

      it("should have the updated composition", async function () {
        await vault.mint2(toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [toFixedPtAmt("0"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("225")],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("875"), toFixedPtAmt("700")],
        );
      });

      it("should sync vault assets", async function () {
        const tx = vault.mint2(toFixedPtAmt("100"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("875"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].target, toFixedPtAmt("700"));
      });
    });
  });

  describe("#redeem2", function () {
    describe("when redeeming proportionally", function () {
      beforeEach(async function () {
        await feePolicy.mockMethod("computeProportionalSplit(uint256,uint256,uint256,uint256)", [
          toFixedPtAmt("25"),
          toFixedPtAmt("75") * 1000000n,
        ]);
      });

      it("should compute amounts", async function () {
        const r = await vault.redeem2.staticCall(toFixedPtAmt("25"), toFixedPtAmt("75") * 1000000n);

        expect(r[0]).to.eq(toFixedPtAmt("25"));
        expect(r[1]).to.eq(toFixedPtAmt("75") * 1000000n);

        expect(r[2][0][0]).to.eq(collateralToken.target);
        expect(r[2][0][1]).to.eq(toFixedPtAmt("45"));

        expect(r[2][1][0]).to.eq(reserveTranches[3].target);
        expect(r[2][1][1]).to.eq(toFixedPtAmt("6.25"));

        expect(r[2][2][0]).to.eq(reserveTranches[1].target);
        expect(r[2][2][1]).to.eq(toFixedPtAmt("6.25"));

        expect(r[2][3][0]).to.eq(reserveTranches[2].target);
        expect(r[2][3][1]).to.eq(toFixedPtAmt("6.25"));

        expect(r[2][4][0]).to.eq(currentTranchesIn[0].target);
        expect(r[2][4][1]).to.eq(toFixedPtAmt("6.25"));

        expect(r[2][5][0]).to.eq(currentTranchesIn[1].target);
        expect(r[2][5][1]).to.eq(toFixedPtAmt("30"));
      });

      it("should burn perps", async function () {
        await expect(() => vault.redeem2(toFixedPtAmt("25"), toFixedPtAmt("75") * 1000000n)).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("-25")],
        );
      });

      it("should burn vault notes", async function () {
        await expect(() => vault.redeem2(toFixedPtAmt("25"), toFixedPtAmt("75") * 1000000n)).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("-75") * 1000000n],
        );
      });

      it("should decrease tvl", async function () {
        await vault.redeem2(toFixedPtAmt("25"), toFixedPtAmt("75") * 1000000n);
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("1925"));
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("775"));
      });

      it("should have the updated composition", async function () {
        await vault.redeem2(toFixedPtAmt("25"), toFixedPtAmt("75") * 1000000n);
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            toFixedPtAmt("0"),
            toFixedPtAmt("193.75"),
            toFixedPtAmt("193.75"),
            toFixedPtAmt("193.75"),
            toFixedPtAmt("193.75"),
          ],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1155"), toFixedPtAmt("770")],
        );
      });

      it("should sync vault assets", async function () {
        const tx = vault.redeem2(toFixedPtAmt("25"), toFixedPtAmt("75") * 1000000n);
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("1155"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].target, toFixedPtAmt("770"));
      });
    });

    describe("when redeeming more perps", function () {
      beforeEach(async function () {
        await feePolicy.mockMethod("computeProportionalSplit(uint256,uint256,uint256,uint256)", [
          toFixedPtAmt("50"),
          toFixedPtAmt("75") * 1000000n,
        ]);
        await collateralToken.transfer(perp.target, toFixedPtAmt("100"));
      });

      it("should compute amounts", async function () {
        const r = await vault.redeem2.staticCall(toFixedPtAmt("100"), toFixedPtAmt("75") * 1000000n);

        expect(r[0]).to.eq(toFixedPtAmt("50"));
        expect(r[1]).to.eq(toFixedPtAmt("75") * 1000000n);

        expect(r[2][0][0]).to.eq(collateralToken.target);
        expect(r[2][0][1]).to.eq(toFixedPtAmt("51.25"));

        expect(r[2][1][0]).to.eq(reserveTranches[3].target);
        expect(r[2][1][1]).to.eq(toFixedPtAmt("12.5"));

        expect(r[2][2][0]).to.eq(reserveTranches[1].target);
        expect(r[2][2][1]).to.eq(toFixedPtAmt("12.5"));

        expect(r[2][3][0]).to.eq(reserveTranches[2].target);
        expect(r[2][3][1]).to.eq(toFixedPtAmt("12.5"));

        expect(r[2][4][0]).to.eq(currentTranchesIn[0].target);
        expect(r[2][4][1]).to.eq(toFixedPtAmt("12.5"));

        expect(r[2][5][0]).to.eq(currentTranchesIn[1].target);
        expect(r[2][5][1]).to.eq(toFixedPtAmt("30"));
      });

      it("should burn perps", async function () {
        await expect(() => vault.redeem2(toFixedPtAmt("100"), toFixedPtAmt("75") * 1000000n)).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("-50")],
        );
      });

      it("should burn vault notes", async function () {
        await expect(() => vault.redeem2(toFixedPtAmt("100"), toFixedPtAmt("75") * 1000000n)).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("-75") * 1000000n],
        );
      });

      it("should decrease tvl", async function () {
        await vault.redeem2(toFixedPtAmt("100"), toFixedPtAmt("75") * 1000000n);
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("1925"));
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("843.75"));
      });

      it("should have the updated composition", async function () {
        await vault.redeem2(toFixedPtAmt("100"), toFixedPtAmt("75") * 1000000n);
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            toFixedPtAmt("93.75"),
            toFixedPtAmt("187.5"),
            toFixedPtAmt("187.5"),
            toFixedPtAmt("187.5"),
            toFixedPtAmt("187.5"),
          ],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1155"), toFixedPtAmt("770")],
        );
      });

      it("should sync vault assets", async function () {
        const tx = vault.redeem2(toFixedPtAmt("100"), toFixedPtAmt("75") * 1000000n);
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("1155"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].target, toFixedPtAmt("770"));
      });
    });

    describe("when redeeming more vault notes", function () {
      beforeEach(async function () {
        await feePolicy.mockMethod("computeProportionalSplit(uint256,uint256,uint256,uint256)", [
          toFixedPtAmt("25"),
          toFixedPtAmt("150") * 1000000n,
        ]);
      });

      it("should compute amounts", async function () {
        const r = await vault.redeem2.staticCall(toFixedPtAmt("25"), toFixedPtAmt("250") * 1000000n);

        expect(r[0]).to.eq(toFixedPtAmt("25"));
        expect(r[1]).to.eq(toFixedPtAmt("150") * 1000000n);

        expect(r[2][0][0]).to.eq(collateralToken.target);
        expect(r[2][0][1]).to.eq(toFixedPtAmt("90"));

        expect(r[2][1][0]).to.eq(reserveTranches[3].target);
        expect(r[2][1][1]).to.eq(toFixedPtAmt("6.25"));

        expect(r[2][2][0]).to.eq(reserveTranches[1].target);
        expect(r[2][2][1]).to.eq(toFixedPtAmt("6.25"));

        expect(r[2][3][0]).to.eq(reserveTranches[2].target);
        expect(r[2][3][1]).to.eq(toFixedPtAmt("6.25"));

        expect(r[2][4][0]).to.eq(currentTranchesIn[0].target);
        expect(r[2][4][1]).to.eq(toFixedPtAmt("6.25"));

        expect(r[2][5][0]).to.eq(currentTranchesIn[1].target);
        expect(r[2][5][1]).to.eq(toFixedPtAmt("60"));
      });

      it("should burn perps", async function () {
        await expect(() => vault.redeem2(toFixedPtAmt("25"), toFixedPtAmt("250") * 1000000n)).to.changeTokenBalances(
          perp,
          [deployer],
          [toFixedPtAmt("-25")],
        );
      });

      it("should burn vault notes", async function () {
        await expect(() => vault.redeem2(toFixedPtAmt("25"), toFixedPtAmt("250") * 1000000n)).to.changeTokenBalances(
          vault,
          [deployer],
          [toFixedPtAmt("-150") * 1000000n],
        );
      });

      it("should decrease tvl", async function () {
        await vault.redeem2(toFixedPtAmt("25"), toFixedPtAmt("250") * 1000000n);
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("1850"));
        expect(await perp.getTVL.staticCall()).to.eq(toFixedPtAmt("775"));
      });

      it("should have the updated composition", async function () {
        await vault.redeem2(toFixedPtAmt("25"), toFixedPtAmt("250") * 1000000n);
        await checkPerpComposition(
          perp,
          [collateralToken, ...reserveTranches.slice(-3), currentTranchesIn[0]],
          [
            toFixedPtAmt("0"),
            toFixedPtAmt("193.75"),
            toFixedPtAmt("193.75"),
            toFixedPtAmt("193.75"),
            toFixedPtAmt("193.75"),
          ],
        );
        await checkVaultComposition(
          vault,
          [collateralToken, currentTranchesIn[1]],
          [toFixedPtAmt("1110"), toFixedPtAmt("740")],
        );
      });

      it("should sync vault assets", async function () {
        const tx = vault.redeem2(toFixedPtAmt("25"), toFixedPtAmt("250") * 1000000n);
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.target, toFixedPtAmt("1110"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(currentTranchesIn[1].target, toFixedPtAmt("740"));
      });
    });
  });
});
