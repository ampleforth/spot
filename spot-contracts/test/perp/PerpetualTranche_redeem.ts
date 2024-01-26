import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Transaction, Signer } from "ethers";
import { smock } from "@defi-wonderland/smock";
import {
  setupCollateralToken,
  setupBondFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toPercFixedPtAmt,
  toFixedPtAmt,
  advancePerpQueue,
  checkReserveComposition,
  rebase,
  mintCollteralToken,
} from "../helpers";
use(smock.matchers);

let perp: Contract,
  bondFactory: Contract,
  collateralToken: Contract,
  rebaseOracle: Contract,
  issuer: Contract,
  feePolicy: Contract,
  deployer: Signer,
  otherUser: Signer,
  deployerAddress: string,
  depositBond: Contract,
  initialDepositTranche: Contract;

describe("PerpetualTranche", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];
    deployerAddress = await deployer.getAddress();

    bondFactory = await setupBondFactory();
    ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));
    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
    await issuer.init(3600, [500, 500], 1200, 0);

    const FeePolicy = await ethers.getContractFactory("FeePolicy");
    feePolicy = await smock.fake(FeePolicy);
    await feePolicy.decimals.returns(8);

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await upgrades.deployProxy(
      PerpetualTranche.connect(deployer),
      ["PerpetualTranche", "PERP", collateralToken.address, issuer.address, feePolicy.address],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );
    await advancePerpQueue(perp, 3600);

    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    const vault = await smock.fake(RolloverVault);
    await vault.getTVL.returns("0");
    await perp.updateVault(vault.address);

    depositBond = await bondAt(await perp.callStatic.getDepositBond());
    [initialDepositTranche] = await getTranches(depositBond);

    await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
    await initialDepositTranche.approve(perp.address, toFixedPtAmt("500"));
    await perp.deposit(initialDepositTranche.address, toFixedPtAmt("500"));
    await feePolicy.computePerpBurnFeePerc.returns("0");
    await mintCollteralToken(collateralToken, toFixedPtAmt("1000"), deployer);
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#burn", function () {
    it("should burn tokens without redemption", async function () {
      await checkReserveComposition(perp, [collateralToken, initialDepositTranche], ["0", toFixedPtAmt("500")]);
      expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("500"));
      await perp.burn(toFixedPtAmt("500"));
      expect(await perp.balanceOf(deployerAddress)).to.eq("0");
      await checkReserveComposition(perp, [collateralToken, initialDepositTranche], ["0", toFixedPtAmt("500")]);
    });
  });

  describe("#burnFrom", function () {
    it("should burn tokens without redemption from authorized wallet", async function () {
      await checkReserveComposition(perp, [collateralToken, initialDepositTranche], ["0", toFixedPtAmt("500")]);
      expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("500"));
      await perp.approve(await otherUser.getAddress(), toFixedPtAmt("500"));
      await perp.connect(otherUser).burnFrom(deployerAddress, toFixedPtAmt("200"));
      expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("300"));
      expect(await perp.allowance(deployerAddress, await otherUser.getAddress())).to.eq(toFixedPtAmt("300"));
      await checkReserveComposition(perp, [collateralToken, initialDepositTranche], ["0", toFixedPtAmt("500")]);
    });
  });

  describe("#redeem", function () {
    describe("when paused", function () {
      beforeEach(async function () {
        await perp.updateKeeper(deployerAddress);
        await perp.pause();
      });

      it("should revert", async function () {
        await expect(perp.redeem(toFixedPtAmt("500"))).to.revertedWith("Pausable: paused");
      });
    });

    describe("when user has insufficient balance", function () {
      beforeEach(async function () {
        await perp.redeem(toFixedPtAmt("250"));
      });

      it("should revert", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.lte(toFixedPtAmt("500"));
        await expect(perp.redeem(toFixedPtAmt("500"))).to.revertedWithCustomError(perp, "UnacceptableRedemption");
      });
    });

    describe("when requested amount is zero", function () {
      it("should revert", async function () {
        await expect(perp.redeem("0")).to.revertedWithCustomError(perp, "UnacceptableRedemption");
      });
    });

    describe("when supply is zero", function () {
      beforeEach(async function () {
        await perp.burn(toFixedPtAmt("500"));
      });

      it("should revert", async function () {
        await expect(perp.redeem(toFixedPtAmt("100"))).to.revertedWithCustomError(perp, "UnacceptableRedemption");
      });

      it("should return 0", async function () {
        const r = await perp.callStatic.computeRedemptionAmts(toFixedPtAmt("100"));
        await expect(r[1][0]).to.eq("0");
        await expect(r[1][1]).to.eq("0");
      });
    });

    describe("on successful redeem", function () {
      it("should burn perp tokens", async function () {
        await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(
          perp,
          deployer,
          toFixedPtAmt("-500"),
        );
      });
      it("should transfer the tranches out", async function () {
        await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalances(
          initialDepositTranche,
          [deployer, perp],
          [toFixedPtAmt("500"), toFixedPtAmt("-500")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(perp.redeem(toFixedPtAmt("500")))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, "0")
          .to.emit(perp, "ReserveSynced")
          .withArgs(initialDepositTranche.address, "0");
      });
      it("should return the redemption amounts", async function () {
        const r = await perp.callStatic.redeem(toFixedPtAmt("500"));
        expect(r[0][0]).to.eq(collateralToken.address);
        expect(r[0][1]).to.eq(initialDepositTranche.address);
        expect(r[1][0]).to.eq("0");
        expect(r[1][1]).to.eq(toFixedPtAmt("500"));
      });
      it("should return the redemption amounts", async function () {
        const r = await perp.callStatic.computeRedemptionAmts(toFixedPtAmt("500"));
        expect(r[0][0]).to.eq(collateralToken.address);
        expect(r[0][1]).to.eq(initialDepositTranche.address);
        expect(r[1][0]).to.eq("0");
        expect(r[1][1]).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when reserve has more than one tranche", function () {
      let newRedemptionTranche: Contract, txFn: Promise<Transaction>;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturity(1200, 3600);

        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          ["0", toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        txFn = () => perp.redeem(toFixedPtAmt("375"));
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          ["0", toFixedPtAmt("312.5"), toFixedPtAmt("312.5")],
        );
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer, perp], ["0", "0"]);
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          initialDepositTranche,
          [deployer, perp],
          [toFixedPtAmt("187.5"), toFixedPtAmt("-187.5")],
        );
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          newRedemptionTranche,
          [deployer, perp],
          [toFixedPtAmt("187.5"), toFixedPtAmt("-187.5")],
        );
      });

      it("should update the total supply", async function () {
        await txFn();
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("625"));
      });

      it("should burn perp tokens", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-375")]);
      });
    });

    describe("when reserve has mature collateral and tranches", function () {
      let newRedemptionTranche: Contract, txFn: Promise<Transaction>;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturity(1200, 3600);
        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        await collateralToken.transfer(perp.address, toFixedPtAmt("100"));
        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("100"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        txFn = () => perp.redeem(toFixedPtAmt("500"));
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("50"), toFixedPtAmt("250"), toFixedPtAmt("250")],
        );
      });
      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          collateralToken,
          [deployer, perp],
          [toFixedPtAmt("50"), toFixedPtAmt("-50")],
        );
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          initialDepositTranche,
          [deployer, perp],
          [toFixedPtAmt("250"), toFixedPtAmt("-250")],
        );
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          newRedemptionTranche,
          [deployer, perp],
          [toFixedPtAmt("250"), toFixedPtAmt("-250")],
        );
      });

      it("should update the total supply", async function () {
        await txFn();
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("500"));
      });

      it("should burn perp tokens", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-500")]);
      });
    });

    describe("when the collateralToken balance has rebased up", function () {
      let newRedemptionTranche: Contract, txFn: Promise<Transaction>;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturity(1200, 3600);

        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          ["0", toFixedPtAmt("500"), toFixedPtAmt("500")],
        );

        await advancePerpQueue(perp, 2400);
        await rebase(collateralToken, rebaseOracle, +0.5);
        await checkReserveComposition(
          perp,
          [collateralToken, newRedemptionTranche],
          [toFixedPtAmt("750"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        txFn = () => perp.redeem(toFixedPtAmt("375"));
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkReserveComposition(
          perp,
          [collateralToken, newRedemptionTranche],
          [toFixedPtAmt("468.75"), toFixedPtAmt("312.5")],
        );
      });
      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          collateralToken,
          [deployer, perp],
          [toFixedPtAmt("281.25"), toFixedPtAmt("-281.25")],
        );
      });
      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          newRedemptionTranche,
          [deployer, perp],
          [toFixedPtAmt("187.5"), toFixedPtAmt("-187.5")],
        );
      });
      it("should update the total supply", async function () {
        await txFn();
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("625"));
      });
      it("should burn perp tokens", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-375")]);
      });
    });

    describe("when the collateralToken balance has rebased down", function () {
      let newRedemptionTranche: Contract, txFn: Promise<Transaction>;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturity(1200, 3600);

        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          ["0", toFixedPtAmt("500"), toFixedPtAmt("500")],
        );

        await advancePerpQueue(perp, 2400);
        await rebase(collateralToken, rebaseOracle, -0.5);
        await checkReserveComposition(
          perp,
          [collateralToken, newRedemptionTranche],
          [toFixedPtAmt("250"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        txFn = () => perp.redeem(toFixedPtAmt("375"));
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkReserveComposition(
          perp,
          [collateralToken, newRedemptionTranche],
          [toFixedPtAmt("156.25"), toFixedPtAmt("312.5")],
        );
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          collateralToken,
          [deployer, perp],
          [toFixedPtAmt("93.75"), toFixedPtAmt("-93.75")],
        );
      });

      it("should update the total supply", async function () {
        await txFn();
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("625"));
      });

      it("should burn perp tokens", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-375")]);
      });
    });

    describe("when reserve has only mature collateral", function () {
      let newRedemptionTranche: Contract, txFn: Promise<Transaction>;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturity(1200, 3600);

        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          ["0", toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        await advancePerpQueue(perp, 7200);

        await checkReserveComposition(perp, [collateralToken], [toFixedPtAmt("1000")]);
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        txFn = () => perp.redeem(toFixedPtAmt("375"));
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkReserveComposition(perp, [collateralToken], [toFixedPtAmt("625")]);
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          collateralToken,
          [deployer, perp],
          [toFixedPtAmt("375"), toFixedPtAmt("-375")],
        );
      });

      it("should update the total supply", async function () {
        await txFn();
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("625"));
      });

      it("should burn perp tokens", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-375")]);
      });
    });

    describe("when redeeming entire supply", function () {
      let newRedemptionTranche: Contract, txFn: Promise<Transaction>;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturity(1200, 3600);

        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          ["0", toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        const bal = await perp.balanceOf(deployerAddress);
        txFn = () => perp.redeem(bal);
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkReserveComposition(perp, [collateralToken], ["0"]);
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(collateralToken, [deployer, perp], ["0", "0"]);
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          initialDepositTranche,
          [deployer, perp],
          [toFixedPtAmt("500"), toFixedPtAmt("-500")],
        );
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          newRedemptionTranche,
          [deployer, perp],
          [toFixedPtAmt("500"), toFixedPtAmt("-500")],
        );
      });

      it("should update the total supply", async function () {
        await txFn();
        expect(await perp.totalSupply()).to.eq("0");
      });

      it("should burn perp tokens", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-1000")]);
      });
    });

    describe("when fee is set", function () {
      let newRedemptionTranche: Contract, txFn: Promise<Transaction>;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturity(1200, 3600);
        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        await collateralToken.transfer(perp.address, toFixedPtAmt("100"));
        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("100"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        await feePolicy.computePerpBurnFeePerc.returns(toPercFixedPtAmt("0.1"));
        txFn = () => perp.redeem(toFixedPtAmt("500"));
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("55"), toFixedPtAmt("275"), toFixedPtAmt("275")],
        );
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          collateralToken,
          [deployer, perp],
          [toFixedPtAmt("45"), toFixedPtAmt("-45")],
        );
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          initialDepositTranche,
          [deployer, perp],
          [toFixedPtAmt("225"), toFixedPtAmt("-225")],
        );
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          newRedemptionTranche,
          [deployer, perp],
          [toFixedPtAmt("225"), toFixedPtAmt("-225")],
        );
      });

      it("should update the total supply", async function () {
        await txFn();
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("500"));
      });

      it("should burn perp tokens", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-500")]);
      });
    });

    describe("when fee is set and caller is vault", function () {
      let newRedemptionTranche: Contract, txFn: Promise<Transaction>, mockVault: Contract;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturity(1200, 3600);
        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        await collateralToken.transfer(perp.address, toFixedPtAmt("100"));
        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("100"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));
        await feePolicy.computePerpBurnFeePerc.returns(toPercFixedPtAmt("1"));

        const MockVault = await ethers.getContractFactory("MockVault");
        mockVault = await MockVault.deploy();
        await perp.updateVault(mockVault.address);
        await perp.approve(mockVault.address, toFixedPtAmt("500"));
        txFn = () => mockVault.redeemPerps(perp.address, toFixedPtAmt("500"));
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("50"), toFixedPtAmt("250"), toFixedPtAmt("250")],
        );
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          collateralToken,
          [deployer, perp],
          [toFixedPtAmt("50"), toFixedPtAmt("-50")],
        );
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          initialDepositTranche,
          [deployer, perp],
          [toFixedPtAmt("250"), toFixedPtAmt("-250")],
        );
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          newRedemptionTranche,
          [deployer, perp],
          [toFixedPtAmt("250"), toFixedPtAmt("-250")],
        );
      });

      it("should update the total supply", async function () {
        await txFn();
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("500"));
      });

      it("should burn perp tokens", async function () {
        await expect(txFn).to.changeTokenBalances(perp, [deployer], [toFixedPtAmt("-500")]);
      });

      it("should return the redemption amounts", async function () {
        const r = await mockVault.callStatic.computePerpRedemptionAmts(perp.address, toFixedPtAmt("500"));
        expect(r[0][0]).to.eq(collateralToken.address);
        expect(r[0][1]).to.eq(initialDepositTranche.address);
        expect(r[0][2]).to.eq(newRedemptionTranche.address);
        expect(r[1][0]).to.eq(toFixedPtAmt("50"));
        expect(r[1][1]).to.eq(toFixedPtAmt("250"));
        expect(r[1][2]).to.eq(toFixedPtAmt("250"));
      });
    });
  });
});
