import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer, BigNumber } from "ethers";
import { smock } from "@defi-wonderland/smock";

import {
  setupCollateralToken,
  mintCollteralToken,
  setupBondFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toPriceFixedPtAmt,
  getDepositBond,
  advancePerpQueue,
  advancePerpQueueToBondMaturity,
  checkReserveComposition,
  checkVaultAssetComposition,
  rebase,
} from "../helpers";
use(smock.matchers);

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
let feeStrategy: Contract;
let pricingStrategy: Contract;

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
    issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
    await issuer.init(4800, [200, 300, 500], 1200, 0);

    const FeeStrategy = await ethers.getContractFactory("FeeStrategy");
    feeStrategy = await smock.fake(FeeStrategy);
    await feeStrategy.decimals.returns(8);
    await feeStrategy.computeRolloverFeePerc.returns("0");

    const PricingStrategy = await ethers.getContractFactory("UnitPricingStrategy");
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

    await feeStrategy.feeToken.returns(perp.address);

    await perp.updateTolerableTrancheMaturity(1200, 4800);
    await advancePerpQueueToBondMaturity(perp, await getDepositBond(perp));

    reserveTranches = [];
    for (let i = 0; i < 3; i++) {
      const bond = await getDepositBond(perp);
      const tranches = await getTranches(bond);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);

      await tranches[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

      reserveTranches.push(tranches[0]);
      await advancePerpQueue(perp, 1200);
    }

    await checkReserveComposition(
      perp,
      [collateralToken, ...reserveTranches],
      [toFixedPtAmt("0"), toFixedPtAmt("200"), toFixedPtAmt("200"), toFixedPtAmt("200")],
    );

    rolloverInBond = await bondAt(await perp.callStatic.getDepositBond());
    rolloverInTranches = await getTranches(rolloverInBond);

    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    vault = await upgrades.deployProxy(RolloverVault.connect(deployer));
    await collateralToken.approve(vault.address, toFixedPtAmt("1"));
    await vault.init("RolloverVault", "VSHARE", perp.address);

    expect(await vault.deployedCount()).to.eq(0);
    expect(await vault.vaultAssetBalance(await vault.underlying())).to.eq(0);
    expect(await vault.vaultAssetBalance(await vault.earnedAt(0))).to.eq(0);
  });

  describe("#getTVL", function () {
    describe("when vault is empty", function () {
      it("should return 0 vaule", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(0);
        expect(await vault.callStatic.getVaultAssetValue(collateralToken.address)).to.eq(0);
        expect(await vault.callStatic.getVaultAssetValue(perp.address)).to.eq(0);
      });
    });

    describe("when vault has only usable balance", function () {
      beforeEach(async function () {
        await collateralToken.transfer(vault.address, toFixedPtAmt("100"));
      });
      it("should return tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("100"));
      });
      it("should return asset value", async function () {
        expect(await vault.callStatic.getVaultAssetValue(collateralToken.address)).to.eq(toFixedPtAmt("100"));
        expect(await vault.callStatic.getVaultAssetValue(perp.address)).to.eq(0);
      });
    });

    describe("when vault has only deployed balance", function () {
      beforeEach(async function () {
        await collateralToken.transfer(vault.address, toFixedPtAmt("100"));
        await vault.deploy();
        expect(await vault.vaultAssetBalance(await vault.underlying())).to.eq(0);
        expect(await vault.deployedCount()).to.eq(3);
      });
      it("should return tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("100"));
      });
      it("should return asset value", async function () {
        expect(await vault.callStatic.getVaultAssetValue(collateralToken.address)).to.eq(0);
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[0].address)).to.eq(toFixedPtAmt("20"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[1].address)).to.eq(toFixedPtAmt("30"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[2].address)).to.eq(toFixedPtAmt("50"));
        expect(await vault.callStatic.getVaultAssetValue(perp.address)).to.eq(0);
      });
    });

    describe("when vault has only earned balance", function () {
      beforeEach(async function () {
        await perp.transfer(vault.address, toFixedPtAmt("100"));
      });
      it("should return tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("100"));
      });
      it("should return asset value", async function () {
        expect(await vault.callStatic.getVaultAssetValue(collateralToken.address)).to.eq(0);
        expect(await vault.callStatic.getVaultAssetValue(perp.address)).to.eq(toFixedPtAmt("100"));
      });
    });

    describe("when vault has many balances", function () {
      beforeEach(async function () {
        await perp.transfer(vault.address, toFixedPtAmt("100"));
        await collateralToken.transfer(vault.address, toFixedPtAmt("2000"));
        await vault.deploy();
        await collateralToken.transfer(vault.address, toFixedPtAmt("100"));
      });
      it("should return tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2200"));
      });
      it("should return asset value", async function () {
        expect(await vault.callStatic.getVaultAssetValue(collateralToken.address)).to.eq(toFixedPtAmt("100"));
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[0].address)).to.eq(toFixedPtAmt("200"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[1].address)).to.eq(toFixedPtAmt("600"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[2].address)).to.eq(toFixedPtAmt("1000"));
        expect(await vault.callStatic.getVaultAssetValue(perp.address)).to.eq(toFixedPtAmt("100"));
      });
    });

    describe("when vault has many balances and rebases up", function () {
      beforeEach(async function () {
        await perp.transfer(vault.address, toFixedPtAmt("100"));
        await collateralToken.transfer(vault.address, toFixedPtAmt("2000"));
        await vault.deploy();
        await collateralToken.transfer(vault.address, toFixedPtAmt("100"));
        await rebase(collateralToken, rebaseOracle, 0.1);
      });
      it("should return tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("2410"));
      });
      it("should return asset value", async function () {
        expect(await vault.callStatic.getVaultAssetValue(collateralToken.address)).to.eq(toFixedPtAmt("110"));
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[0].address)).to.eq(toFixedPtAmt("200"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[1].address)).to.eq(toFixedPtAmt("600"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[2].address)).to.eq(toFixedPtAmt("1200"));
        expect(await vault.callStatic.getVaultAssetValue(perp.address)).to.eq(toFixedPtAmt("100"));
      });
    });

    describe("when vault has many balances and rebases down", function () {
      beforeEach(async function () {
        await perp.transfer(vault.address, toFixedPtAmt("100"));
        await collateralToken.transfer(vault.address, toFixedPtAmt("2000"));
        await vault.deploy();
        await collateralToken.transfer(vault.address, toFixedPtAmt("100"));
        await rebase(collateralToken, rebaseOracle, -0.1);
      });
      it("should return tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("1990"));
      });
      it("should return asset value", async function () {
        expect(await vault.callStatic.getVaultAssetValue(collateralToken.address)).to.eq(toFixedPtAmt("90"));
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[0].address)).to.eq(toFixedPtAmt("200"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[1].address)).to.eq(toFixedPtAmt("600"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[2].address)).to.eq(toFixedPtAmt("800"));
        expect(await vault.callStatic.getVaultAssetValue(perp.address)).to.eq(toFixedPtAmt("100"));
      });
    });

    describe("when vault has many balances and rebases down below threshold", function () {
      beforeEach(async function () {
        await perp.transfer(vault.address, toFixedPtAmt("100"));
        await collateralToken.transfer(vault.address, toFixedPtAmt("5000"));
        await vault.deploy();
        await collateralToken.transfer(vault.address, toFixedPtAmt("100"));

        await pricingStrategy.computeTranchePrice
          .whenCalledWith(reserveTranches[0].address)
          .returns(toPriceFixedPtAmt("0.5"));
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(reserveTranches[1].address)
          .returns(toPriceFixedPtAmt("0"));
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(reserveTranches[2].address)
          .returns(toPriceFixedPtAmt("0.5"));
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(rolloverInTranches[0].address)
          .returns(toPriceFixedPtAmt("0.5"));
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(rolloverInTranches[1].address)
          .returns(toPriceFixedPtAmt("0"));
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(rolloverInTranches[2].address)
          .returns(toPriceFixedPtAmt("0"));
        await rebase(collateralToken, rebaseOracle, -0.9);
      });
      it("should return tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("543.333333"));
      });

      it("should return asset value", async function () {
        expect(await vault.callStatic.getVaultAssetValue(collateralToken.address)).to.eq(toFixedPtAmt("10"));
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[0].address)).to.eq(toFixedPtAmt("100"));
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[1].address)).to.eq(toFixedPtAmt("0"));
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[2].address)).to.eq(toFixedPtAmt("0"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[0].address)).to.eq(toFixedPtAmt("400"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[1].address)).to.eq(toFixedPtAmt("0"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[2].address)).to.eq(toFixedPtAmt("0"));
        expect(await vault.callStatic.getVaultAssetValue(perp.address)).to.eq(toFixedPtAmt("33.333333"));
      });
    });
  });

  describe("#deposit", function () {
    let noteAmt: BigNumber;

    describe("when total supply = 0", async function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.address, toFixedPtAmt("100"));
        noteAmt = await vault.callStatic.deposit(toFixedPtAmt("100"));
      });
      it("should transfer underlying", async function () {
        await expect(() => vault.deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [deployer, vault],
          [toFixedPtAmt("-100"), toFixedPtAmt("100")],
        );
      });
      it("should update vault", async function () {
        await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("0"), toFixedPtAmt("0")]);
        await vault.deposit(toFixedPtAmt("100"));
        await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("100"), toFixedPtAmt("0")]);
      });
      it("should mint notes", async function () {
        await expect(() => vault.deposit(toFixedPtAmt("100"))).to.changeTokenBalances(vault, [deployer], [noteAmt]);
      });
      it("should return the note amount", async function () {
        expect(noteAmt).to.eq(toFixedPtAmt("100").mul("1000000"));
      });
    });

    describe("when total supply > 0 and tvl = ts", async function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.address, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));
        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.address, toFixedPtAmt("100"));
        noteAmt = await vault.connect(otherUser).callStatic.deposit(toFixedPtAmt("100"));
      });
      it("should transfer underlying", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [otherUser, vault],
          [toFixedPtAmt("-100"), toFixedPtAmt("100")],
        );
      });

      it("should update vault", async function () {
        await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("100"), toFixedPtAmt("0")]);
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));
        await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("200"), toFixedPtAmt("0")]);
      });

      it("should mint notes", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          vault,
          [otherUser, deployer],
          [noteAmt, toFixedPtAmt("0")],
        );
      });
      it("should return the note amount", async function () {
        expect(noteAmt).to.eq(toFixedPtAmt("100").mul("1000000"));
      });
    });

    describe("when total supply > 0 and tvl > ts", async function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.address, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));
        await collateralToken.transfer(vault.address, toFixedPtAmt("100"));
        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.address, toFixedPtAmt("100"));
        noteAmt = await vault.connect(otherUser).callStatic.deposit(toFixedPtAmt("100"));
      });

      it("should transfer underlying", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [otherUser, vault],
          [toFixedPtAmt("-100"), toFixedPtAmt("100")],
        );
      });

      it("should update vault", async function () {
        await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("200"), toFixedPtAmt("0")]);
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));
        await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("300"), toFixedPtAmt("0")]);
      });

      it("should mint notes", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          vault,
          [otherUser, deployer],
          [noteAmt, toFixedPtAmt("0")],
        );
      });
      it("should return the note amount", async function () {
        expect(noteAmt).to.eq(toFixedPtAmt("100").mul("500000"));
      });
    });

    describe("when total supply > 0 and tvl < ts", async function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.address, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));
        await rebase(collateralToken, rebaseOracle, -0.5);
        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.address, toFixedPtAmt("100"));
        noteAmt = await vault.connect(otherUser).callStatic.deposit(toFixedPtAmt("100"));
      });

      it("should transfer underlying", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [otherUser, vault],
          [toFixedPtAmt("-100"), toFixedPtAmt("100")],
        );
      });

      it("should update vault", async function () {
        await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("50"), toFixedPtAmt("0")]);
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));
        await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("150"), toFixedPtAmt("0")]);
      });

      it("should mint notes", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          vault,
          [otherUser, deployer],
          [noteAmt, toFixedPtAmt("0")],
        );
      });

      it("should return the note amount", async function () {
        expect(noteAmt).to.eq(toFixedPtAmt("100").mul("2000000"));
      });
    });

    describe("when total supply > 0 and vault has deployed assets", async function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.address, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));
        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.address, toFixedPtAmt("100"));
        noteAmt = await vault.connect(otherUser).callStatic.deposit(toFixedPtAmt("100"));
      });
      it("should transfer underlying", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          collateralToken,
          [otherUser, vault],
          [toFixedPtAmt("-100"), toFixedPtAmt("100")],
        );
      });

      it("should update vault", async function () {
        await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("100"), toFixedPtAmt("0")]);
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));
        await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("200"), toFixedPtAmt("0")]);
      });

      it("should mint notes", async function () {
        await expect(() => vault.connect(otherUser).deposit(toFixedPtAmt("100"))).to.changeTokenBalances(
          vault,
          [otherUser, deployer],
          [noteAmt, toFixedPtAmt("0")],
        );
      });
      it("should return the note amount", async function () {
        expect(noteAmt).to.eq(toFixedPtAmt("100").mul("1000000"));
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

    describe("when burning more than balance", function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.address, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));
      });

      it("should revert", async function () {
        await expect(vault.redeem((await vault.balanceOf(deployerAddress)).add("1"))).to.be.reverted;
        await expect(vault.redeem(await vault.balanceOf(deployerAddress))).not.to.be.reverted;
      });
    });

    describe("when vault has only usable balance", function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.address, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));

        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.address, toFixedPtAmt("100"));
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
        await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("200"), toFixedPtAmt("0")]);
        await vault.redeem(bal);
        await checkVaultAssetComposition(vault, [collateralToken, perp], [toFixedPtAmt("100"), toFixedPtAmt("0")]);
      });

      it("should burn users notes", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(vault, [deployer], [bal.mul("-1")]);
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100").mul("1000000"));
      });

      it("should return redemption amounts", async function () {
        const redemptionAmts = await vault.callStatic.redeem(bal);
        expect(redemptionAmts.length).to.eq(2);
        expect(redemptionAmts[0].token).to.eq(collateralToken.address);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("100"));
        expect(redemptionAmts[1].token).to.eq(perp.address);
        expect(redemptionAmts[1].amount).to.eq(0);
      });
    });

    describe("when vault has only deployed balance", function () {
      let bal: BigNumber;
      beforeEach(async function () {
        await collateralToken.approve(vault.address, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));

        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.address, toFixedPtAmt("100"));
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));

        await vault.deploy();

        bal = await vault.balanceOf(deployerAddress);

        expect(await vault.vaultAssetBalance(await vault.underlying())).to.eq(0);
        expect(await vault.deployedCount()).to.eq(3);
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
          [toFixedPtAmt("30"), toFixedPtAmt("-30")],
        );
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          rolloverInTranches[2],
          [deployer, vault],
          [toFixedPtAmt("50"), toFixedPtAmt("-50")],
        );
      });

      it("should update vault", async function () {
        await checkVaultAssetComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1], rolloverInTranches[2], perp],
          [toFixedPtAmt("0"), toFixedPtAmt("40"), toFixedPtAmt("60"), toFixedPtAmt("100"), toFixedPtAmt("0")],
        );
        await vault.redeem(bal);
        await checkVaultAssetComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1], rolloverInTranches[2], perp],
          [toFixedPtAmt("0"), toFixedPtAmt("20"), toFixedPtAmt("30"), toFixedPtAmt("50"), toFixedPtAmt("0")],
        );
      });

      it("should burn users notes", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(vault, [deployer], [bal.mul("-1")]);
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100").mul("1000000"));
      });

      it("should return redemption amounts", async function () {
        const redemptionAmts = await vault.callStatic.redeem(bal);
        expect(redemptionAmts.length).to.eq(5);
        expect(redemptionAmts[0].token).to.eq(collateralToken.address);
        expect(redemptionAmts[0].amount).to.eq(0);
        expect(redemptionAmts[1].token).to.eq(rolloverInTranches[2].address);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("50"));
        expect(redemptionAmts[2].token).to.eq(rolloverInTranches[1].address);
        expect(redemptionAmts[2].amount).to.eq(toFixedPtAmt("30"));
        expect(redemptionAmts[3].token).to.eq(reserveTranches[0].address);
        expect(redemptionAmts[3].amount).to.eq(toFixedPtAmt("20"));
        expect(redemptionAmts[4].token).to.eq(perp.address);
        expect(redemptionAmts[4].amount).to.eq(0);
      });
    });

    describe("when vault has a combination of balances (full balance redemption)", function () {
      let redemptionAmts: [string, BigNumber][];
      beforeEach(async function () {
        await collateralToken.approve(vault.address, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));

        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.address, toFixedPtAmt("100"));
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));

        await vault.deploy();
        await collateralToken.transfer(vault.address, toFixedPtAmt("20"));
        await perp.transfer(vault.address, toFixedPtAmt("20"));

        redemptionAmts = await vault.callStatic.redeem(await vault.balanceOf(deployerAddress));
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
          [toFixedPtAmt("30"), toFixedPtAmt("-30")],
        );
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          rolloverInTranches[2],
          [deployer, vault],
          [toFixedPtAmt("50"), toFixedPtAmt("-50")],
        );
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          perp,
          [deployer, vault],
          [toFixedPtAmt("10"), toFixedPtAmt("-10")],
        );
      });

      it("should update vault", async function () {
        await checkVaultAssetComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1], rolloverInTranches[2], perp],
          [toFixedPtAmt("20"), toFixedPtAmt("40"), toFixedPtAmt("60"), toFixedPtAmt("100"), toFixedPtAmt("20")],
        );
        await vault.redeem(bal);
        await checkVaultAssetComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1], rolloverInTranches[2], perp],
          [toFixedPtAmt("10"), toFixedPtAmt("20"), toFixedPtAmt("30"), toFixedPtAmt("50"), toFixedPtAmt("10")],
        );
      });

      it("should burn users notes", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(vault, [deployer], [bal.mul("-1")]);
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100").mul("1000000"));
      });

      it("should return redemption amounts", async function () {
        expect(redemptionAmts.length).to.eq(5);
        expect(redemptionAmts[0].token).to.eq(collateralToken.address);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("10"));
        expect(redemptionAmts[1].token).to.eq(rolloverInTranches[2].address);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("50"));
        expect(redemptionAmts[2].token).to.eq(rolloverInTranches[1].address);
        expect(redemptionAmts[2].amount).to.eq(toFixedPtAmt("30"));
        expect(redemptionAmts[3].token).to.eq(reserveTranches[0].address);
        expect(redemptionAmts[3].amount).to.eq(toFixedPtAmt("20"));
        expect(redemptionAmts[4].token).to.eq(perp.address);
        expect(redemptionAmts[4].amount).to.eq(toFixedPtAmt("10"));
      });
    });

    describe("when vault has a combination of balances (partial balance redemption)", function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.address, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));

        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.address, toFixedPtAmt("100"));
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));

        await vault.deploy();
        await collateralToken.transfer(vault.address, toFixedPtAmt("20"));
        await perp.transfer(vault.address, toFixedPtAmt("20"));

        bal = toFixedPtAmt("50").mul("1000000");
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
          [toFixedPtAmt("15"), toFixedPtAmt("-15")],
        );
      });

      it("should transfer assets", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(
          rolloverInTranches[2],
          [deployer, vault],
          [toFixedPtAmt("25"), toFixedPtAmt("-25")],
        );
      });

      it("should update vault", async function () {
        await checkVaultAssetComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1], rolloverInTranches[2], perp],
          [toFixedPtAmt("20"), toFixedPtAmt("40"), toFixedPtAmt("60"), toFixedPtAmt("100"), toFixedPtAmt("20")],
        );
        await vault.redeem(bal);
        await checkVaultAssetComposition(
          vault,
          [collateralToken, reserveTranches[0], rolloverInTranches[1], rolloverInTranches[2], perp],
          [toFixedPtAmt("15"), toFixedPtAmt("30"), toFixedPtAmt("45"), toFixedPtAmt("75"), toFixedPtAmt("15")],
        );
      });

      it("should burn users notes", async function () {
        await expect(() => vault.redeem(bal)).to.changeTokenBalances(vault, [deployer], [bal.mul("-1")]);
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100").mul("1000000"));
      });

      it("should return redemption amounts", async function () {
        const redemptionAmts = await vault.callStatic.redeem(bal);
        expect(redemptionAmts.length).to.eq(5);
        expect(redemptionAmts[0].token).to.eq(collateralToken.address);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("5"));
        expect(redemptionAmts[1].token).to.eq(rolloverInTranches[2].address);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("25"));
        expect(redemptionAmts[2].token).to.eq(rolloverInTranches[1].address);
        expect(redemptionAmts[2].amount).to.eq(toFixedPtAmt("15"));
        expect(redemptionAmts[3].token).to.eq(reserveTranches[0].address);
        expect(redemptionAmts[3].amount).to.eq(toFixedPtAmt("10"));
        expect(redemptionAmts[4].token).to.eq(perp.address);
        expect(redemptionAmts[4].amount).to.eq(toFixedPtAmt("5"));
      });
    });
  });
});
