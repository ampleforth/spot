import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer, Transaction, constants, BigNumber } from "ethers";
import { smock } from "@defi-wonderland/smock";

import {
  setupCollateralToken,
  mintCollteralToken,
  setupBondFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toDiscountFixedPtAmt,
  toPriceFixedPtAmt,
  getDepositBond,
  advancePerpQueue,
  advancePerpQueueToBondMaturity,
  checkReserveComposition,
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
let discountStrategy: Contract;

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

    const FeeStrategy = await ethers.getContractFactory("BasicFeeStrategy");
    feeStrategy = await smock.fake(FeeStrategy);
    await feeStrategy.computeMintFees.returns(["0", "0"]);
    await feeStrategy.computeBurnFees.returns(["0", "0"]);
    await feeStrategy.computeRolloverFees.returns(["0", "0"]);

    const PricingStrategy = await ethers.getContractFactory("UnitPricingStrategy");
    pricingStrategy = await smock.fake(PricingStrategy);
    await pricingStrategy.decimals.returns(8);
    await pricingStrategy.computeMatureTranchePrice.returns(toPriceFixedPtAmt("1"));
    await pricingStrategy.computeTranchePrice.returns(toPriceFixedPtAmt("1"));

    const DiscountStrategy = await ethers.getContractFactory("TrancheClassDiscountStrategy");
    discountStrategy = await smock.fake(DiscountStrategy);
    await discountStrategy.decimals.returns(18);
    await discountStrategy.computeTrancheDiscount
      .whenCalledWith(collateralToken.address)
      .returns(toDiscountFixedPtAmt("1"));

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
        discountStrategy.address,
      ],
      {
        initializer: "init(string,string,address,address,address,address,address)",
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

      await pricingStrategy.computeTranchePrice.whenCalledWith(tranches[0].address).returns(toPriceFixedPtAmt("1"));
      await discountStrategy.computeTrancheDiscount
        .whenCalledWith(tranches[0].address)
        .returns(toDiscountFixedPtAmt("1"));
      await tranches[0].approve(perp.address, toFixedPtAmt("200"));
      await perp.deposit(tranches[0].address, toFixedPtAmt("200"));

      await pricingStrategy.computeTranchePrice.whenCalledWith(tranches[1].address).returns(toPriceFixedPtAmt("1"));
      await discountStrategy.computeTrancheDiscount
        .whenCalledWith(tranches[1].address)
        .returns(toDiscountFixedPtAmt("1"));
      await tranches[1].approve(perp.address, toFixedPtAmt("300"));
      await perp.deposit(tranches[1].address, toFixedPtAmt("300"));

      reserveTranches.push(tranches[0]);
      reserveTranches.push(tranches[1]);
      await advancePerpQueue(perp, 1200);
    }

    await checkReserveComposition(
      perp,
      [collateralToken, ...reserveTranches],
      [
        toFixedPtAmt("0"),
        toFixedPtAmt("200"),
        toFixedPtAmt("300"),
        toFixedPtAmt("200"),
        toFixedPtAmt("300"),
        toFixedPtAmt("200"),
        toFixedPtAmt("300"),
      ],
    );

    rolloverInBond = await bondAt(await perp.callStatic.getDepositBond());
    rolloverInTranches = await getTranches(rolloverInBond);
    await pricingStrategy.computeTranchePrice
      .whenCalledWith(rolloverInTranches[0].address)
      .returns(toPriceFixedPtAmt("1"));
    await discountStrategy.computeTrancheDiscount
      .whenCalledWith(rolloverInTranches[0].address)
      .returns(toDiscountFixedPtAmt("1"));
    await pricingStrategy.computeTranchePrice
      .whenCalledWith(rolloverInTranches[1].address)
      .returns(toPriceFixedPtAmt("1"));
    await discountStrategy.computeTrancheDiscount
      .whenCalledWith(rolloverInTranches[1].address)
      .returns(toDiscountFixedPtAmt("0"));
    await pricingStrategy.computeTranchePrice
      .whenCalledWith(rolloverInTranches[2].address)
      .returns(toPriceFixedPtAmt("1"));
    await discountStrategy.computeTrancheDiscount
      .whenCalledWith(rolloverInTranches[2].address)
      .returns(toDiscountFixedPtAmt("0"));

    await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    vault = await upgrades.deployProxy(RolloverVault.connect(deployer));
    await collateralToken.approve(vault.address, toFixedPtAmt("1"));
    await vault.init("RolloverVault", "VSHARE", perp.address);

    expect(await vault.deployedCount()).to.eq(0);
    expect(await vault.vaultAssetBalance(await vault.underlying())).to.eq(0);
    expect(await vault.vaultAssetBalance(await vault.earnedAt(0))).to.eq(0);
  });

  describe("get asset value", function () {
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
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(rolloverInTranches[1].address)
          .returns(toDiscountFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(rolloverInTranches[2].address)
          .returns(toDiscountFixedPtAmt("1"));
        await vault.deploy();
        expect(await vault.vaultAssetBalance(await vault.underlying())).to.eq(0);
        expect(await vault.deployedCount()).to.eq(1);
      });
      it("should return tvl", async function () {
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("100"));
      });
      it("should return asset value", async function () {
        expect(await vault.callStatic.getVaultAssetValue(collateralToken.address)).to.eq(0);
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[0].address)).to.eq(toFixedPtAmt("100"));
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
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[1].address)).to.eq(toFixedPtAmt("200"));
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
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[1].address)).to.eq(toFixedPtAmt("200"));
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
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[1].address)).to.eq(toFixedPtAmt("200"));
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
          .whenCalledWith(reserveTranches[3].address)
          .returns(toPriceFixedPtAmt("0"));
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(reserveTranches[4].address)
          .returns(toPriceFixedPtAmt("0.5"));
        await pricingStrategy.computeTranchePrice
          .whenCalledWith(reserveTranches[5].address)
          .returns(toPriceFixedPtAmt("0"));
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
        expect(await vault.callStatic.getTVL()).to.eq(toFixedPtAmt("390"));
      });

      it("should return asset value", async function () {
        expect(await vault.callStatic.getVaultAssetValue(collateralToken.address)).to.eq(toFixedPtAmt("10"));
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[0].address)).to.eq(toFixedPtAmt("100"));
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[1].address)).to.eq(toFixedPtAmt("0"));
        expect(await vault.callStatic.getVaultAssetValue(reserveTranches[2].address)).to.eq(toFixedPtAmt("0"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[0].address)).to.eq(toFixedPtAmt("250"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[1].address)).to.eq(toFixedPtAmt("0"));
        expect(await vault.callStatic.getVaultAssetValue(rolloverInTranches[2].address)).to.eq(toFixedPtAmt("0"));
        expect(await vault.callStatic.getVaultAssetValue(perp.address)).to.eq(toFixedPtAmt("30"));
      });
    });
  });

  describe("#deposit", function () {
    let tx: Transaction, noteAmt: BigNumber;

    describe("when total supply = 0", async function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.address, toFixedPtAmt("100"));
        noteAmt = await vault.callStatic.deposit(toFixedPtAmt("100"));
        tx = vault.deposit(toFixedPtAmt("100"));
        await tx;
      });
      it("should transfer underlying", async function () {
        await expect(tx)
          .to.emit(collateralToken, "Transfer")
          .withArgs(deployerAddress, vault.address, toFixedPtAmt("100"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("100"));
      });
      it("should mint notes", async function () {
        await expect(tx)
          .to.emit(vault, "Transfer")
          .withArgs(constants.AddressZero, deployerAddress, toFixedPtAmt("100").mul("1000000"));
        expect(await vault.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("100").mul("1000000"));
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
        tx = vault.connect(otherUser).deposit(toFixedPtAmt("100"));
        await tx;
      });
      it("should transfer underlying", async function () {
        await expect(tx)
          .to.emit(collateralToken, "Transfer")
          .withArgs(otherUserAddress, vault.address, toFixedPtAmt("100"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("200"));
      });
      it("should mint notes", async function () {
        await expect(tx)
          .to.emit(vault, "Transfer")
          .withArgs(constants.AddressZero, otherUserAddress, toFixedPtAmt("100").mul("1000000"));
        expect(await vault.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("100").mul("1000000"));
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100").mul("1000000"));
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
        tx = vault.connect(otherUser).deposit(toFixedPtAmt("100"));
        await tx;
      });
      it("should transfer underlying", async function () {
        await expect(tx)
          .to.emit(collateralToken, "Transfer")
          .withArgs(otherUserAddress, vault.address, toFixedPtAmt("100"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("300"));
      });
      it("should mint notes", async function () {
        await expect(tx)
          .to.emit(vault, "Transfer")
          .withArgs(constants.AddressZero, otherUserAddress, toFixedPtAmt("100").mul("500000"));
        expect(await vault.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("100").mul("1000000"));
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100").mul("500000"));
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
        tx = vault.connect(otherUser).deposit(toFixedPtAmt("100"));
        await tx;
      });
      it("should transfer underlying", async function () {
        await expect(tx)
          .to.emit(collateralToken, "Transfer")
          .withArgs(otherUserAddress, vault.address, toFixedPtAmt("100"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("150"));
      });
      it("should mint notes", async function () {
        await expect(tx)
          .to.emit(vault, "Transfer")
          .withArgs(constants.AddressZero, otherUserAddress, toFixedPtAmt("100").mul("2000000"));
        expect(await vault.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("100").mul("1000000"));
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100").mul("2000000"));
      });
      it("should return the note amount", async function () {
        expect(noteAmt).to.eq(toFixedPtAmt("100").mul("2000000"));
      });
    });
  });

  describe("#redeem", function () {
    let tx: Transaction, redemptionAmts: [string, BigNumber][];
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

        redemptionAmts = await vault.callStatic.redeem(await vault.balanceOf(deployerAddress));
        tx = vault.redeem(await vault.balanceOf(deployerAddress));
        await tx;
      });
      it("should transfer assets", async function () {
        await expect(tx)
          .to.emit(collateralToken, "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("100"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("100"));
      });
      it("should burn notes", async function () {
        await expect(tx)
          .to.emit(vault, "Transfer")
          .withArgs(deployerAddress, constants.AddressZero, toFixedPtAmt("100").mul("1000000"));
        expect(await vault.balanceOf(deployerAddress)).to.eq(0);
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100").mul("1000000"));
      });
      it("should return redemption amounts", async function () {
        expect(redemptionAmts.length).to.eq(2);
        expect(redemptionAmts[0].token).to.eq(collateralToken.address);
        expect(redemptionAmts[0].amount).to.eq(toFixedPtAmt("100"));
        expect(redemptionAmts[1].token).to.eq(perp.address);
        expect(redemptionAmts[1].amount).to.eq(0);
      });
    });

    describe("when vault has only deployed balance", function () {
      beforeEach(async function () {
        await collateralToken.approve(vault.address, toFixedPtAmt("100"));
        await vault.deposit(toFixedPtAmt("100"));

        await collateralToken.transfer(otherUserAddress, toFixedPtAmt("100"));
        await collateralToken.connect(otherUser).approve(vault.address, toFixedPtAmt("100"));
        await vault.connect(otherUser).deposit(toFixedPtAmt("100"));

        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(rolloverInTranches[1].address)
          .returns(toDiscountFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(rolloverInTranches[2].address)
          .returns(toDiscountFixedPtAmt("1"));
        await vault.deploy();

        expect(await vault.vaultAssetBalance(await vault.underlying())).to.eq(0);
        expect(await vault.deployedCount()).to.eq(1);

        redemptionAmts = await vault.callStatic.redeem(await vault.balanceOf(deployerAddress));
        tx = vault.redeem(await vault.balanceOf(deployerAddress));
        await tx;
      });
      it("should transfer assets", async function () {
        await expect(tx)
          .to.emit(reserveTranches[0], "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("100"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(reserveTranches[0].address, toFixedPtAmt("100"));
      });
      it("should burn notes", async function () {
        await expect(tx)
          .to.emit(vault, "Transfer")
          .withArgs(deployerAddress, constants.AddressZero, toFixedPtAmt("100").mul("1000000"));
        expect(await vault.balanceOf(deployerAddress)).to.eq(0);
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100").mul("1000000"));
      });
      it("should return redemption amounts", async function () {
        expect(redemptionAmts.length).to.eq(3);
        expect(redemptionAmts[0].token).to.eq(collateralToken.address);
        expect(redemptionAmts[0].amount).to.eq(0);
        expect(redemptionAmts[1].token).to.eq(reserveTranches[0].address);
        expect(redemptionAmts[1].amount).to.eq(toFixedPtAmt("100"));
        expect(redemptionAmts[2].token).to.eq(perp.address);
        expect(redemptionAmts[2].amount).to.eq(0);
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
        tx = vault.redeem(await vault.balanceOf(deployerAddress));
        await tx;
      });
      it("should transfer assets", async function () {
        await expect(tx)
          .to.emit(collateralToken, "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("10"));
        await expect(tx)
          .to.emit(reserveTranches[0], "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("20"));
        await expect(tx)
          .to.emit(rolloverInTranches[1], "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("30"));
        await expect(tx)
          .to.emit(rolloverInTranches[2], "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("50"));
        await expect(tx).to.emit(perp, "Transfer").withArgs(vault.address, deployerAddress, toFixedPtAmt("10"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("10"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(reserveTranches[0].address, toFixedPtAmt("20"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(rolloverInTranches[1].address, toFixedPtAmt("30"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(rolloverInTranches[2].address, toFixedPtAmt("50"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(perp.address, toFixedPtAmt("10"));
      });
      it("should burn notes", async function () {
        await expect(tx)
          .to.emit(vault, "Transfer")
          .withArgs(deployerAddress, constants.AddressZero, toFixedPtAmt("100").mul("1000000"));
        expect(await vault.balanceOf(deployerAddress)).to.eq(0);
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

        redemptionAmts = await vault.callStatic.redeem(toFixedPtAmt("50").mul("1000000"));
        tx = vault.redeem(toFixedPtAmt("50").mul("1000000"));
        await tx;
      });
      it("should transfer assets", async function () {
        await expect(tx)
          .to.emit(collateralToken, "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("5"));
        await expect(tx)
          .to.emit(reserveTranches[0], "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("10"));
        await expect(tx)
          .to.emit(rolloverInTranches[1], "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("15"));
        await expect(tx)
          .to.emit(rolloverInTranches[2], "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("25"));
        await expect(tx).to.emit(perp, "Transfer").withArgs(vault.address, deployerAddress, toFixedPtAmt("5"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, toFixedPtAmt("15"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(reserveTranches[0].address, toFixedPtAmt("30"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(rolloverInTranches[1].address, toFixedPtAmt("45"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(rolloverInTranches[2].address, toFixedPtAmt("75"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(perp.address, toFixedPtAmt("15"));
      });
      it("should burn notes", async function () {
        await expect(tx)
          .to.emit(vault, "Transfer")
          .withArgs(deployerAddress, constants.AddressZero, toFixedPtAmt("50").mul("1000000"));
        expect(await vault.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("50").mul("1000000"));
        expect(await vault.balanceOf(otherUserAddress)).to.eq(toFixedPtAmt("100").mul("1000000"));
      });
      it("should return redemption amounts", async function () {
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

    describe("when vault has a combination of balances (full supply redemption)", function () {
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

        await vault.connect(otherUser).redeem(await vault.balanceOf(otherUserAddress));
        redemptionAmts = await vault.callStatic.redeem(await vault.balanceOf(deployerAddress));
        tx = vault.redeem(await vault.balanceOf(deployerAddress));
        await tx;
      });
      it("should transfer assets", async function () {
        await expect(tx)
          .to.emit(collateralToken, "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("10"));
        await expect(tx)
          .to.emit(reserveTranches[0], "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("20"));
        await expect(tx)
          .to.emit(rolloverInTranches[1], "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("30"));
        await expect(tx)
          .to.emit(rolloverInTranches[2], "Transfer")
          .withArgs(vault.address, deployerAddress, toFixedPtAmt("50"));
        await expect(tx).to.emit(perp, "Transfer").withArgs(vault.address, deployerAddress, toFixedPtAmt("10"));
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(collateralToken.address, "0");
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(reserveTranches[0].address, "0");
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(rolloverInTranches[1].address, "0");
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(rolloverInTranches[2].address, "0");
        await expect(tx).to.emit(vault, "AssetSynced").withArgs(perp.address, "0");
      });
      it("should burn notes", async function () {
        await expect(tx)
          .to.emit(vault, "Transfer")
          .withArgs(deployerAddress, constants.AddressZero, toFixedPtAmt("100").mul("1000000"));
        expect(await vault.balanceOf(deployerAddress)).to.eq(0);
        expect(await vault.balanceOf(otherUserAddress)).to.eq(0);
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
  });
});
