import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Transaction, Signer, constants } from "ethers";

import {
  setupCollateralToken,
  setupBondFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toDiscountFixedPtAmt,
  toPriceFixedPtAmt,
  advancePerpQueue,
  checkReserveComposition,
  rebase,
} from "./helpers";

let perp: Contract,
  bondFactory: Contract,
  collateralToken: Contract,
  rebaseOracle: Contract,
  issuer: Contract,
  feeStrategy: Contract,
  pricingStrategy: Contract,
  discountStrategy: Contract,
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

    const FeeStrategy = await ethers.getContractFactory("MockFeeStrategy");
    feeStrategy = await FeeStrategy.deploy();

    const PricingStrategy = await ethers.getContractFactory("MockPricingStrategy");
    pricingStrategy = await PricingStrategy.deploy();

    const DiscountStrategy = await ethers.getContractFactory("MockDiscountStrategy");
    discountStrategy = await DiscountStrategy.deploy();

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
    await advancePerpQueue(perp, 3600);

    depositBond = await bondAt(await perp.callStatic.getDepositBond());
    [initialDepositTranche] = await getTranches(depositBond);

    await feeStrategy.setFeeToken(perp.address);
    await feeStrategy.setMintFee(toFixedPtAmt("0"));
    await pricingStrategy.setTranchePrice(initialDepositTranche.address, toPriceFixedPtAmt("1"));
    await discountStrategy.setTrancheDiscount(initialDepositTranche.address, toDiscountFixedPtAmt("1"));

    await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
    await initialDepositTranche.approve(perp.address, toFixedPtAmt("500"));
    await perp.deposit(initialDepositTranche.address, toFixedPtAmt("500"));
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#burn", function () {
    it("should burn tokens without redemption", async function () {
      await checkReserveComposition(
        perp,
        [collateralToken, initialDepositTranche],
        [toFixedPtAmt("0"), toFixedPtAmt("500")],
      );
      expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("500"));
      await perp.burn(toFixedPtAmt("500"));
      expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("0"));
      await checkReserveComposition(
        perp,
        [collateralToken, initialDepositTranche],
        [toFixedPtAmt("0"), toFixedPtAmt("500")],
      );
    });
  });

  describe("#burnFrom", function () {
    it("should burn tokens without redemption from authorized wallet", async function () {
      await checkReserveComposition(
        perp,
        [collateralToken, initialDepositTranche],
        [toFixedPtAmt("0"), toFixedPtAmt("500")],
      );
      expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("500"));
      await perp.approve(await otherUser.getAddress(), toFixedPtAmt("500"));
      await perp.connect(otherUser).burnFrom(deployerAddress, toFixedPtAmt("200"));
      expect(await perp.balanceOf(deployerAddress)).to.eq(toFixedPtAmt("300"));
      expect(await perp.allowance(deployerAddress, await otherUser.getAddress())).to.eq(toFixedPtAmt("300"));
      await checkReserveComposition(
        perp,
        [collateralToken, initialDepositTranche],
        [toFixedPtAmt("0"), toFixedPtAmt("500")],
      );
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
        await expect(perp.redeem(toFixedPtAmt("500"))).to.revertedWith(
          "UnacceptableBurnAmt(500000000000000000000, 250000000000000000000)",
        );
      });
    });

    describe("when requested amount is zero", function () {
      it("should revert", async function () {
        await expect(perp.redeem(toFixedPtAmt("0"))).to.revertedWith("UnacceptableBurnAmt(0, 500000000000000000000)");
      });
    });

    describe("when supply is zero", function () {
      beforeEach(async function () {
        await perp.burn(toFixedPtAmt("500"));
      });

      it("should revert", async function () {
        await expect(perp.redeem(toFixedPtAmt("100"))).to.revertedWith("UnacceptableBurnAmt(100000000000000000000, 0)");
      });

      it("should return 0", async function () {
        const r = await perp.callStatic.computeRedemptionAmts(toFixedPtAmt("100"));
        await expect(r[1][0]).to.eq(toFixedPtAmt("0"));
        await expect(r[1][1]).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when the supply increases", function () {
      beforeEach(async function () {
        await feeStrategy.setBurnFee(toFixedPtAmt("-1"));
      });

      it("should revert", async function () {
        await expect(perp.redeem(toFixedPtAmt("0.01"))).to.revertedWith("ExpectedSupplyReduction");
      });
    });

    describe("when fee is in native token", function () {
      describe("when fee is zero", function () {
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
        it("should return the redemption amounts", async function () {
          const r = await perp.callStatic.computeRedemptionAmts(toFixedPtAmt("500"));
          expect(r[0][0]).to.eq(collateralToken.address);
          expect(r[0][1]).to.eq(initialDepositTranche.address);
          expect(r[1][0]).to.eq(toFixedPtAmt("0"));
          expect(r[1][1]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when fee > 0", function () {
        beforeEach(async function () {
          await depositIntoBond(await bondAt(await perp.callStatic.getDepositBond()), toFixedPtAmt("2"), deployer);
          await initialDepositTranche.increaseAllowance(perp.address, toFixedPtAmt("1"));
          await perp.deposit(initialDepositTranche.address, toFixedPtAmt("1"));
          await feeStrategy.setBurnFee(toFixedPtAmt("1"));
        });
        it("should burn perp tokens", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("-501"),
          );
        });
        it("should withhold fee", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(perp, perp, toFixedPtAmt("1"));
        });
        it("should transfer the tranches out", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalances(
            initialDepositTranche,
            [deployer, perp],
            [toFixedPtAmt("500"), toFixedPtAmt("-500")],
          );
        });
        it("should return the redemption amounts", async function () {
          const r = await perp.callStatic.computeRedemptionAmts(toFixedPtAmt("500"));
          expect(r[0][0]).to.eq(collateralToken.address);
          expect(r[0][1]).to.eq(initialDepositTranche.address);
          expect(r[1][0]).to.eq(toFixedPtAmt("0"));
          expect(r[1][1]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when fee < 0", function () {
        beforeEach(async function () {
          await depositIntoBond(await bondAt(await perp.callStatic.getDepositBond()), toFixedPtAmt("2"), deployer);
          await initialDepositTranche.increaseAllowance(perp.address, toFixedPtAmt("1"));
          await perp.deposit(initialDepositTranche.address, toFixedPtAmt("1"));
          await perp.transfer(perp.address, toFixedPtAmt("1"));
          await feeStrategy.setBurnFee(toFixedPtAmt("-1"));
        });
        it("should burn perp tokens", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("-499"),
          );
        });
        it("should transfer reward", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(perp, perp, toFixedPtAmt("-1"));
        });
        it("should transfer the tranches out", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalances(
            initialDepositTranche,
            [deployer, perp],
            [toFixedPtAmt("500"), toFixedPtAmt("-500")],
          );
        });
        it("should return the redemption amounts", async function () {
          const r = await perp.callStatic.computeRedemptionAmts(toFixedPtAmt("500"));
          expect(r[0][0]).to.eq(collateralToken.address);
          expect(r[0][1]).to.eq(initialDepositTranche.address);
          expect(r[1][0]).to.eq(toFixedPtAmt("0"));
          expect(r[1][1]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when fee < 0 && abs(fee) < balance", function () {
        beforeEach(async function () {
          await depositIntoBond(await bondAt(await perp.callStatic.getDepositBond()), toFixedPtAmt("2"), deployer);
          await initialDepositTranche.increaseAllowance(perp.address, toFixedPtAmt("1"));
          await perp.deposit(initialDepositTranche.address, toFixedPtAmt("1"));
          await perp.transfer(perp.address, toFixedPtAmt("0.5"));
          await feeStrategy.setBurnFee(toFixedPtAmt("-1"));
        });
        it("should burn perp tokens", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("-499"),
          );
        });
        it("should transfer reward", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(perp, perp, toFixedPtAmt("-0.5"));
        });
        it("should mint the delta", async function () {
          await expect(perp.redeem(toFixedPtAmt("500")))
            .to.emit(perp, "Transfer")
            .withArgs(constants.AddressZero, deployerAddress, toFixedPtAmt("0.5"));
        });
        it("should transfer the tranches out", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalances(
            initialDepositTranche,
            [deployer, perp],
            [toFixedPtAmt("500"), toFixedPtAmt("-500")],
          );
        });
        it("should return the redemption amounts", async function () {
          const r = await perp.callStatic.computeRedemptionAmts(toFixedPtAmt("500"));
          expect(r[0][0]).to.eq(collateralToken.address);
          expect(r[0][1]).to.eq(initialDepositTranche.address);
          expect(r[1][0]).to.eq(toFixedPtAmt("0"));
          expect(r[1][1]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when protocol fee > 0", function () {
        beforeEach(async function () {
          await perp.transferOwnership(await otherUser.getAddress());
          await depositIntoBond(await bondAt(await perp.callStatic.getDepositBond()), toFixedPtAmt("3"), deployer);
          await initialDepositTranche.increaseAllowance(perp.address, toFixedPtAmt("1.5"));
          await perp.deposit(initialDepositTranche.address, toFixedPtAmt("1.5"));
          await feeStrategy.setBurnFee(toFixedPtAmt("1"));
          await feeStrategy.setProtocolFee(toFixedPtAmt("0.5"));
        });
        it("should burn perp tokens", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("-501.5"),
          );
        });
        it("should withhold reserve fee", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(perp, perp, toFixedPtAmt("1"));
        });
        it("should withhold protocol fee", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            otherUser,
            toFixedPtAmt("0.5"),
          );
        });
        it("should transfer the tranches out", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalances(
            initialDepositTranche,
            [deployer, perp],
            [toFixedPtAmt("500"), toFixedPtAmt("-500")],
          );
        });
        it("should return the redemption amounts", async function () {
          const r = await perp.callStatic.computeRedemptionAmts(toFixedPtAmt("500"));
          expect(r[0][0]).to.eq(collateralToken.address);
          expect(r[0][1]).to.eq(initialDepositTranche.address);
          expect(r[1][0]).to.eq(toFixedPtAmt("0"));
          expect(r[1][1]).to.eq(toFixedPtAmt("500"));
        });
      });
    });

    describe("when fee is in non-native token", function () {
      let feeToken: Contract;
      beforeEach(async function () {
        const ERC20 = await ethers.getContractFactory("MockERC20");
        feeToken = await ERC20.deploy();
        await feeToken.init("Mock token", "MOCK");
        await feeStrategy.setFeeToken(feeToken.address);
      });

      describe("when fee is zero", async function () {
        it("should burn perp tokens", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("-500"),
          );
        });
        it("should settle fee", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(
            feeToken,
            deployer,
            toFixedPtAmt("0"),
          );
        });
        it("should transfer the tranches out", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalances(
            initialDepositTranche,
            [deployer, perp],
            [toFixedPtAmt("500"), toFixedPtAmt("-500")],
          );
        });
        it("should return the redemption amounts", async function () {
          const r = await perp.callStatic.computeRedemptionAmts(toFixedPtAmt("500"));
          expect(r[0][0]).to.eq(collateralToken.address);
          expect(r[0][1]).to.eq(initialDepositTranche.address);
          expect(r[1][0]).to.eq(toFixedPtAmt("0"));
          expect(r[1][1]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when fee > 0", async function () {
        beforeEach(async function () {
          await feeStrategy.setBurnFee(toFixedPtAmt("1"));
        });

        describe("with no approval", function () {
          it("should revert", async function () {
            await expect(perp.redeem(toFixedPtAmt("500"))).to.be.revertedWith("ERC20: insufficient allowance");
          });
        });

        describe("with insufficient balance", function () {
          beforeEach(async function () {
            await feeToken.approve(perp.address, toFixedPtAmt("1"));
          });

          it("should revert", async function () {
            await expect(perp.redeem(toFixedPtAmt("500"))).to.be.revertedWith("ERC20: transfer amount exceeds balance");
          });
        });

        describe("with sufficient fee", async function () {
          beforeEach(async function () {
            await feeStrategy.setBurnFee(toFixedPtAmt("1"));
            await feeToken.mint(deployerAddress, toFixedPtAmt("1"));
            await feeToken.approve(perp.address, toFixedPtAmt("1"));
          });

          it("should burn perp tokens", async function () {
            await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(
              perp,
              deployer,
              toFixedPtAmt("-500"),
            );
          });
          it("should transfer fee from redeemer", async function () {
            await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(
              feeToken,
              deployer,
              toFixedPtAmt("-1"),
            );
          });
          it("should transfer the tranches out", async function () {
            await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalances(
              initialDepositTranche,
              [deployer, perp],
              [toFixedPtAmt("500"), toFixedPtAmt("-500")],
            );
          });
          it("should return the redemption amounts", async function () {
            const r = await perp.callStatic.computeRedemptionAmts(toFixedPtAmt("500"));
            expect(r[0][0]).to.eq(collateralToken.address);
            expect(r[0][1]).to.eq(initialDepositTranche.address);
            expect(r[1][0]).to.eq(toFixedPtAmt("0"));
            expect(r[1][1]).to.eq(toFixedPtAmt("500"));
          });
        });
      });

      describe("when fee < 0", async function () {
        beforeEach(async function () {
          await feeStrategy.setBurnFee(toFixedPtAmt("-1"));
          await feeToken.mint(perp.address, toFixedPtAmt("1"));
        });

        it("should burn perp tokens", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("-500"),
          );
        });
        it("should transfer fee to redeemer", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(
            feeToken,
            deployer,
            toFixedPtAmt("1"),
          );
        });
        it("should transfer the tranches out", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalances(
            initialDepositTranche,
            [deployer, perp],
            [toFixedPtAmt("500"), toFixedPtAmt("-500")],
          );
        });
        it("should return the redemption amounts", async function () {
          const r = await perp.callStatic.computeRedemptionAmts(toFixedPtAmt("500"));
          expect(r[0][0]).to.eq(collateralToken.address);
          expect(r[0][1]).to.eq(initialDepositTranche.address);
          expect(r[1][0]).to.eq(toFixedPtAmt("0"));
          expect(r[1][1]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when protocol fee > 0", async function () {
        beforeEach(async function () {
          await perp.transferOwnership(await otherUser.getAddress());
          await feeStrategy.setBurnFee(toFixedPtAmt("1"));
          await feeStrategy.setProtocolFee(toFixedPtAmt("0.5"));
          await feeToken.mint(deployerAddress, toFixedPtAmt("1.5"));
          await feeToken.approve(perp.address, toFixedPtAmt("1.5"));
        });

        it("should burn perp tokens", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("-500"),
          );
        });

        it("should transfer fees from redeemer", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalances(
            feeToken,
            [deployer, perp, otherUser],
            [toFixedPtAmt("-1.5"), toFixedPtAmt("1"), toFixedPtAmt("0.5")],
          );
        });

        it("should transfer the tranches out", async function () {
          await expect(() => perp.redeem(toFixedPtAmt("500"))).to.changeTokenBalances(
            initialDepositTranche,
            [deployer, perp],
            [toFixedPtAmt("500"), toFixedPtAmt("-500")],
          );
        });

        it("should return the redemption amounts", async function () {
          const r = await perp.callStatic.computeRedemptionAmts(toFixedPtAmt("500"));
          expect(r[0][0]).to.eq(collateralToken.address);
          expect(r[0][1]).to.eq(initialDepositTranche.address);
          expect(r[1][0]).to.eq(toFixedPtAmt("0"));
          expect(r[1][1]).to.eq(toFixedPtAmt("500"));
        });
      });
    });

    describe("when redeeming all the tokens", function () {
      it("should update the reserve composition", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche],
          [toFixedPtAmt("0"), toFixedPtAmt("500")],
        );
        await perp.redeem(toFixedPtAmt("500"));
        await checkReserveComposition(perp, [collateralToken], [toFixedPtAmt("0")]);
      });
    });

    describe("when reserve has more than one tranche", function () {
      let newRedemptionTranche: Contract, tx: Transaction;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturity(1200, 3600);

        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await pricingStrategy.setTranchePrice(newRedemptionTranche.address, toPriceFixedPtAmt("1"));
        await discountStrategy.setTrancheDiscount(newRedemptionTranche.address, toDiscountFixedPtAmt("0.5"));

        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("0"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("750"));
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("0"));
        expect(await collateralToken.balanceOf(await perp.reserve())).to.eq(toFixedPtAmt("0"));
        expect(await perp.callStatic.getReserveTrancheBalance(initialDepositTranche.address)).to.eq(
          toFixedPtAmt("500"),
        );
        expect(await perp.callStatic.getReserveTrancheBalance(newRedemptionTranche.address)).to.eq(toFixedPtAmt("500"));

        tx = perp.redeem(toFixedPtAmt("375"));
        await tx;
      });

      it("should update the reserve composition", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("0"), toFixedPtAmt("250"), toFixedPtAmt("250")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("0"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(initialDepositTranche.address, toFixedPtAmt("250"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(newRedemptionTranche.address, toFixedPtAmt("250"));
      });
      it("should transfer tokens out", async function () {
        await expect(tx)
          .to.emit(initialDepositTranche, "Transfer")
          .withArgs(perp.address, deployerAddress, toFixedPtAmt("250"))
          .to.emit(newRedemptionTranche, "Transfer")
          .withArgs(perp.address, deployerAddress, toFixedPtAmt("250"));
      });
      it("should emit tranche balance update", async function () {
        await expect(tx).to.emit(perp, "UpdatedMatureTrancheBalance").withArgs(toFixedPtAmt("0"));
      });
      it("should update the total supply", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("375"));
      });
      it("should NOT update matureTrancheBalance", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("0"));
      });
    });

    describe("when reserve has mature collateral and tranches", function () {
      let newRedemptionTranche: Contract, tx: Transaction;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturity(1200, 3600);

        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await pricingStrategy.setTranchePrice(newRedemptionTranche.address, toPriceFixedPtAmt("1"));
        await discountStrategy.setTrancheDiscount(newRedemptionTranche.address, toDiscountFixedPtAmt("0.5"));

        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("0"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("750"));
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("0"));

        await advancePerpQueue(perp, 2400);

        tx = perp.redeem(toFixedPtAmt("375"));
        await tx;
      });

      it("should update the reserve composition", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, newRedemptionTranche],
          [toFixedPtAmt("250"), toFixedPtAmt("250")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("250"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(newRedemptionTranche.address, toFixedPtAmt("250"));
      });
      it("should transfer tokens out", async function () {
        await expect(tx)
          .to.emit(collateralToken, "Transfer")
          .withArgs(perp.address, deployerAddress, toFixedPtAmt("250"))
          .to.emit(newRedemptionTranche, "Transfer")
          .withArgs(perp.address, deployerAddress, toFixedPtAmt("250"));
      });
      it("should emit tranche balance update", async function () {
        await expect(tx).to.emit(perp, "UpdatedMatureTrancheBalance").withArgs(toFixedPtAmt("250"));
      });
      it("should update the total supply", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("375"));
      });
      it("should NOT update matureTrancheBalance", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when the collateralToken balance is over the tranche balance", function () {
      let newRedemptionTranche: Contract, tx: Transaction;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturity(1200, 3600);

        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await pricingStrategy.setTranchePrice(newRedemptionTranche.address, toPriceFixedPtAmt("1"));
        await discountStrategy.setTrancheDiscount(newRedemptionTranche.address, toDiscountFixedPtAmt("0.5"));

        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("0"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );

        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("750"));
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("0"));
        expect(await collateralToken.balanceOf(await perp.reserve())).to.eq(toFixedPtAmt("0"));
        expect(await perp.callStatic.getReserveTrancheBalance(initialDepositTranche.address)).to.eq(
          toFixedPtAmt("500"),
        );
        expect(await perp.callStatic.getReserveTrancheBalance(newRedemptionTranche.address)).to.eq(toFixedPtAmt("500"));

        await advancePerpQueue(perp, 2400);
        await rebase(collateralToken, rebaseOracle, +0.5);

        tx = perp.redeem(toFixedPtAmt("375"));
        await tx;
      });

      it("should update the reserve composition", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, newRedemptionTranche],
          [toFixedPtAmt("375"), toFixedPtAmt("250")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("250"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(newRedemptionTranche.address, toFixedPtAmt("250"));
      });
      it("should transfer tokens out", async function () {
        await expect(tx)
          .to.emit(collateralToken, "Transfer")
          .withArgs(perp.address, deployerAddress, toFixedPtAmt("250"))
          .to.emit(newRedemptionTranche, "Transfer")
          .withArgs(perp.address, deployerAddress, toFixedPtAmt("250"));
      });
      it("should emit tranche balance update", async function () {
        await expect(tx).to.emit(perp, "UpdatedMatureTrancheBalance").withArgs(toFixedPtAmt("250"));
      });
      it("should update the total supply", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("375"));
      });
      it("should NOT update matureTrancheBalance", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when the collateralToken balance is over the tranche balance", function () {
      let newRedemptionTranche: Contract, tx: Transaction;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturity(1200, 3600);

        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await pricingStrategy.setTranchePrice(newRedemptionTranche.address, toPriceFixedPtAmt("1"));
        await discountStrategy.setTrancheDiscount(newRedemptionTranche.address, toDiscountFixedPtAmt("0.5"));

        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("0"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("750"));
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("0"));

        await advancePerpQueue(perp, 2400);
        await rebase(collateralToken, rebaseOracle, -0.5);

        tx = perp.redeem(toFixedPtAmt("375"));
        await tx;
      });

      it("should update the reserve composition", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, newRedemptionTranche],
          [toFixedPtAmt("125"), toFixedPtAmt("250")],
        );
      });
      it("should emit reserve synced", async function () {
        await expect(tx)
          .to.emit(perp, "ReserveSynced")
          .withArgs(collateralToken.address, toFixedPtAmt("250"))
          .to.emit(perp, "ReserveSynced")
          .withArgs(newRedemptionTranche.address, toFixedPtAmt("250"));
      });
      it("should transfer tokens out", async function () {
        await expect(tx)
          .to.emit(collateralToken, "Transfer")
          .withArgs(perp.address, deployerAddress, toFixedPtAmt("250"))
          .to.emit(newRedemptionTranche, "Transfer")
          .withArgs(perp.address, deployerAddress, toFixedPtAmt("250"));
      });
      it("should emit tranche balance update", async function () {
        await expect(tx).to.emit(perp, "UpdatedMatureTrancheBalance").withArgs(toFixedPtAmt("250"));
      });
      it("should update the total supply", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("375"));
      });
      it("should NOT update matureTrancheBalance", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when reserve has only mature collateral", function () {
      let newRedemptionTranche: Contract, tx: Transaction;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturity(1200, 3600);

        await advancePerpQueue(perp, 1200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];

        await pricingStrategy.setTranchePrice(newRedemptionTranche.address, toPriceFixedPtAmt("1"));
        await discountStrategy.setTrancheDiscount(newRedemptionTranche.address, toDiscountFixedPtAmt("0.5"));

        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        await checkReserveComposition(perp, [collateralToken, initialDepositTranche, newRedemptionTranche]);
        await checkReserveComposition(
          perp,
          [collateralToken, initialDepositTranche, newRedemptionTranche],
          [toFixedPtAmt("0"), toFixedPtAmt("500"), toFixedPtAmt("500")],
        );

        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("750"));
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("0"));

        await advancePerpQueue(perp, 7200);

        tx = perp.redeem(toFixedPtAmt("375"));
        await tx;
      });

      it("should update the reserve composition", async function () {
        await checkReserveComposition(perp, [collateralToken]);
        await checkReserveComposition(perp, [collateralToken], [toFixedPtAmt("500")]);
      });
      it("should emit reserve synced", async function () {
        await expect(tx).to.emit(perp, "ReserveSynced").withArgs(collateralToken.address, toFixedPtAmt("500"));
      });
      it("should transfer tokens out", async function () {
        await expect(tx)
          .to.emit(collateralToken, "Transfer")
          .withArgs(perp.address, deployerAddress, toFixedPtAmt("500"));
      });
      it("should emit tranche balance update", async function () {
        await expect(tx).to.emit(perp, "UpdatedMatureTrancheBalance").withArgs(toFixedPtAmt("375"));
      });
      it("should update the total supply", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("375"));
      });
      it("should NOT update matureTrancheBalance", async function () {
        expect(await perp.callStatic.getMatureTrancheBalance()).to.eq(toFixedPtAmt("375"));
      });
    });
  });
});
