import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Transaction, Signer } from "ethers";
import {
  setupCollateralToken,
  setupBondFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  advancePerpQueue,
  advancePerpQueueUpToBondMaturity,
  checkPerpComposition,
  rebase,
  mintCollteralToken,
  mintPerps,
  redeemPerps,
  DMock,
} from "../helpers";

let perp: Contract,
  bondFactory: Contract,
  collateralToken: Contract,
  rebaseOracle: Contract,
  issuer: Contract,
  balancer: Contract,
  deployer: Signer,
  otherUser: Signer,
  deployerAddress: string,
  depositBond: Contract,
  initialDepositTranche: Contract;

describe("PerpetualTranche", function () {
  beforeEach(async function () {
    await network.provider.request({ method: "hardhat_reset" });

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];
    deployerAddress = await deployer.getAddress();

    bondFactory = await setupBondFactory();
    ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));

    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await upgrades.deployProxy(
      BondIssuer.connect(deployer),
      [bondFactory.target, collateralToken.target, 3600, [500, 500], 1200, 0],
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
    await perp.updateTolerableTrancheMaturity(1200, 3600);
    await advancePerpQueue(perp, 3600);
    await perp.updateState();

    balancer = new DMock(await ethers.getContractFactory("Balancer"));
    await balancer.deploy();
    await balancer.mockMethod("decimals()", [8]);

    await perp.updateBalancer(balancer.target);
    await perp.updateVault(deployerAddress);

    depositBond = await bondAt(await perp.depositBond());
    [initialDepositTranche] = await getTranches(depositBond);

    await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
    await mintPerps(perp, initialDepositTranche, toFixedPtAmt("500"), deployer);

    await mintCollteralToken(collateralToken, toFixedPtAmt("1000"), deployer);
  });

  afterEach(async function () {
    await network.provider.request({ method: "hardhat_reset" });
  });

  describe("#burn", function () {
    it("should burn tokens without redemption", async function () {
      await checkPerpComposition(perp, [collateralToken, initialDepositTranche], ["0", toFixedPtAmt("500")]);
      expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("500"));
      await perp.burn(toFixedPtAmt("500"));
      expect(await perp.balanceOf(deployerAddress)).to.eq("0");
      await checkPerpComposition(perp, [collateralToken, initialDepositTranche], ["0", toFixedPtAmt("500")]);
    });
  });

  describe("#burnFrom", function () {
    it("should burn tokens without redemption from authorized wallet", async function () {
      await checkPerpComposition(perp, [collateralToken, initialDepositTranche], ["0", toFixedPtAmt("500")]);
      expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("500"));
      await perp.approve(await otherUser.getAddress(), toFixedPtAmt("500"));
      await perp.connect(otherUser).burnFrom(deployerAddress, toFixedPtAmt("200"));
      expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("300"));
      expect(await perp.allowance(deployerAddress, await otherUser.getAddress())).to.eq(toFixedPtAmt("300"));
      await checkPerpComposition(perp, [collateralToken, initialDepositTranche], ["0", toFixedPtAmt("500")]);
    });
  });

  describe("#redeem", function () {
    describe("when paused", function () {
      beforeEach(async function () {
        await perp.pause();
      });

      it("should revert", async function () {
        await expect(redeemPerps(perp, toFixedPtAmt("500"), deployer)).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when user has insufficient balance", function () {
      beforeEach(async function () {
        await redeemPerps(perp, toFixedPtAmt("250"), deployer);
      });

      it("should revert", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.lte(toFixedPtAmt("500"));
        await expect(redeemPerps(perp, toFixedPtAmt("500"), deployer)).to.be.reverted;
      });
    });

    describe("when requested amount is zero", function () {
      it("should return without redeeming", async function () {
        expect(await perp.redeem.staticCall("0")).to.deep.eq([]);
      });
    });

    describe("when supply is zero", function () {
      beforeEach(async function () {
        await perp.burn(toFixedPtAmt("500"));
      });

      it("should revert", async function () {
        await expect(redeemPerps(perp, toFixedPtAmt("100"), deployer)).to.be.reverted;
      });

      it("should revert", async function () {
        await expect(perp.computeRedemptionAmts.staticCall(toFixedPtAmt("100"))).to.be.reverted;
      });
    });

    describe("on successful redeem", function () {
      it("should burn perp tokens", async function () {
        await expect(() => redeemPerps(perp, toFixedPtAmt("500"), deployer)).to.changeTokenBalance(
          perp,
          deployer,
          toFixedPtAmt("-500"),
        );
      });
      it("should transfer the tranches out", async function () {
        await expect(() => redeemPerps(perp, toFixedPtAmt("500"), deployer)).to.changeTokenBalances(
          initialDepositTranche,
          [deployer, perp],
          [toFixedPtAmt("500"), toFixedPtAmt("-500")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(redeemPerps(perp, toFixedPtAmt("500"), deployer))
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.target, "0")
          .to.emit(perp, "ReserveSynced")
          .withArgs(initialDepositTranche.target, "0");
      });
      it("should return the redemption amounts", async function () {
        const r = await perp.computeRedemptionAmts.staticCall(toFixedPtAmt("500"));
        expect(r[0].token).to.eq(collateralToken.target);
        expect(r[1].token).to.eq(initialDepositTranche.target);
        expect(r[0].amount).to.eq("0");
        expect(r[1].amount).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when reserve has more than one tranche", function () {
      let newRedemptionTranche: Contract, txFn: Promise<Transaction>;
      beforeEach(async function () {
        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.depositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await mintPerps(perp, newRedemptionTranche, toFixedPtAmt("500"), deployer);

        await checkPerpComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          ["0", toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        txFn = () => redeemPerps(perp, toFixedPtAmt("375"), deployer);
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkPerpComposition(
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
        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.depositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await mintPerps(perp, newRedemptionTranche, toFixedPtAmt("500"), deployer);

        await collateralToken.transfer(perp.target, toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("100"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        txFn = () => redeemPerps(perp, toFixedPtAmt("500"), deployer);
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkPerpComposition(
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
        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.depositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await mintPerps(perp, newRedemptionTranche, toFixedPtAmt("500"), deployer);

        await checkPerpComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          ["0", toFixedPtAmt("500"), toFixedPtAmt("500")],
        );

        await advancePerpQueue(perp, 2400);
        await rebase(collateralToken, rebaseOracle, +0.5);
        await checkPerpComposition(
          perp,
          [collateralToken, newRedemptionTranche],
          [toFixedPtAmt("750"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        txFn = () => redeemPerps(perp, toFixedPtAmt("375"), deployer);
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkPerpComposition(
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
        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.depositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await mintPerps(perp, newRedemptionTranche, toFixedPtAmt("500"), deployer);

        await checkPerpComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          ["0", toFixedPtAmt("500"), toFixedPtAmt("500")],
        );

        await advancePerpQueue(perp, 2400);
        await rebase(collateralToken, rebaseOracle, -0.5);
        await checkPerpComposition(
          perp,
          [collateralToken, newRedemptionTranche],
          [toFixedPtAmt("250"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        txFn = () => redeemPerps(perp, toFixedPtAmt("375"), deployer);
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkPerpComposition(
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
        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.depositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await mintPerps(perp, newRedemptionTranche, toFixedPtAmt("500"), deployer);

        await checkPerpComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          ["0", toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        await advancePerpQueue(perp, 7200);

        await checkPerpComposition(perp, [collateralToken], [toFixedPtAmt("1000")]);
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        txFn = () => redeemPerps(perp, toFixedPtAmt("375"), deployer);
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkPerpComposition(perp, [collateralToken], [toFixedPtAmt("625")]);
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
        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.depositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await mintPerps(perp, newRedemptionTranche, toFixedPtAmt("500"), deployer);

        await checkPerpComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          ["0", toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        const bal = await perp.balanceOf(deployerAddress);
        txFn = () => redeemPerps(perp, bal, deployer);
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkPerpComposition(perp, [collateralToken], ["0"]);
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

    describe("when redeeming a tranche which has matured but has not been recovered", function () {
      let newRedemptionTranche: Contract, txFn: Promise<Transaction>;
      beforeEach(async function () {
        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.depositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await mintPerps(perp, newRedemptionTranche, toFixedPtAmt("500"), deployer);

        await collateralToken.transfer(perp.target, toFixedPtAmt("100"));
        await checkPerpComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("100"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("1000"));

        await advancePerpQueueUpToBondMaturity(perp, depositBond);
        txFn = () => redeemPerps(perp, toFixedPtAmt("500"), deployer);
      });

      it("should update the reserve composition", async function () {
        await txFn();
        await checkPerpComposition(
          perp,
          [collateralToken, newRedemptionTranche],
          [toFixedPtAmt("300"), toFixedPtAmt("250")],
        );
      });
      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          collateralToken,
          [deployer, perp],
          [toFixedPtAmt("300"), toFixedPtAmt("200")],
        );
      });

      it("should transfer tokens out", async function () {
        await expect(txFn).to.changeTokenBalances(
          initialDepositTranche,
          [deployer, perp],
          [toFixedPtAmt("0"), toFixedPtAmt("-500")],
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
  });
});
