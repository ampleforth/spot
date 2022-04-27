import { expect } from "chai";
import { network, ethers } from "hardhat";
import { constants, Contract, Transaction, Signer } from "ethers";

import {
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  depositIntoBond,
  bondAt,
  getTranches,
  toFixedPtAmt,
  toYieldFixedPtAmt,
  toPriceFixedPtAmt,
  advancePerpQueue,
} from "./helpers";

let perp: Contract,
  bondFactory: Contract,
  collateralToken: Contract,
  issuer: Contract,
  feeStrategy: Contract,
  pricingStrategy: Contract,
  deployer: Signer,
  deployerAddress: string,
  depositBond: Contract,
  depositTrancheA: Contract,
  depositTrancheZ: Contract;
describe("PerpetualTranche", function () {
  beforeEach(async function () {
    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    deployerAddress = await deployer.getAddress();

    bondFactory = await setupBondFactory();
    ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));
    const BondIssuer = await ethers.getContractFactory("BondIssuer");
    issuer = await BondIssuer.deploy(bondFactory.address, 1200, 0, 3600, collateralToken.address, [500, 500]);

    const FeeStrategy = await ethers.getContractFactory("MockFeeStrategy");
    feeStrategy = await FeeStrategy.deploy();

    const PricingStrategy = await ethers.getContractFactory("MockPricingStrategy");
    pricingStrategy = await PricingStrategy.deploy();

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await PerpetualTranche.deploy("PerpetualTranche", "PERP", 9);
    await perp.init(issuer.address, feeStrategy.address, pricingStrategy.address);
    await advancePerpQueue(perp, 3600);

    depositBond = await bondAt(await perp.callStatic.updateQueueAndGetDepositBond());
    [depositTrancheA, depositTrancheZ] = await getTranches(depositBond);

    await feeStrategy.setFeeToken(perp.address);
    await feeStrategy.setMintFee(toFixedPtAmt("0"));
    await pricingStrategy.setPrice(toPriceFixedPtAmt("1"));
    await perp.updateDefinedYield(await perp.trancheClass(depositTrancheA.address), toYieldFixedPtAmt("1"));

    await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
    await depositTrancheA.approve(perp.address, toFixedPtAmt("500"));
    await depositTrancheZ.approve(perp.address, toFixedPtAmt("500"));
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#deposit", function () {
    describe("when bond issuer is NOT set correctly", function () {
      beforeEach(async function () {
        await perp.updateBondIssuer(perp.address);
      });
      it("should revert", async function () {
        await depositTrancheA.approve(perp.address, toFixedPtAmt("500"));
        await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.reverted;
      });
    });

    describe("when the trancheIn is not of deposit bond", function () {
      beforeEach(async function () {
        const bond = await createBondWithFactory(bondFactory, collateralToken, [500, 500], 3600);
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        depositTrancheA = (await getTranches(bond))[0];
      });
      it("should revert", async function () {
        await depositTrancheA.approve(perp.address, toFixedPtAmt("500"));
        await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.revertedWith(
          "Expected tranche to be of deposit bond",
        );
      });
    });

    describe("when user has not approved sufficient tranche tokens", function () {
      beforeEach(async function () {
        await depositTrancheA.approve(perp.address, toFixedPtAmt("0"));
      });
      it("should revert", async function () {
        await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.revertedWith(
          "ERC20: transfer amount exceeds allowance",
        );
      });
    });

    describe("when user has insufficient balance", function () {
      beforeEach(async function () {
        await depositTrancheA.transfer(perp.address, toFixedPtAmt("500"));
      });
      it("should revert", async function () {
        expect(await depositTrancheA.balanceOf(deployerAddress)).to.eq("0");
        await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.revertedWith(
          "ERC20: transfer amount exceeds balance",
        );
      });
    });

    describe("when tranche amount is zero", function () {
      it("should revert", async function () {
        await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("0"))).to.revertedWith(
          "Expected to mint a non-zero amount of tokens",
        );
      });
    });

    describe("when tranche price is zero", function () {
      beforeEach(async function () {
        await pricingStrategy.setPrice(toPriceFixedPtAmt("0"));
      });

      it("should revert", async function () {
        await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.revertedWith(
          "Expected to mint a non-zero amount of tokens",
        );
      });
    });

    describe("when tranche yield is zero", function () {
      it("should revert", async function () {
        await expect(perp.deposit(depositTrancheZ.address, toFixedPtAmt("500"))).to.revertedWith(
          "Expected to mint a non-zero amount of tokens",
        );
      });
    });

    describe("when tranche price is 0.5", function () {
      beforeEach(async function () {
        await pricingStrategy.setPrice(toPriceFixedPtAmt("0.5"));
      });

      it("should mint the correct amount", async function () {
        const r = await perp.callStatic.deposit(depositTrancheA.address, toFixedPtAmt("500"));
        expect(r[0]).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when tranche yield is 0.5", function () {
      beforeEach(async function () {
        await perp.updateDefinedYield(await perp.trancheClass(depositTrancheA.address), toYieldFixedPtAmt("0.5"));
      });

      it("should mint the correct amount", async function () {
        const r = await perp.callStatic.deposit(depositTrancheA.address, toFixedPtAmt("500"));
        expect(r[0]).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when tranche yield is 0.5 and tranche price is 0.5", function () {
      beforeEach(async function () {
        await pricingStrategy.setPrice(toPriceFixedPtAmt("0.5"));
        await perp.updateDefinedYield(await perp.trancheClass(depositTrancheA.address), toYieldFixedPtAmt("0.5"));
      });

      it("should mint the correct amount", async function () {
        const r = await perp.callStatic.deposit(depositTrancheA.address, toFixedPtAmt("500"));
        expect(r[0]).to.eq(toFixedPtAmt("125"));
      });
    });

    describe("when fee is in native token", function () {
      describe("when fee is zero", function () {
        it("should mint perp tokens", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("500"),
          );
        });
        it("should NOT withhold any fee amount", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            perp,
            toFixedPtAmt("0"),
          );
        });
        it("should transfer the tranches in", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalances(
            depositTrancheA,
            [deployer, perp],
            [toFixedPtAmt("-500"), toFixedPtAmt("500")],
          );
        });
        it("should return the mintAmt and fee", async function () {
          const r = await perp.callStatic.deposit(depositTrancheA.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("when fee > 0", function () {
        beforeEach(async function () {
          await feeStrategy.setMintFee(toFixedPtAmt("1"));
        });
        it("should mint perp tokens", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("499"),
          );
        });
        it("should withhold fee amount", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            perp,
            toFixedPtAmt("1"),
          );
        });
        it("should transfer the tranches in", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalances(
            depositTrancheA,
            [deployer, perp],
            [toFixedPtAmt("-500"), toFixedPtAmt("500")],
          );
        });
        it("should return the mintAmt and fee", async function () {
          const r = await perp.callStatic.deposit(depositTrancheA.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("1"));
        });
      });
      describe("when fee < 0", function () {
        beforeEach(async function () {
          await depositIntoBond(
            await bondAt(await perp.callStatic.updateQueueAndGetDepositBond()),
            toFixedPtAmt("2"),
            deployer,
          );
          await depositTrancheA.increaseAllowance(perp.address, toFixedPtAmt("1"));
          await perp.deposit(depositTrancheA.address, toFixedPtAmt("1"));
          await perp.transfer(perp.address, toFixedPtAmt("1"));
          await feeStrategy.setMintFee(toFixedPtAmt("-1"));
        });
        it("should mint perp tokens", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("501"),
          );
        });
        it("should transfer reward amount", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            perp,
            toFixedPtAmt("-1"),
          );
        });
        it("should transfer the tranches in", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalances(
            depositTrancheA,
            [deployer, perp],
            [toFixedPtAmt("-500"), toFixedPtAmt("500")],
          );
        });
        it("should return the mintAmt and fee", async function () {
          const r = await perp.callStatic.deposit(depositTrancheA.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("-1"));
        });
      });
    });

    describe("when fee is in non-native token", function () {
      let feeToken: Contract;
      beforeEach(async function () {
        const ERC20 = await ethers.getContractFactory("MockERC20");
        feeToken = await ERC20.deploy("Mock token", "MOCK");
        await feeStrategy.setFeeToken(feeToken.address);
      });

      describe("when fee is zero", async function () {
        it("should mint perp tokens", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("500"),
          );
        });
        it("should NOT transfer fees", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalances(
            feeToken,
            [deployer, perp],
            [toFixedPtAmt("0"), toFixedPtAmt("0")],
          );
        });
        it("should transfer the tranches in", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalances(
            depositTrancheA,
            [deployer, perp],
            [toFixedPtAmt("-500"), toFixedPtAmt("500")],
          );
        });
        it("should return the mintAmt and fee", async function () {
          const r = await perp.callStatic.deposit(depositTrancheA.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("when fee > 0", async function () {
        beforeEach(async function () {
          await feeStrategy.setMintFee(toFixedPtAmt("1"));
        });

        describe("with no approval", function () {
          it("should revert", async function () {
            await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.be.revertedWith(
              "ERC20: insufficient allowance",
            );
          });
        });

        describe("with insufficient balance", function () {
          beforeEach(async function () {
            await feeToken.approve(perp.address, toFixedPtAmt("1"));
          });

          it("should revert", async function () {
            await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.be.revertedWith(
              "ERC20: transfer amount exceeds balance",
            );
          });
        });

        describe("with sufficient fee", async function () {
          beforeEach(async function () {
            await feeStrategy.setMintFee(toFixedPtAmt("1"));
            await feeToken.mint(deployerAddress, toFixedPtAmt("1"));
            await feeToken.approve(perp.address, toFixedPtAmt("1"));
          });

          it("should mint perp tokens", async function () {
            await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalance(
              perp,
              deployer,
              toFixedPtAmt("500"),
            );
          });
          it("should transfer fees", async function () {
            await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalances(
              feeToken,
              [deployer, perp],
              [toFixedPtAmt("-1"), toFixedPtAmt("1")],
            );
          });
          it("should transfer the tranches in", async function () {
            await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalances(
              depositTrancheA,
              [deployer, perp],
              [toFixedPtAmt("-500"), toFixedPtAmt("500")],
            );
          });
          it("should return the mintAmt and fee", async function () {
            const r = await perp.callStatic.deposit(depositTrancheA.address, toFixedPtAmt("500"));
            expect(r[0]).to.eq(toFixedPtAmt("500"));
            expect(r[1]).to.eq(toFixedPtAmt("1"));
          });
        });
      });
      describe("when fee < 0", async function () {
        beforeEach(async function () {
          await feeStrategy.setMintFee(toFixedPtAmt("-1"));
          await feeToken.mint(perp.address, toFixedPtAmt("1"));
        });

        it("should mint perp tokens", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("500"),
          );
        });
        it("should transfer fees", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalances(
            feeToken,
            [deployer, perp],
            [toFixedPtAmt("1"), toFixedPtAmt("-1")],
          );
        });
        it("should transfer the tranches in", async function () {
          await expect(() => perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.changeTokenBalances(
            depositTrancheA,
            [deployer, perp],
            [toFixedPtAmt("-500"), toFixedPtAmt("500")],
          );
        });
        it("should return the mintAmt and fee", async function () {
          const r = await perp.callStatic.deposit(depositTrancheA.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("-1"));
        });
      });
    });

    describe("when the tranche queue is empty", function () {
      let tx: Transaction;
      beforeEach(async function () {
        expect(await perp.callStatic.updateQueueAndGetDepositBond()).to.eq(depositBond.address);
        expect(await perp.callStatic.updateQueueAndGetQueueCount()).to.eq(0);
        await expect(perp.callStatic.updateQueueAndGetQueueAt(0)).to.be.reverted;
        expect(await perp.callStatic.updateQueueAndGetRedemptionTranche()).to.eq(constants.AddressZero);
        expect(await perp.reserveCount()).to.eq(0);
        expect(await perp.inReserve(depositTrancheA.address)).to.eq(false);
        await expect(perp.reserveAt(0)).to.be.reverted;

        tx = perp.deposit(depositTrancheA.address, toFixedPtAmt("500"));
        await tx;
      });

      it("should NOT update the deposit bond", async function () {
        expect(await perp.callStatic.updateQueueAndGetDepositBond()).to.eq(depositBond.address);
      });
      it("should emit enqueue", async function () {
        await expect(tx).to.emit(perp, "TrancheEnqueued").withArgs(depositTrancheA.address);
      });
      it("should emit tranche yield", async function () {
        await expect(tx).to.emit(perp, "TrancheYieldApplied").withArgs(depositTrancheA.address, toYieldFixedPtAmt("1"));
      });
      it("should emit reserve synced", async function () {
        await expect(tx).to.emit(perp, "ReserveSynced").withArgs(depositTrancheA.address, toFixedPtAmt("500"));
      });
      it("should increase the queue size", async function () {
        expect(await perp.callStatic.updateQueueAndGetQueueCount()).to.eq(1);
      });
      it("should add the the queue", async function () {
        expect(await perp.callStatic.updateQueueAndGetQueueAt(0)).to.eq(depositTrancheA.address);
        await expect(perp.callStatic.updateQueueAndGetQueueAt(1)).to.be.reverted;
      });
      it("should update the head of the queue", async function () {
        expect(await perp.callStatic.updateQueueAndGetRedemptionTranche()).to.eq(depositTrancheA.address);
      });
      it("should increase the reserve size", async function () {
        expect(await perp.reserveCount()).to.eq(1);
      });
      it("should add asset to the reserve", async function () {
        expect(await perp.inReserve(depositTrancheA.address)).to.eq(true);
        expect(await perp.reserveAt(0)).to.eq(depositTrancheA.address);
      });
    });

    describe("when the tranche queue is not empty", function () {
      beforeEach(async function () {
        await perp.deposit(depositTrancheA.address, toFixedPtAmt("200"));

        expect(await perp.callStatic.updateQueueAndGetDepositBond()).to.eq(depositBond.address);
        expect(await perp.callStatic.updateQueueAndGetQueueCount()).to.eq(1);
        expect(await perp.callStatic.updateQueueAndGetQueueAt(0)).to.eq(depositTrancheA.address);
        await expect(perp.callStatic.updateQueueAndGetQueueAt(1)).to.be.reverted;
        expect(await perp.callStatic.updateQueueAndGetRedemptionTranche()).to.eq(depositTrancheA.address);
        expect(await perp.reserveCount()).to.eq(1);
        expect(await perp.inReserve(depositTrancheA.address)).to.eq(true);
        expect(await perp.reserveAt(0)).to.eq(depositTrancheA.address);
        await expect(perp.reserveAt(1)).to.be.reverted;
      });

      describe("when inserting the an existing tranche", async function () {
        let tx: Transaction;
        beforeEach(async function () {
          tx = perp.deposit(depositTrancheA.address, toFixedPtAmt("300"));
          await tx;
        });

        it("should NOT update the deposit bond", async function () {
          expect(await perp.callStatic.updateQueueAndGetDepositBond()).to.eq(depositBond.address);
        });
        it("should NOT emit enqueue", async function () {
          await expect(tx).not.to.emit(perp, "TrancheEnqueued").withArgs(depositTrancheA.address);
        });
        it("should emit tranche yield", async function () {
          await expect(tx)
            .not.to.emit(perp, "TrancheYieldApplied")
            .withArgs(depositTrancheA.address, toYieldFixedPtAmt("1"));
        });
        it("should emit reserve synced", async function () {
          await expect(tx).to.emit(perp, "ReserveSynced").withArgs(depositTrancheA.address, toFixedPtAmt("500"));
        });
        it("should NOT increase the queue size", async function () {
          expect(await perp.callStatic.updateQueueAndGetQueueCount()).to.eq(1);
        });
        it("should NOT add the the queue", async function () {
          expect(await perp.callStatic.updateQueueAndGetQueueAt(0)).to.eq(depositTrancheA.address);
          await expect(perp.callStatic.updateQueueAndGetQueueAt(1)).to.be.reverted;
        });
        it("should NOT update the head of the queue", async function () {
          expect(await perp.callStatic.updateQueueAndGetRedemptionTranche()).to.eq(depositTrancheA.address);
        });
        it("should NOT increase the reserve size", async function () {
          expect(await perp.reserveCount()).to.eq(1);
        });
        it("should NOT change the reserve reserve", async function () {
          expect(await perp.inReserve(depositTrancheA.address)).to.eq(true);
          expect(await perp.reserveAt(0)).to.eq(depositTrancheA.address);
          await expect(perp.reserveAt(1)).to.be.reverted;
        });
      });

      describe("when inserting a new tranche", function () {
        let newBond: Contract, newTranche: Contract, tx: Transaction;
        beforeEach(async function () {
          await advancePerpQueue(perp, 1200);

          newBond = await bondAt(await perp.callStatic.updateQueueAndGetDepositBond());
          await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
          const tranches = await getTranches(newBond);
          newTranche = tranches[0];
          await perp.updateDefinedYield(await perp.trancheClass(newTranche.address), toYieldFixedPtAmt("0.5"));

          await newTranche.approve(perp.address, toFixedPtAmt("250"));
          tx = perp.deposit(newTranche.address, toFixedPtAmt("250"));
          await tx;
        });

        it("should update the deposit bond", async function () {
          expect(await perp.callStatic.updateQueueAndGetDepositBond()).to.eq(newBond.address);
        });
        it("should emit enqueue", async function () {
          await expect(tx).to.emit(perp, "TrancheEnqueued").withArgs(newTranche.address);
        });
        it("should emit tranche yield", async function () {
          await expect(tx).to.emit(perp, "TrancheYieldApplied").withArgs(newTranche.address, toYieldFixedPtAmt("0.5"));
        });
        it("should emit reserve synced", async function () {
          await expect(tx).to.emit(perp, "ReserveSynced").withArgs(newTranche.address, toFixedPtAmt("250"));
        });
        it("should increase the queue size", async function () {
          expect(await perp.callStatic.updateQueueAndGetQueueCount()).to.eq(2);
        });
        it("should add the the queue", async function () {
          expect(await perp.callStatic.updateQueueAndGetQueueAt(0)).to.eq(depositTrancheA.address);
          expect(await perp.callStatic.updateQueueAndGetQueueAt(1)).to.eq(newTranche.address);
          await expect(perp.callStatic.updateQueueAndGetQueueAt(2)).to.be.reverted;
        });
        it("should NOT update the head of the queue", async function () {
          expect(await perp.callStatic.updateQueueAndGetRedemptionTranche()).to.eq(depositTrancheA.address);
        });
        it("should increase the reserve size", async function () {
          expect(await perp.reserveCount()).to.eq(2);
        });
        it("should add asset to the reserve", async function () {
          expect(await perp.inReserve(newTranche.address)).to.eq(true);
          expect(await perp.reserveAt(0)).to.eq(depositTrancheA.address);
          expect(await perp.reserveAt(1)).to.eq(newTranche.address);
          await expect(perp.reserveAt(2)).to.be.reverted;
        });
      });
    });
  });
});
