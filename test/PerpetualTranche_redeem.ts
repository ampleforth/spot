import { expect } from "chai";
import { network, ethers } from "hardhat";
import { constants, Contract, Transaction, Signer } from "ethers";

import {
  setupCollateralToken,
  setupBondFactory,
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
  initialDepositTranche: Contract;

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

    depositBond = await bondAt(await perp.callStatic.getDepositBond());
    [initialDepositTranche] = await getTranches(depositBond);

    await feeStrategy.setFeeToken(perp.address);
    await feeStrategy.setMintFee(toFixedPtAmt("0"));
    await pricingStrategy.setPrice(toPriceFixedPtAmt("1"));
    await perp.updateDefinedYield(await perp.trancheClass(initialDepositTranche.address), toYieldFixedPtAmt("1"));

    await depositIntoBond(depositBond, toFixedPtAmt("1000"), deployer);
    await initialDepositTranche.approve(perp.address, toFixedPtAmt("500"));

    await perp.deposit(initialDepositTranche.address, toFixedPtAmt("500"));
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#redeem", function () {
    describe("when user has insufficient balance", function () {
      beforeEach(async function () {
        await perp.burn(toFixedPtAmt("250"));
      });

      it("should revert", async function () {
        expect(await perp.balanceOf(deployerAddress)).to.lte(toFixedPtAmt("500"));
        await expect(perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.revertedWith(
          "ERC20: burn amount exceeds balance",
        );
      });
    });

    describe("when requested amount is zero", function () {
      it("should revert", async function () {
        await expect(perp.redeem(initialDepositTranche.address, toFixedPtAmt("0"))).to.revertedWith(
          "Expected to burn a non-zero amount of tokens",
        );
      });
    });

    describe("when tranche price is zero", function () {
      beforeEach(async function () {
        await pricingStrategy.setPrice(toPriceFixedPtAmt("0"));
      });

      it("should revert", async function () {
        await expect(perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.revertedWith(
          "Expected to burn a non-zero amount of tokens",
        );
      });
    });

    describe("when tranche price is 0.5", function () {
      beforeEach(async function () {
        await pricingStrategy.setPrice(toPriceFixedPtAmt("0.5"));
      });

      it("should mint the correct amount", async function () {
        const r = await perp.callStatic.redeem(initialDepositTranche.address, toFixedPtAmt("500"));
        expect(r[0]).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when fee is in native token", function () {
      describe("when fee is zero", function () {
        it("should burn perp tokens", async function () {
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("-500"),
          );
        });
        it("should transfer the tranches out", async function () {
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalances(
            initialDepositTranche,
            [deployer, perp],
            [toFixedPtAmt("500"), toFixedPtAmt("-500")],
          );
        });
        it("should return the burnAmt and fee", async function () {
          const r = await perp.callStatic.redeem(initialDepositTranche.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("0"));
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
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("-501"),
          );
        });
        it("should withhold fee", async function () {
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            perp,
            toFixedPtAmt("1"),
          );
        });
        it("should transfer the tranches out", async function () {
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalances(
            initialDepositTranche,
            [deployer, perp],
            [toFixedPtAmt("500"), toFixedPtAmt("-500")],
          );
        });
        it("should return the burnAmt and fee", async function () {
          const r = await perp.callStatic.redeem(initialDepositTranche.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("1"));
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
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("-499"),
          );
        });
        it("should transfer reward", async function () {
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            perp,
            toFixedPtAmt("-1"),
          );
        });
        it("should transfer the tranches out", async function () {
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalances(
            initialDepositTranche,
            [deployer, perp],
            [toFixedPtAmt("500"), toFixedPtAmt("-500")],
          );
        });
        it("should return the burnAmt and fee", async function () {
          const r = await perp.callStatic.redeem(initialDepositTranche.address, toFixedPtAmt("500"));
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
        it("should burn perp tokens", async function () {
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("-500"),
          );
        });
        it("should settle fee", async function () {
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            feeToken,
            deployer,
            toFixedPtAmt("0"),
          );
        });
        it("should transfer the tranches out", async function () {
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalances(
            initialDepositTranche,
            [deployer, perp],
            [toFixedPtAmt("500"), toFixedPtAmt("-500")],
          );
        });
        it("should return the burnAmt and fee", async function () {
          const r = await perp.callStatic.redeem(initialDepositTranche.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("when fee > 0", async function () {
        beforeEach(async function () {
          await feeStrategy.setBurnFee(toFixedPtAmt("1"));
        });

        describe("with no approval", function () {
          it("should revert", async function () {
            await expect(perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.be.revertedWith(
              "ERC20: insufficient allowance",
            );
          });
        });

        describe("with insufficient balance", function () {
          beforeEach(async function () {
            await feeToken.approve(perp.address, toFixedPtAmt("1"));
          });

          it("should revert", async function () {
            await expect(perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.be.revertedWith(
              "ERC20: transfer amount exceeds balance",
            );
          });
        });

        describe("with sufficient fee", async function () {
          beforeEach(async function () {
            await feeStrategy.setBurnFee(toFixedPtAmt("1"));
            await feeToken.mint(deployerAddress, toFixedPtAmt("1"));
            await feeToken.approve(perp.address, toFixedPtAmt("1"));
          });

          it("should burn perp tokens", async function () {
            await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalance(
              perp,
              deployer,
              toFixedPtAmt("-500"),
            );
          });
          it("should transfer fee from redeemer", async function () {
            await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalance(
              feeToken,
              deployer,
              toFixedPtAmt("-1"),
            );
          });
          it("should transfer the tranches out", async function () {
            await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalances(
              initialDepositTranche,
              [deployer, perp],
              [toFixedPtAmt("500"), toFixedPtAmt("-500")],
            );
          });
          it("should return the burnAmt and fee", async function () {
            const r = await perp.callStatic.redeem(initialDepositTranche.address, toFixedPtAmt("500"));
            expect(r[0]).to.eq(toFixedPtAmt("500"));
            expect(r[1]).to.eq(toFixedPtAmt("1"));
          });
        });
      });

      describe("when fee < 0", async function () {
        beforeEach(async function () {
          await feeStrategy.setBurnFee(toFixedPtAmt("-1"));
          await feeToken.mint(perp.address, toFixedPtAmt("1"));
        });

        it("should burn perp tokens", async function () {
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            perp,
            deployer,
            toFixedPtAmt("-500"),
          );
        });
        it("should transfer fee to redeemer", async function () {
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalance(
            feeToken,
            deployer,
            toFixedPtAmt("1"),
          );
        });
        it("should transfer the tranches out", async function () {
          await expect(() => perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.changeTokenBalances(
            initialDepositTranche,
            [deployer, perp],
            [toFixedPtAmt("500"), toFixedPtAmt("-500")],
          );
        });
        it("should return the burnAmt and fee", async function () {
          const r = await perp.callStatic.redeem(initialDepositTranche.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("-1"));
        });
      });
    });

    describe("when redeeming tranche out of order when queue is NOT empty", function () {
      let newRedemptionTranche: Contract;
      beforeEach(async function () {
        await advancePerpQueue(perp, 7200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];
        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));
      });
      it("should revert", async function () {
        expect(initialDepositTranche.address).not.to.eq(newRedemptionTranche.address);
        expect(await perp.callStatic.getRedemptionTranche()).to.eq(newRedemptionTranche.address);
        await expect(perp.redeem(initialDepositTranche.address, toFixedPtAmt("500"))).to.be.revertedWith(
          "Expected to redeem burning tranche or queue to be empty",
        );
      });
    });

    describe("when tranche queue has one element", function () {
      let newRedemptionTranche: Contract, tx: Transaction;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturiy(1200, 3600);

        await advancePerpQueue(perp, 7200);

        const newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newRedemptionTranche = tranches[0];
        await newRedemptionTranche.approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(newRedemptionTranche.address, toFixedPtAmt("500"));

        expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(1);
        expect(await perp.callStatic.getRedemptionQueueAt(0)).to.eq(newRedemptionTranche.address);
        await expect(perp.callStatic.getRedemptionQueueAt(1)).to.be.reverted;
        expect(await perp.callStatic.getRedemptionTranche()).to.eq(newRedemptionTranche.address);
        expect(await perp.reserveCount()).to.eq(2);
        expect(await perp.inReserve(initialDepositTranche.address)).to.eq(true);
        expect(await perp.inReserve(newRedemptionTranche.address)).to.eq(true);
        expect(await perp.reserveAt(0)).to.eq(initialDepositTranche.address);
        expect(await perp.reserveAt(1)).to.eq(newRedemptionTranche.address);
        await expect(perp.reserveAt(2)).to.be.reverted;
      });

      describe("partial redeem", async function () {
        beforeEach(async function () {
          tx = perp.redeem(newRedemptionTranche.address, toFixedPtAmt("250"));
          await tx;
        });
        it("should NOT dequeue", async function () {
          expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(1);
        });
        it("should NOT update the queue", async function () {
          expect(await perp.callStatic.getRedemptionQueueAt(0)).to.eq(newRedemptionTranche.address);
          await expect(perp.callStatic.getRedemptionQueueAt(1)).to.be.reverted;
        });
        it("should NOT update the redemption tranche", async function () {
          expect(await perp.callStatic.getRedemptionTranche()).to.eq(newRedemptionTranche.address);
        });
        it("should NOT emit dequeue", async function () {
          await expect(tx).not.to.emit(perp, "TrancheDequeued").withArgs(newRedemptionTranche.address);
        });
        it("should NOT remove from the reserve", async function () {
          expect(await perp.reserveCount()).to.eq(2);
        });
        it("should NOT update the reserve", async function () {
          expect(await perp.inReserve(initialDepositTranche.address)).to.eq(true);
          expect(await perp.inReserve(newRedemptionTranche.address)).to.eq(true);
          expect(await perp.reserveAt(0)).to.eq(initialDepositTranche.address);
          expect(await perp.reserveAt(1)).to.eq(newRedemptionTranche.address);
          await expect(perp.reserveAt(2)).to.be.reverted;
        });
        it("should emit reserve synced", async function () {
          expect(tx).to.emit(perp, "ReserveSynced").withArgs(newRedemptionTranche.address, toFixedPtAmt("250"));
        });
      });

      describe("full redeem", async function () {
        beforeEach(async function () {
          tx = perp.redeem(newRedemptionTranche.address, toFixedPtAmt("500"));
          await tx;
        });
        it("should dequeue", async function () {
          expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(0);
        });
        it("should update the queue", async function () {
          await expect(perp.callStatic.getRedemptionQueueAt(0)).to.be.reverted;
        });
        it("should update the redemption tranche", async function () {
          expect(await perp.callStatic.getRedemptionTranche()).to.eq(constants.AddressZero);
        });
        it("should emit dequeue", async function () {
          await expect(tx).to.emit(perp, "TrancheDequeued").withArgs(newRedemptionTranche.address);
        });
        it("should remove from the reserve", async function () {
          expect(await perp.reserveCount()).to.eq(1);
        });
        it("should update the reserve", async function () {
          expect(await perp.inReserve(initialDepositTranche.address)).to.eq(true);
          expect(await perp.inReserve(newRedemptionTranche.address)).to.eq(false);
          expect(await perp.reserveAt(0)).to.eq(initialDepositTranche.address);
          await expect(perp.reserveAt(1)).to.be.reverted;
        });
        it("should emit reserve synced", async function () {
          expect(tx).to.emit(perp, "ReserveSynced").withArgs(newRedemptionTranche.address, toFixedPtAmt("0"));
        });
      });

      describe("with remainder", async function () {
        it("should redeem the entire balance", async function () {
          const r = await perp.callStatic.redeem(newRedemptionTranche.address, toFixedPtAmt("1501"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(await newRedemptionTranche.balanceOf(perp.address)).to.eq(toFixedPtAmt("500"));
        });
        describe("queue", function () {
          beforeEach(async function () {
            tx = perp.redeem(newRedemptionTranche.address, toFixedPtAmt("1501"));
            await tx;
          });
          it("should dequeue", async function () {
            expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(0);
          });
          it("should update the queue", async function () {
            await expect(perp.callStatic.getRedemptionQueueAt(0)).to.be.reverted;
          });
          it("should update the redemption tranche", async function () {
            expect(await perp.callStatic.getRedemptionTranche()).to.eq(constants.AddressZero);
          });
          it("should emit dequeue", async function () {
            await expect(tx).to.emit(perp, "TrancheDequeued").withArgs(newRedemptionTranche.address);
          });
          it("should remove from the reserve", async function () {
            expect(await perp.reserveCount()).to.eq(1);
          });
          it("should update the reserve", async function () {
            expect(await perp.inReserve(initialDepositTranche.address)).to.eq(true);
            expect(await perp.inReserve(newRedemptionTranche.address)).to.eq(false);
            expect(await perp.reserveAt(0)).to.eq(initialDepositTranche.address);
            await expect(perp.reserveAt(1)).to.be.reverted;
          });
          it("should emit reserve synced", async function () {
            expect(tx).to.emit(perp, "ReserveSynced").withArgs(newRedemptionTranche.address, toFixedPtAmt("0"));
          });
        });
      });
    });

    describe("when tranche queue has > 1 element", function () {
      let newRedemptionTranche1: Contract, newRedemptionTranche2: Contract, tx: Transaction;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturiy(300, 3600);

        await advancePerpQueue(perp, 7200);

        const newBond1 = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond1, toFixedPtAmt("1000"), deployer);
        const tranches1 = await getTranches(newBond1);
        await tranches1[0].approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(tranches1[0].address, toFixedPtAmt("500"));
        newRedemptionTranche1 = tranches1[0];

        await advancePerpQueue(perp, 1200);

        const newBond2 = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond2, toFixedPtAmt("1000"), deployer);
        const tranches2 = await getTranches(newBond2);
        await tranches2[0].approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(tranches2[0].address, toFixedPtAmt("500"));
        newRedemptionTranche2 = tranches2[0];

        expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(2);
        expect(await perp.callStatic.getRedemptionQueueAt(0)).to.eq(newRedemptionTranche1.address);
        expect(await perp.callStatic.getRedemptionQueueAt(1)).to.eq(newRedemptionTranche2.address);
        await expect(perp.callStatic.getRedemptionQueueAt(2)).to.be.reverted;
        expect(await perp.callStatic.getRedemptionTranche()).to.eq(newRedemptionTranche1.address);

        expect(await perp.reserveCount()).to.eq(3);
        expect(await perp.inReserve(initialDepositTranche.address)).to.eq(true);
        expect(await perp.inReserve(newRedemptionTranche1.address)).to.eq(true);
        expect(await perp.inReserve(newRedemptionTranche2.address)).to.eq(true);
        expect(await perp.reserveAt(0)).to.eq(initialDepositTranche.address);
        expect(await perp.reserveAt(1)).to.eq(newRedemptionTranche1.address);
        expect(await perp.reserveAt(2)).to.eq(newRedemptionTranche2.address);
        await expect(perp.reserveAt(3)).to.be.reverted;
      });

      describe("partial redeem", async function () {
        beforeEach(async function () {
          tx = perp.redeem(newRedemptionTranche1.address, toFixedPtAmt("250"));
          await tx;
        });
        it("should NOT dequeue", async function () {
          expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(2);
        });
        it("should NOT update the queue", async function () {
          expect(await perp.callStatic.getRedemptionQueueAt(0)).to.eq(newRedemptionTranche1.address);
          expect(await perp.callStatic.getRedemptionQueueAt(1)).to.eq(newRedemptionTranche2.address);
          await expect(perp.callStatic.getRedemptionQueueAt(2)).to.be.reverted;
        });
        it("should NOT update the redemption tranche", async function () {
          expect(await perp.callStatic.getRedemptionTranche()).to.eq(newRedemptionTranche1.address);
        });
        it("should NOT emit dequeue", async function () {
          await expect(tx).not.to.emit(perp, "TrancheDequeued").withArgs(newRedemptionTranche1.address);
        });
        it("should NOT remove from the reserve", async function () {
          expect(await perp.reserveCount()).to.eq(3);
        });
        it("should NOT update the reserve", async function () {
          expect(await perp.inReserve(initialDepositTranche.address)).to.eq(true);
          expect(await perp.inReserve(newRedemptionTranche1.address)).to.eq(true);
          expect(await perp.inReserve(newRedemptionTranche2.address)).to.eq(true);
          expect(await perp.reserveAt(0)).to.eq(initialDepositTranche.address);
          expect(await perp.reserveAt(1)).to.eq(newRedemptionTranche1.address);
          expect(await perp.reserveAt(2)).to.eq(newRedemptionTranche2.address);
          await expect(perp.reserveAt(3)).to.be.reverted;
        });
        it("should emit reserve synced", async function () {
          expect(tx).to.emit(perp, "ReserveSynced").withArgs(newRedemptionTranche1.address, toFixedPtAmt("250"));
        });
      });

      describe("full redeem", async function () {
        beforeEach(async function () {
          tx = perp.redeem(newRedemptionTranche1.address, toFixedPtAmt("500"));
          await tx;
        });
        it("should dequeue", async function () {
          expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(1);
        });
        it("should update the queue", async function () {
          expect(await perp.callStatic.getRedemptionQueueAt(0)).to.eq(newRedemptionTranche2.address);
          await expect(perp.callStatic.getRedemptionQueueAt(1)).to.be.reverted;
        });
        it("should update the redemption tranche", async function () {
          expect(await perp.callStatic.getRedemptionTranche()).to.eq(newRedemptionTranche2.address);
        });
        it("should emit dequeue", async function () {
          await expect(tx).to.emit(perp, "TrancheDequeued").withArgs(newRedemptionTranche1.address);
        });
        it("should remove from the reserve", async function () {
          expect(await perp.reserveCount()).to.eq(2);
        });
        it("should update the reserve", async function () {
          expect(await perp.inReserve(initialDepositTranche.address)).to.eq(true);
          expect(await perp.inReserve(newRedemptionTranche2.address)).to.eq(true);
          expect(await perp.reserveAt(0)).to.eq(initialDepositTranche.address);
          expect(await perp.reserveAt(1)).to.eq(newRedemptionTranche2.address);
          await expect(perp.reserveAt(2)).to.be.reverted;
        });
        it("should emit reserve synced", async function () {
          expect(tx).to.emit(perp, "ReserveSynced").withArgs(newRedemptionTranche1.address, toFixedPtAmt("0"));
        });
      });

      describe("with remainder", async function () {
        it("should redeem the entire balance", async function () {
          const r = await perp.callStatic.redeem(newRedemptionTranche1.address, toFixedPtAmt("1200"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(await newRedemptionTranche1.balanceOf(perp.address)).to.eq(toFixedPtAmt("500"));
        });

        describe("queue", async function () {
          beforeEach(async function () {
            tx = perp.redeem(newRedemptionTranche1.address, toFixedPtAmt("1200"));
            await tx;
          });
          it("should dequeue", async function () {
            expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(1);
          });
          it("should update the queue", async function () {
            expect(await perp.callStatic.getRedemptionQueueAt(0)).to.eq(newRedemptionTranche2.address);
            await expect(perp.callStatic.getRedemptionQueueAt(1)).to.be.reverted;
          });
          it("should update the redemption tranche", async function () {
            expect(await perp.callStatic.getRedemptionTranche()).to.eq(newRedemptionTranche2.address);
          });
          it("should emit dequeue", async function () {
            await expect(tx).to.emit(perp, "TrancheDequeued").withArgs(newRedemptionTranche1.address);
          });
          it("should remove from the reserve", async function () {
            expect(await perp.reserveCount()).to.eq(2);
          });
          it("should update the reserve", async function () {
            expect(await perp.inReserve(initialDepositTranche.address)).to.eq(true);
            expect(await perp.inReserve(newRedemptionTranche2.address)).to.eq(true);
            expect(await perp.reserveAt(0)).to.eq(initialDepositTranche.address);
            expect(await perp.reserveAt(1)).to.eq(newRedemptionTranche2.address);
            await expect(perp.reserveAt(2)).to.be.reverted;
          });
          it("should emit reserve synced", async function () {
            expect(tx).to.emit(perp, "ReserveSynced").withArgs(newRedemptionTranche1.address, toFixedPtAmt("0"));
          });
        });
      });
    });

    describe("when tranche queue is empty", function () {
      let queuedTranche1: Contract, queuedTranche2: Contract, tx: Transaction;
      beforeEach(async function () {
        await perp.updateTolerableTrancheMaturiy(300, 3600);

        await advancePerpQueue(perp, 7200);

        const newBond1 = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond1, toFixedPtAmt("1000"), deployer);
        const tranches1 = await getTranches(newBond1);
        await tranches1[0].approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(tranches1[0].address, toFixedPtAmt("500"));
        queuedTranche1 = tranches1[0];

        await advancePerpQueue(perp, 1200);

        const newBond2 = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond2, toFixedPtAmt("1000"), deployer);
        const tranches2 = await getTranches(newBond2);
        await tranches2[0].approve(perp.address, toFixedPtAmt("500"));
        await perp.deposit(tranches2[0].address, toFixedPtAmt("500"));
        queuedTranche2 = tranches2[0];

        await advancePerpQueue(perp, 7200);

        expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(0);
        await expect(perp.callStatic.getRedemptionQueueAt(0)).to.be.reverted;
        expect(await perp.callStatic.getRedemptionTranche()).to.eq(constants.AddressZero);

        expect(await perp.reserveCount()).to.eq(3);
        expect(await perp.inReserve(initialDepositTranche.address)).to.eq(true);
        expect(await perp.inReserve(queuedTranche1.address)).to.eq(true);
        expect(await perp.inReserve(queuedTranche2.address)).to.eq(true);
        expect(await perp.reserveAt(0)).to.eq(initialDepositTranche.address);
        expect(await perp.reserveAt(1)).to.eq(queuedTranche1.address);
        expect(await perp.reserveAt(2)).to.eq(queuedTranche2.address);
        await expect(perp.reserveAt(3)).to.be.reverted;
      });

      describe("partial redeem", function () {
        beforeEach(async function () {
          tx = perp.redeem(queuedTranche2.address, toFixedPtAmt("250"));
          await tx;
        });
        it("should NOT dequeue", async function () {
          expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(0);
        });
        it("should NOT update the queue", async function () {
          await expect(perp.callStatic.getRedemptionQueueAt(0)).to.be.reverted;
        });
        it("should NOT update the redemption tranche", async function () {
          expect(await perp.callStatic.getRedemptionTranche()).to.eq(constants.AddressZero);
        });
        it("should NOT emit dequeue", async function () {
          await expect(tx).not.to.emit(perp, "TrancheDequeued").withArgs(queuedTranche2.address);
        });
        it("should NOT remove from the reserve", async function () {
          expect(await perp.reserveCount()).to.eq(3);
        });
        it("should NOT update the reserve", async function () {
          expect(await perp.inReserve(initialDepositTranche.address)).to.eq(true);
          expect(await perp.inReserve(queuedTranche1.address)).to.eq(true);
          expect(await perp.inReserve(queuedTranche2.address)).to.eq(true);
          expect(await perp.reserveAt(0)).to.eq(initialDepositTranche.address);
          expect(await perp.reserveAt(1)).to.eq(queuedTranche1.address);
          expect(await perp.reserveAt(2)).to.eq(queuedTranche2.address);
          await expect(perp.reserveAt(3)).to.be.reverted;
        });
        it("should emit reserve synced", async function () {
          expect(tx).to.emit(perp, "ReserveSynced").withArgs(queuedTranche2.address, toFixedPtAmt("250"));
        });
      });

      describe("full redeem", function () {
        beforeEach(async function () {
          tx = perp.redeem(queuedTranche2.address, toFixedPtAmt("500"));
          await tx;
        });
        it("should NOT dequeue", async function () {
          expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(0);
        });
        it("should NOT update the queue", async function () {
          await expect(perp.callStatic.getRedemptionQueueAt(0)).to.be.reverted;
        });
        it("should NOT update the redemption tranche", async function () {
          expect(await perp.callStatic.getRedemptionTranche()).to.eq(constants.AddressZero);
        });
        it("should NOT emit dequeue", async function () {
          await expect(tx).not.to.emit(perp, "TrancheDequeued").withArgs(queuedTranche2.address);
        });
        it("should remove from the reserve", async function () {
          expect(await perp.reserveCount()).to.eq(2);
        });
        it("should update the reserve", async function () {
          expect(await perp.inReserve(initialDepositTranche.address)).to.eq(true);
          expect(await perp.inReserve(queuedTranche1.address)).to.eq(true);
          expect(await perp.inReserve(queuedTranche2.address)).to.eq(false);
          expect(await perp.reserveAt(0)).to.eq(initialDepositTranche.address);
          expect(await perp.reserveAt(1)).to.eq(queuedTranche1.address);
          await expect(perp.reserveAt(2)).to.be.reverted;
        });
        it("should emit reserve synced", async function () {
          expect(tx).to.emit(perp, "ReserveSynced").withArgs(queuedTranche2.address, toFixedPtAmt("0"));
        });
      });

      describe("with remainder", function () {
        it("should redeem the entire balance", async function () {
          const r = await perp.callStatic.redeem(queuedTranche2.address, toFixedPtAmt("1900"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(await queuedTranche2.balanceOf(perp.address)).to.eq(toFixedPtAmt("500"));
        });

        describe("queue", function () {
          beforeEach(async function () {
            tx = perp.redeem(queuedTranche2.address, toFixedPtAmt("1200"));
            await tx;
          });
          it("should NOT dequeue", async function () {
            expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(0);
          });
          it("should NOT update the queue", async function () {
            await expect(perp.callStatic.getRedemptionQueueAt(0)).to.be.reverted;
          });
          it("should NOT update the redemption tranche", async function () {
            expect(await perp.callStatic.getRedemptionTranche()).to.eq(constants.AddressZero);
          });
          it("should NOT emit dequeue", async function () {
            await expect(tx).not.to.emit(perp, "TrancheDequeued").withArgs(queuedTranche2.address);
          });
          it("should remove from the reserve", async function () {
            expect(await perp.reserveCount()).to.eq(2);
          });
          it("should update the reserve", async function () {
            expect(await perp.inReserve(initialDepositTranche.address)).to.eq(true);
            expect(await perp.inReserve(queuedTranche1.address)).to.eq(true);
            expect(await perp.inReserve(queuedTranche2.address)).to.eq(false);
            expect(await perp.reserveAt(0)).to.eq(initialDepositTranche.address);
            expect(await perp.reserveAt(1)).to.eq(queuedTranche1.address);
            await expect(perp.reserveAt(2)).to.be.reverted;
          });
          it("should emit reserve synced", async function () {
            expect(tx).to.emit(perp, "ReserveSynced").withArgs(queuedTranche2.address, toFixedPtAmt("0"));
          });
        });
      });
    });
  });
});
