import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer, BigNumber } from "ethers";

import {
  setupCollateralToken,
  mintCollteralToken,
  setupBondFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  getDepositBond,
  advancePerpQueue,
  advancePerpQueueToBondMaturity,
  checkPerpComposition,
  checkVaultComposition,
  rebase,
  toPercFixedPtAmt,
  DMock,
} from "../helpers";

let deployer: Signer;
let deployerAddress: string;
let otherUser: Signer;
let otherUserAddress: string;
let vault: Contract;
let perp: Contract;
let bondFactory: Contract;
let collateralToken: Contract;
let rebaseOracle: Contract;
let issuer: Contract;
let feePolicy: Contract;

let reserveTranches: Contract[][] = [];
let rolloverInBond: Contract;
let rolloverInTranches: Contract;

describe("RolloverVault", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    deployerAddress = await deployer.getAddress();
    otherUser = accounts[1];
    otherUserAddress = await otherUser.getAddress();

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

    feePolicy = new DMock(await ethers.getContractFactory("FeePolicy"));
    await feePolicy.deploy();
    await feePolicy.mockMethod("decimals()", [8]);
    await feePolicy.mockMethod("computeDeviationRatio((uint256,uint256,uint256))", [toPercFixedPtAmt("1")]);
    await feePolicy.mockMethod("computeFeePerc(uint256,uint256)", [0]);

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
    await vault.init("RolloverVault", "VSHARE", perp.target, feePolicy.target);
    await perp.updateVault(vault.target);

    reserveTranches = [];
    for (let i = 0; i < 3; i++) {
      const bond = await getDepositBond(perp);
      const tranches = await getTranches(bond);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);

      await tranches[0].approve(perp.target, toFixedPtAmt("200"));
      await perp.deposit(tranches[0].target, toFixedPtAmt("200"));

      reserveTranches.push(tranches[0]);
      await advancePerpQueue(perp, 1200);
    }

    await checkPerpComposition(
      perp,
      [collateralToken, ...reserveTranches],
      ["0", toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
    );

    rolloverInBond = await bondAt(await perp.getDepositBond.staticCall());
    rolloverInTranches = await getTranches(rolloverInBond);

    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
    await collateralToken.approve(vault.target, toFixedPtAmt("1"));

    expect(await vault.assetCount()).to.eq(1);
    expect(await vault.vaultAssetBalance(await vault.underlying())).to.eq(0);
  });

  describe("#getTVL", function () {
    describe("when vault is empty", function () {
      it("should return 0 vaule", async function () {
        expect(await vault.getTVL.staticCall()).to.eq(0);
        expect(await vault.getVaultAssetValue.staticCall(collateralToken.target)).to.eq(0);
        expect(await vault.getVaultAssetValue.staticCall(perp.target)).to.eq(0);
      });
    });

    describe("when vault has only usable balance", function () {
      beforeEach(async function () {
        await collateralToken.transfer(vault.target, toFixedPtAmt("100"));
      });
      it("should return tvl", async function () {
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("100"));
      });
      it("should return asset value", async function () {
        expect(await vault.getVaultAssetValue.staticCall(collateralToken.target)).to.eq(toFixedPtAmt("100"));
        expect(await vault.getVaultAssetValue.staticCall(perp.target)).to.eq(0);
      });
    });

    describe("when vault has only deployed balance", function () {
      beforeEach(async function () {
        await collateralToken.transfer(vault.target, toFixedPtAmt("100"));
        await vault.deploy();
        expect(await vault.vaultAssetBalance(await vault.underlying())).to.eq(0);
        expect(await vault.assetCount()).to.eq(3);
      });
      it("should return tvl", async function () {
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("100"));
      });
      it("should return asset value", async function () {
        expect(await vault.getVaultAssetValue.staticCall(collateralToken.target)).to.eq(0);
        expect(await vault.getVaultAssetValue.staticCall(reserveTranches[0].target)).to.eq(toFixedPtAmt("20"));
        expect(await vault.getVaultAssetValue.staticCall(rolloverInTranches[1].target)).to.eq(toFixedPtAmt("80"));
        expect(await vault.getVaultAssetValue.staticCall(perp.target)).to.eq(0);
      });
    });

    describe("when vault has many balances", function () {
      beforeEach(async function () {
        await perp.transfer(vault.target, toFixedPtAmt("100"));
        await collateralToken.transfer(vault.target, toFixedPtAmt("2000"));
        await vault.deploy();
        await collateralToken.transfer(vault.target, toFixedPtAmt("100"));
      });
      it("should return tvl", async function () {
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("2100"));
      });
      it("should return asset value", async function () {
        expect(await vault.getVaultAssetValue.staticCall(perp.target)).to.eq("0");
        expect(await vault.getVaultAssetValue.staticCall(collateralToken.target)).to.eq(toFixedPtAmt("1100"));
        expect(await vault.getVaultAssetValue.staticCall(reserveTranches[0].target)).to.eq(toFixedPtAmt("200"));
        expect(await vault.getVaultAssetValue.staticCall(rolloverInTranches[1].target)).to.eq(toFixedPtAmt("800"));
      });
    });

    describe("when vault has many balances and rebases up", function () {
      beforeEach(async function () {
        await collateralToken.transfer(vault.target, toFixedPtAmt("2000"));
        await vault.deploy();
        await collateralToken.transfer(vault.target, toFixedPtAmt("100"));
        await rebase(collateralToken, rebaseOracle, 0.1);
      });
      it("should return tvl", async function () {
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("2310"));
      });
      it("should return asset value", async function () {
        expect(await vault.getVaultAssetValue.staticCall(collateralToken.target)).to.eq(toFixedPtAmt("1210"));
        expect(await vault.getVaultAssetValue.staticCall(reserveTranches[0].target)).to.eq(toFixedPtAmt("200"));
        expect(await vault.getVaultAssetValue.staticCall(rolloverInTranches[1].target)).to.eq(toFixedPtAmt("900"));
      });
    });

    describe("when vault has many balances and rebases down", function () {
      beforeEach(async function () {
        await collateralToken.transfer(vault.target, toFixedPtAmt("2000"));
        await vault.deploy();
        await collateralToken.transfer(vault.target, toFixedPtAmt("100"));
        await rebase(collateralToken, rebaseOracle, -0.1);
      });
      it("should return tvl", async function () {
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("1890"));
      });
      it("should return asset value", async function () {
        expect(await vault.getVaultAssetValue.staticCall(collateralToken.target)).to.eq(toFixedPtAmt("990"));
        expect(await vault.getVaultAssetValue.staticCall(reserveTranches[0].target)).to.eq(toFixedPtAmt("200"));
        expect(await vault.getVaultAssetValue.staticCall(rolloverInTranches[1].target)).to.eq(toFixedPtAmt("700"));
      });
    });

    describe("when vault has many balances and rebases down below threshold", function () {
      beforeEach(async function () {
        await collateralToken.transfer(vault.target, toFixedPtAmt("5000"));
        await vault.deploy();
        await collateralToken.transfer(vault.target, toFixedPtAmt("100"));
        await rebase(collateralToken, rebaseOracle, -0.9);
      });

      it("should return tvl", async function () {
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("510"));
      });

      it("should return asset value", async function () {
        expect(await vault.getVaultAssetValue.staticCall(collateralToken.target)).to.eq(toFixedPtAmt("410"));
        expect(await vault.getVaultAssetValue.staticCall(reserveTranches[0].target)).to.eq(toFixedPtAmt("100"));
        expect(await vault.getVaultAssetValue.staticCall(reserveTranches[1].target)).to.eq("0");
        expect(await vault.getVaultAssetValue.staticCall(reserveTranches[2].target)).to.eq("0");
        expect(await vault.getVaultAssetValue.staticCall(rolloverInTranches[0].target)).to.eq(toFixedPtAmt("0"));
        expect(await vault.getVaultAssetValue.staticCall(rolloverInTranches[1].target)).to.eq("0");
      });
    });

    describe("when vault has some dust balances", function () {
      beforeEach(async function () {
        await perp.transfer(vault.target, toFixedPtAmt("100"));
        await collateralToken.transfer(vault.target, toFixedPtAmt("2000"));
        await vault.deploy();
        await vault["recover(address)"](perp.target);
        await collateralToken.transfer(vault.target, toFixedPtAmt("100"));
        await checkVaultComposition(
          vault,
          [
            collateralToken,
            reserveTranches[0],
            reserveTranches[1],
            reserveTranches[2],
            rolloverInTranches[0],
            rolloverInTranches[1],
          ],
          [
            toFixedPtAmt("1266.666666666666666"),
            toFixedPtAmt("200"),
            toFixedPtAmt("33.333333333333333333"),
            toFixedPtAmt("33.333333333333333333"),
            toFixedPtAmt("0.000000000000000133"),
            toFixedPtAmt("666.6666666666666672"),
          ],
        );
      });
      it("should return tvl excluding the dust", async function () {
        // balances sum up to 2200 but tvl will exclude 0.000000000000000133
        expect(await vault.getTVL.staticCall()).to.eq(toFixedPtAmt("2199.999999999999999866"));
      });
      it("should return asset value", async function () {
        expect(await vault.getVaultAssetValue.staticCall(perp.target)).to.eq("0");
        expect(await vault.getVaultAssetValue.staticCall(collateralToken.target)).to.eq(
          toFixedPtAmt("1266.666666666666666"),
        );
        expect(await vault.getVaultAssetValue.staticCall(reserveTranches[0].target)).to.eq(toFixedPtAmt("200"));
        expect(await vault.getVaultAssetValue.staticCall(reserveTranches[1].target)).to.eq(
          toFixedPtAmt("33.333333333333333333"),
        );
        expect(await vault.getVaultAssetValue.staticCall(reserveTranches[2].target)).to.eq(
          toFixedPtAmt("33.333333333333333333"),
        );
        expect(await vault.getVaultAssetValue.staticCall(rolloverInTranches[1].target)).to.eq(
          toFixedPtAmt("666.6666666666666672"),
        );
      });
      it("should return no asset value for dust", async function () {
        expect(await rolloverInTranches[0].balanceOf(vault.target)).eq("133");
        expect(await vault.getVaultAssetValue.staticCall(rolloverInTranches[0].target)).to.eq("0");
      });
    });
  });

  describe("#deposit", function () {
    let noteAmt: BigNumber;

    describe("when deposit amount is zero", async function () {
      it("should return zero", async function () {
        expect(await vault.deposit.staticCall("0")).to.eq("0");
      });
    });

    describe("when total supply = 0", async function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.target, toFixedPtAmt("100"));
        noteAmt = await vault.deposit.staticCall(toFixedPtAmt("100"));
      });
      it("should transfer underlying", async function () {
        await expect(() => vault.deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [deployer, vault],
          [toFixedPtAmt("-100"), toFixedPtAmt("100")],
        );
      });
      it("should update vault", async function () {
        await checkVaultComposition(vault, [collateralToken], ["0"]);
        await vault.deposit(toFixedPtAmt("100"));
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("100")]);
      });
      it("should mint notes", async function () {
        await expect(() => vault.deposit(toFixedPtAmt("100"))).to.changeTokenBalances(vault, [deployer], [noteAmt]);
      });
      it("should return the note amount", async function () {
        expect(noteAmt).to.eq(toFixedPtAmt("100") * 1000000n);
      });
    });

    describe("when total supply > 0 and tvl = ts", async function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.target, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));
        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.target, toFixedPtAmt("100"));
        noteAmt = await vault.connect(otherUser).deposit.staticCall(toFixedPtAmt("100"));
      });
      it("should transfer underlying", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [otherUser, vault],
          [toFixedPtAmt("-100"), toFixedPtAmt("100")],
        );
      });

      it("should update vault", async function () {
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("100")]);
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("200")]);
      });

      it("should mint notes", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          vault,
          [otherUser, deployer],
          [noteAmt, "0"],
        );
      });
      it("should return the note amount", async function () {
        expect(noteAmt).to.eq(toFixedPtAmt("100") * 1000000n);
      });
    });

    describe("when total supply > 0 and tvl > ts", async function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.target, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));
        await collateralToken.transfer(vault.target, toFixedPtAmt("100"));
        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.target, toFixedPtAmt("100"));
        noteAmt = await vault.connect(otherUser).deposit.staticCall(toFixedPtAmt("100"));
      });

      it("should transfer underlying", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [otherUser, vault],
          [toFixedPtAmt("-100"), toFixedPtAmt("100")],
        );
      });

      it("should update vault", async function () {
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("200")]);
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("300")]);
      });

      it("should mint notes", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          vault,
          [otherUser, deployer],
          [noteAmt, "0"],
        );
      });
      it("should return the note amount", async function () {
        expect(noteAmt).to.eq(toFixedPtAmt("100") * 500000n);
      });
    });

    describe("when total supply > 0 and tvl < ts", async function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.target, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));
        await rebase(collateralToken, rebaseOracle, -0.5);
        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.target, toFixedPtAmt("100"));
        noteAmt = await vault.connect(otherUser).deposit.staticCall(toFixedPtAmt("100"));
      });

      it("should transfer underlying", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [otherUser, vault],
          [toFixedPtAmt("-100"), toFixedPtAmt("100")],
        );
      });

      it("should update vault", async function () {
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("50")]);
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("150")]);
      });

      it("should mint notes", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          vault,
          [otherUser, deployer],
          [noteAmt, "0"],
        );
      });

      it("should return the note amount", async function () {
        expect(noteAmt).to.eq(toFixedPtAmt("100") * 2000000n);
      });
    });

    describe("when total supply > 0 and vault has deployed assets", async function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.target, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));
        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.target, toFixedPtAmt("100"));
        noteAmt = await vault.connect(otherUser).deposit.staticCall(toFixedPtAmt("100"));
      });
      it("should transfer underlying", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [otherUser, vault],
          [toFixedPtAmt("-100"), toFixedPtAmt("100")],
        );
      });

      it("should update vault", async function () {
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("100")]);
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("200")]);
      });

      it("should mint notes", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          vault,
          [otherUser, deployer],
          [noteAmt, "0"],
        );
      });
      it("should return the note amount", async function () {
        expect(noteAmt).to.eq(toFixedPtAmt("100") * 1000000n);
      });
    });

    describe("fee > 0", async function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.target, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));

        await feePolicy.clearMockMethod("computeDeviationRatio((uint256,uint256,uint256))");
        await feePolicy.mockCall(
          "computeDeviationRatio((uint256,uint256,uint256))",
          [[toFixedPtAmt("600"), toFixedPtAmt("100"), "200"]],
          [toPercFixedPtAmt("1")],
        );
        await feePolicy.mockCall(
          "computeDeviationRatio((uint256,uint256,uint256))",
          [[toFixedPtAmt("600"), toFixedPtAmt("200"), "200"]],
          [toPercFixedPtAmt("1")],
        );
        await feePolicy.mockMethod("computeFeePerc(uint256,uint256)", [toPercFixedPtAmt("0.05")]);
        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.target, toFixedPtAmt("100"));
        noteAmt = await vault.connect(otherUser).deposit.staticCall(toFixedPtAmt("100"));
      });
      it("should transfer underlying", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [otherUser, vault],
          [toFixedPtAmt("-100"), toFixedPtAmt("100")],
        );
      });
      it("should update vault", async function () {
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("100")]);
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("200")]);
      });

      it("should mint notes", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          vault,
          [otherUser, deployer],
          [noteAmt, "0"],
        );
      });
      it("should return the note amount", async function () {
        expect(noteAmt).to.eq(toFixedPtAmt("95") * 1000000n);
      });
    });
  });

  describe("#redeem", function () {
    let bal: BigNumber;

    describe("when vault is empty", function () {
      it("should revert", async function () {
        await expect(vault.redeem("1")).to.be.reverted;
      });
    });

    describe("when redeem amount is zero", async function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.target, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));
      });

      it("should return []", async function () {
        expect(await vault.redeem.staticCall("0")).to.deep.eq([]);
      });
    });

    describe("when burning more than balance", function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.target, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));
      });

      it("should revert", async function () {
        await expect(vault.redeem((await vault.balanceOf(deployerAddress)) + 1n)).to.be.reverted;
        await expect(vault.redeem(await vault.balanceOf(deployerAddress))).not.to.be.reverted;
      });
    });

    describe("when vault has only underlying balance", function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.target, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));

        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.target, toFixedPtAmt("100"));
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));

        bal = await vault.balanceOf(deployerAddress);
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          collateralToken,
          [deployer, vault],
          [toFixedPtAmt("100"), toFixedPtAmt("-100")],
        );
      });

      it("should update vault", async function () {
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("200")]);
        await vault.redeem(bal);
        await checkVaultComposition(vault, [collateralToken], [toFixedPtAmt("100")]);
      });

      it("should burn users notes", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(vault, [deployer], [bal * -1n]);
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100") * 1000000n);
      });

      it("should return redemption amounts", async function () {
        const redemptionAmts = await vault.redeem.staticCall(bal);
        expect(redemptionAmts.length).to.eq(1);
        expect(redemptionAmts[0].token).to.eq(collateralToken.target);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("100"));
      });
    });

    describe("when vault has only deployed balance", function () {
      let bal: BigNumber;
      beforeEach(async function () {
        await collateralToken.approve(vault.target, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));

        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.target, toFixedPtAmt("100"));
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));

        await vault.deploy();

        bal = await vault.balanceOf(deployerAddress);

        expect(await vault.vaultAssetBalance(await vault.underlying())).to.eq(0);
        expect(await vault.assetCount()).to.eq(3);
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          reserveTranches[0],
          [deployer, vault],
          [toFixedPtAmt("20"), toFixedPtAmt("-20")],
        );
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          rolloverInTranches[1],
          [deployer, vault],
          [toFixedPtAmt("80"), toFixedPtAmt("-80")],
        );
      });

      it("should update vault", async function () {
        await checkVaultComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1]],
          ["0", toFixedPtAmt("40"), toFixedPtAmt("160")],
        );
        await vault.redeem(bal);
        await checkVaultComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1]],
          ["0", toFixedPtAmt("20"), toFixedPtAmt("80")],
        );
      });

      it("should burn users notes", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(vault, [deployer], [bal * -1n]);
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100") * 1000000n);
      });

      it("should return redemption amounts", async function () {
        const redemptionAmts = await vault.redeem.staticCall(bal);
        expect(redemptionAmts.length).to.eq(3);
        expect(redemptionAmts[0].token).to.eq(collateralToken.target);
        expect(redemptionAmts[0].amount).to.eq(0);
        expect(redemptionAmts[1].token).to.eq(reserveTranches[0].target);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("20"));
        expect(redemptionAmts[2].token).to.eq(rolloverInTranches[1].target);
        expect(redemptionAmts[2].amount).to.eq(toFixedPtAmt("80"));
      });
    });

    describe("when vault has a combination of balances (full balance redemption)", function () {
      let redemptionAmts: [string, BigNumber][];
      beforeEach(async function () {
        await collateralToken.approve(vault.target, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));

        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.target, toFixedPtAmt("100"));
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));

        await vault.deploy();
        await collateralToken.transfer(vault.target, toFixedPtAmt("20"));

        redemptionAmts = await vault.redeem.staticCall(await vault.balanceOf(deployerAddress));
        bal = await vault.balanceOf(deployerAddress);
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          collateralToken,
          [deployer, vault],
          [toFixedPtAmt("10"), toFixedPtAmt("-10")],
        );
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          reserveTranches[0],
          [deployer, vault],
          [toFixedPtAmt("20"), toFixedPtAmt("-20")],
        );
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          rolloverInTranches[1],
          [deployer, vault],
          [toFixedPtAmt("80"), toFixedPtAmt("-80")],
        );
      });

      it("should update vault", async function () {
        await checkVaultComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1]],
          [toFixedPtAmt("20"), toFixedPtAmt("40"), toFixedPtAmt("160")],
        );
        await vault.redeem(bal);
        await checkVaultComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1]],
          [toFixedPtAmt("10"), toFixedPtAmt("20"), toFixedPtAmt("80")],
        );
      });

      it("should burn users notes", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(vault, [deployer], [bal * -1n]);
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100") * 1000000n);
      });

      it("should return redemption amounts", async function () {
        expect(redemptionAmts.length).to.eq(3);
        expect(redemptionAmts[0].token).to.eq(collateralToken.target);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("10"));
        expect(redemptionAmts[1].token).to.eq(reserveTranches[0].target);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("20"));
        expect(redemptionAmts[2].token).to.eq(rolloverInTranches[1].target);
        expect(redemptionAmts[2].amount).to.eq(toFixedPtAmt("80"));
      });
    });

    describe("when vault has a combination of balances (partial balance redemption)", function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.target, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));

        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.target, toFixedPtAmt("100"));
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));

        await vault.deploy();
        await collateralToken.transfer(vault.target, toFixedPtAmt("20"));

        bal = toFixedPtAmt("50") * 1000000n;
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          collateralToken,
          [deployer, vault],
          [toFixedPtAmt("5"), toFixedPtAmt("-5")],
        );
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          reserveTranches[0],
          [deployer, vault],
          [toFixedPtAmt("10"), toFixedPtAmt("-10")],
        );
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          rolloverInTranches[1],
          [deployer, vault],
          [toFixedPtAmt("40"), toFixedPtAmt("-40")],
        );
      });

      it("should update vault", async function () {
        await checkVaultComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1]],
          [toFixedPtAmt("20"), toFixedPtAmt("40"), toFixedPtAmt("160")],
        );
        await vault.redeem(bal);
        await checkVaultComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1]],
          [toFixedPtAmt("15"), toFixedPtAmt("30"), toFixedPtAmt("120")],
        );
      });

      it("should burn users notes", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(vault, [deployer], [bal * -1n]);
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100") * 1000000n);
      });

      it("should return redemption amounts", async function () {
        const redemptionAmts = await vault.redeem.staticCall(bal);
        expect(redemptionAmts.length).to.eq(3);
        expect(redemptionAmts[0].token).to.eq(collateralToken.target);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("5"));
        expect(redemptionAmts[1].token).to.eq(reserveTranches[0].target);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("10"));
        expect(redemptionAmts[2].token).to.eq(rolloverInTranches[1].target);
        expect(redemptionAmts[2].amount).to.eq(toFixedPtAmt("40"));
      });
    });

    describe("when fee > 0", function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.target, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));

        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.target, toFixedPtAmt("100"));
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));

        await vault.deploy();
        await collateralToken.transfer(vault.target, toFixedPtAmt("20"));

        bal = toFixedPtAmt("50") * 1000000n;
        await feePolicy.clearMockMethod("computeDeviationRatio((uint256,uint256,uint256))");
        await feePolicy.mockCall(
          "computeDeviationRatio((uint256,uint256,uint256))",
          [[toFixedPtAmt("600"), toFixedPtAmt("220"), "200"]],
          [toPercFixedPtAmt("1")],
        );
        await feePolicy.mockCall(
          "computeDeviationRatio((uint256,uint256,uint256))",
          [[toFixedPtAmt("600"), toFixedPtAmt("165"), "200"]],
          [toPercFixedPtAmt("1")],
        );
        await feePolicy.mockMethod("computeFeePerc(uint256,uint256)", [toPercFixedPtAmt("0.1")]);
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          collateralToken,
          [deployer, vault],
          [toFixedPtAmt("4.5"), toFixedPtAmt("-4.5")],
        );
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          reserveTranches[0],
          [deployer, vault],
          [toFixedPtAmt("9"), toFixedPtAmt("-9")],
        );
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          rolloverInTranches[1],
          [deployer, vault],
          [toFixedPtAmt("36"), toFixedPtAmt("-36")],
        );
      });

      it("should update vault", async function () {
        await checkVaultComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1]],
          [toFixedPtAmt("20"), toFixedPtAmt("40"), toFixedPtAmt("160")],
        );
        await vault.redeem(bal);
        await checkVaultComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1]],
          [toFixedPtAmt("15.5"), toFixedPtAmt("31"), toFixedPtAmt("124")],
        );
      });

      it("should burn users notes", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(vault, [deployer], [bal * -1n]);
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100") * 1000000n);
      });

      it("should return redemption amounts", async function () {
        const redemptionAmts = await vault.redeem.staticCall(bal);
        expect(redemptionAmts.length).to.eq(3);
        expect(redemptionAmts[0].token).to.eq(collateralToken.target);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("4.5"));
        expect(redemptionAmts[1].token).to.eq(reserveTranches[0].target);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("9"));
        expect(redemptionAmts[2].token).to.eq(rolloverInTranches[1].target);
        expect(redemptionAmts[2].amount).to.eq(toFixedPtAmt("36"));
      });
    });
  });
});
