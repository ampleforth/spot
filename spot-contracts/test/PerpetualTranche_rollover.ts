import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Transaction, Signer } from "ethers";

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
  iceboxBond1: Contract,
  iceboxTranche1: Contract,
  iceboxBond2: Contract,
  iceboxTranche2: Contract,
  rotationInBond: Contract,
  rotationInTranche: Contract;

describe("PerpetualNoteTranche", function () {
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

    const PerpetualNoteTranche = await ethers.getContractFactory("PerpetualNoteTranche");
    perp = await upgrades.deployProxy(
      PerpetualNoteTranche.connect(deployer),
      ["PerpetualNoteTranche", "PERP", 9, issuer.address, feeStrategy.address, pricingStrategy.address],
      {
        initializer: "init(string,string,uint8,address,address,address)",
      },
    );

    await feeStrategy.setFeeToken(perp.address);
    await feeStrategy.setMintFee(toFixedPtAmt("0"));
    await feeStrategy.setBurnFee(toFixedPtAmt("0"));
    await feeStrategy.setRolloverFee(toFixedPtAmt("0"));
    await pricingStrategy.setPrice(toPriceFixedPtAmt("1"));

    await perp.updateTolerableTrancheMaturiy(1200, 3600);
    await advancePerpQueue(perp, 3600);

    iceboxBond1 = await bondAt(await perp.callStatic.getDepositBond());
    [iceboxTranche1] = await getTranches(iceboxBond1);
    await perp.updateDefinedYield(await perp.trancheClass(iceboxTranche1.address), toYieldFixedPtAmt("1"));

    await depositIntoBond(iceboxBond1, toFixedPtAmt("1000"), deployer);
    await iceboxTranche1.approve(perp.address, toFixedPtAmt("500"));
    await perp.deposit(iceboxTranche1.address, toFixedPtAmt("500"));

    await advancePerpQueue(perp, 1200);

    iceboxBond2 = await bondAt(await perp.callStatic.getDepositBond());
    [iceboxTranche2] = await getTranches(iceboxBond2);

    await depositIntoBond(iceboxBond2, toFixedPtAmt("1000"), deployer);
    await iceboxTranche2.approve(perp.address, toFixedPtAmt("500"));
    await perp.deposit(iceboxTranche2.address, toFixedPtAmt("500"));

    await advancePerpQueue(perp, 3600);

    rotationInBond = await bondAt(await perp.callStatic.getDepositBond());
    [rotationInTranche] = await getTranches(rotationInBond);
    await depositIntoBond(rotationInBond, toFixedPtAmt("2000"), deployer);
    await rotationInTranche.approve(perp.address, toFixedPtAmt("1000"));
    await perp.deposit(rotationInTranche.address, toFixedPtAmt("500"));
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#rollover", function () {
    describe("when trancheIn and trancheOut belong to the same bond", function () {
      let tranches: Contract[];
      beforeEach(async function () {
        tranches = await getTranches(rotationInBond);
        await perp.updateDefinedYield(await perp.trancheClass(tranches[1].address), toYieldFixedPtAmt("1"));
      });
      it("should revert", async function () {
        await expect(
          perp.rollover(rotationInTranche.address, tranches[1].address, toFixedPtAmt("500")),
        ).to.revertedWith("UnacceptableRollover");
      });
    });

    describe("when trancheIn is NOT of deposit bond", function () {
      it("should revert", async function () {
        await expect(
          perp.rollover(iceboxTranche2.address, iceboxTranche1.address, toFixedPtAmt("500")),
        ).to.revertedWith("UnacceptableRollover");
      });
    });

    describe("when trancheOut is in the queue", function () {
      let newRotationInTranche: Contract;
      beforeEach(async function () {
        await advancePerpQueue(perp, 1200);
        const newRotationInBond = await bondAt(await perp.callStatic.getDepositBond());
        [newRotationInTranche] = await getTranches(newRotationInBond);
      });
      it("should revert", async function () {
        await expect(
          perp.rollover(newRotationInTranche.address, rotationInTranche.address, toFixedPtAmt("500")),
        ).to.revertedWith("UnacceptableRollover");
      });
    });

    describe("when trancheOut is not in the reserve", function () {
      let maliciousTranche: Contract;
      beforeEach(async function () {
        const bond = await createBondWithFactory(bondFactory, collateralToken, [1, 999], 86400);
        maliciousTranche = (await getTranches(bond))[0];
      });
      it("should revert", async function () {
        await expect(
          perp.rollover(rotationInTranche.address, maliciousTranche.address, toFixedPtAmt("500")),
        ).to.revertedWith("UnacceptableRollover");
      });
    });

    describe("when user has insufficient tranche balance", function () {
      beforeEach(async function () {
        await rotationInTranche.transfer(perp.address, toFixedPtAmt("250"));
      });

      it("should revert", async function () {
        expect(await rotationInTranche.balanceOf(deployerAddress)).to.lte(toFixedPtAmt("500"));
        await expect(
          perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
        ).to.revertedWith("ERC20: transfer amount exceeds balance");
      });
    });

    describe("when user has insufficient approval", function () {
      beforeEach(async function () {
        await rotationInTranche.approve(perp.address, toFixedPtAmt("0"));
      });

      it("should revert", async function () {
        expect(await rotationInTranche.balanceOf(deployerAddress)).to.lte(toFixedPtAmt("500"));
        await expect(
          perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
        ).to.revertedWith("ERC20: transfer amount exceeds allowance");
      });
    });

    describe("when trancheInAmt is zero", function () {
      it("should revert", async function () {
        await expect(
          perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("0")),
        ).to.revertedWith("UnacceptableRolloverAmt");
      });
    });

    describe("when trancheIn price is zero", function () {
      beforeEach(async function () {
        await pricingStrategy.setTranchePrice(rotationInTranche.address, toPriceFixedPtAmt("0"));
        await pricingStrategy.setTranchePrice(iceboxTranche1.address, toPriceFixedPtAmt("1"));
      });

      it("should revert", async function () {
        await expect(
          perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
        ).to.revertedWith("UnacceptableRolloverAmt");
      });
    });

    describe("when trancheOut price is zero", function () {
      beforeEach(async function () {
        await pricingStrategy.setTranchePrice(rotationInTranche.address, toPriceFixedPtAmt("1"));
        await pricingStrategy.setTranchePrice(iceboxTranche1.address, toPriceFixedPtAmt("0"));
      });

      it("should revert", async function () {
        await expect(
          perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
        ).to.revertedWith("UnacceptableRolloverAmt");
      });
    });

    describe("when trancheIn price is 0.5 and trancheOut price is 1", function () {
      beforeEach(async function () {
        await pricingStrategy.setTranchePrice(rotationInTranche.address, toPriceFixedPtAmt("0.5"));
        await pricingStrategy.setTranchePrice(iceboxTranche1.address, toPriceFixedPtAmt("1"));
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.rollover(
          rotationInTranche.address,
          iceboxTranche1.address,
          toFixedPtAmt("500"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when trancheIn price is 1 and trancheOut price is 0.5", function () {
      beforeEach(async function () {
        await pricingStrategy.setTranchePrice(rotationInTranche.address, toPriceFixedPtAmt("1"));
        await pricingStrategy.setTranchePrice(iceboxTranche1.address, toPriceFixedPtAmt("0.5"));
      });

      it("should rollover the correct amount", async function () {
        const r = await perp.callStatic.rollover(
          rotationInTranche.address,
          iceboxTranche1.address,
          toFixedPtAmt("250"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when fee is in native token", function () {
      describe("when fee is zero", function () {
        it("should transfer the tranches in", async function () {
          await expect(() =>
            perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(rotationInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
        });
        it("should transfer the tranches out", async function () {
          await expect(() =>
            perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(iceboxTranche1, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
        });
        it("should charge fee", async function () {
          await expect(() =>
            perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalance(perp, perp, toFixedPtAmt("0"));
        });
        it("should return the trancheOutAmt and fee", async function () {
          const r = await perp.callStatic.rollover(
            rotationInTranche.address,
            iceboxTranche1.address,
            toFixedPtAmt("500"),
          );
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("when fee > 0", function () {
        beforeEach(async function () {
          await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
        });
        it("should transfer the tranches in", async function () {
          await expect(() =>
            perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(rotationInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
        });
        it("should transfer the tranches out", async function () {
          await expect(() =>
            perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(iceboxTranche1, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
        });
        it("should charge fee", async function () {
          await expect(() =>
            perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalance(perp, perp, toFixedPtAmt("1"));
        });
        it("should return the trancheOutAmt and fee", async function () {
          const r = await perp.callStatic.rollover(
            rotationInTranche.address,
            iceboxTranche1.address,
            toFixedPtAmt("500"),
          );
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("1"));
        });
      });

      describe("when fee < 0", function () {
        beforeEach(async function () {
          await perp.transfer(perp.address, toFixedPtAmt("1"));
          await feeStrategy.setRolloverFee(toFixedPtAmt("-1"));
        });
        it("should transfer the tranches in", async function () {
          await expect(() =>
            perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(rotationInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
        });
        it("should transfer the tranches out", async function () {
          await expect(() =>
            perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(iceboxTranche1, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
        });
        it("should charge fee", async function () {
          await expect(() =>
            perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalance(perp, perp, toFixedPtAmt("-1"));
        });
        it("should return the trancheOutAmt and fee", async function () {
          const r = await perp.callStatic.rollover(
            rotationInTranche.address,
            iceboxTranche1.address,
            toFixedPtAmt("500"),
          );
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("-1"));
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
        it("should transfer the tranches in", async function () {
          await expect(() =>
            perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(rotationInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
        });
        it("should transfer the tranches out", async function () {
          await expect(() =>
            perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalances(iceboxTranche1, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
        });
        it("should charge fee", async function () {
          await expect(() =>
            perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
          ).to.changeTokenBalance(feeToken, perp, toFixedPtAmt("0"));
        });
        it("should return the trancheOutAmt and fee", async function () {
          const r = await perp.callStatic.rollover(
            rotationInTranche.address,
            iceboxTranche1.address,
            toFixedPtAmt("500"),
          );
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("when fee > 0", async function () {
        beforeEach(async function () {
          await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
        });

        describe("with no approval", function () {
          it("should revert", async function () {
            await expect(
              perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
            ).to.be.revertedWith("ERC20: insufficient allowance");
          });
        });

        describe("with insufficient balance", function () {
          beforeEach(async function () {
            await feeToken.approve(perp.address, toFixedPtAmt("1"));
          });

          it("should revert", async function () {
            await expect(
              perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
            ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
          });
        });

        describe("with sufficient fee", async function () {
          beforeEach(async function () {
            await feeStrategy.setRolloverFee(toFixedPtAmt("1"));
            await feeToken.mint(deployerAddress, toFixedPtAmt("1"));
            await feeToken.approve(perp.address, toFixedPtAmt("1"));
          });

          it("should transfer the tranches in", async function () {
            await expect(() =>
              perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
            ).to.changeTokenBalances(rotationInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
          });
          it("should transfer the tranches out", async function () {
            await expect(() =>
              perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
            ).to.changeTokenBalances(iceboxTranche1, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
          });
          it("should charge fee", async function () {
            await expect(() =>
              perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
            ).to.changeTokenBalance(feeToken, perp, toFixedPtAmt("1"));
          });
          it("should return the trancheOutAmt and fee", async function () {
            const r = await perp.callStatic.rollover(
              rotationInTranche.address,
              iceboxTranche1.address,
              toFixedPtAmt("500"),
            );
            expect(r[0]).to.eq(toFixedPtAmt("500"));
            expect(r[1]).to.eq(toFixedPtAmt("1"));
          });
        });
      });

      describe("when fee < 0", async function () {
        beforeEach(async function () {
          await feeStrategy.setRolloverFee(toFixedPtAmt("-1"));
        });
        describe("with insufficient balance", function () {
          it("should revert", async function () {
            await expect(
              perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
            ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
          });
        });

        describe("with sufficient balance", function () {
          beforeEach(async function () {
            await feeToken.mint(perp.address, toFixedPtAmt("1"));
          });

          it("should transfer the tranches in", async function () {
            await expect(() =>
              perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
            ).to.changeTokenBalances(rotationInTranche, [deployer, perp], [toFixedPtAmt("-500"), toFixedPtAmt("500")]);
          });
          it("should transfer the tranches out", async function () {
            await expect(() =>
              perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
            ).to.changeTokenBalances(iceboxTranche1, [deployer, perp], [toFixedPtAmt("500"), toFixedPtAmt("-500")]);
          });
          it("should charge fee", async function () {
            await expect(() =>
              perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
            ).to.changeTokenBalance(feeToken, perp, toFixedPtAmt("-1"));
          });
          it("should return the trancheOutAmt and fee", async function () {
            const r = await perp.callStatic.rollover(
              rotationInTranche.address,
              iceboxTranche1.address,
              toFixedPtAmt("500"),
            );
            expect(r[0]).to.eq(toFixedPtAmt("500"));
            expect(r[1]).to.eq(toFixedPtAmt("-1"));
          });
        });
      });
    });

    describe("when trancheIn is part of the queue", async function () {
      let tx: Transaction;
      beforeEach(async function () {
        expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(1);
        expect(await perp.callStatic.getRedemptionQueueAt(0)).to.eq(rotationInTranche.address);
        await expect(perp.callStatic.getRedemptionQueueAt(1)).to.be.reverted;

        expect(await perp.reserveCount()).to.eq(3);
        expect(await perp.inReserve(rotationInTranche.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche1.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche2.address)).to.eq(true);
        expect(await perp.reserveAt(0)).to.eq(iceboxTranche1.address);
        expect(await perp.reserveAt(1)).to.eq(iceboxTranche2.address);
        expect(await perp.reserveAt(2)).to.eq(rotationInTranche.address);
        await expect(perp.reserveAt(3)).to.be.reverted;

        tx = perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("250"));
        await tx;
      });

      it("should NOT update the queue", async function () {
        expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(1);
        expect(await perp.callStatic.getRedemptionQueueAt(0)).to.eq(rotationInTranche.address);
        await expect(perp.callStatic.getRedemptionQueueAt(1)).to.be.reverted;
      });
      it("should NOT emit enqueue", async function () {
        await expect(tx).not.to.emit(perp, "TrancheEnqueued").withArgs(rotationInTranche.address);
      });
      it("should NOT update the reserve", async function () {
        expect(await perp.reserveCount()).to.eq(3);
        expect(await perp.inReserve(rotationInTranche.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche1.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche2.address)).to.eq(true);
        expect(await perp.reserveAt(0)).to.eq(iceboxTranche1.address);
        expect(await perp.reserveAt(1)).to.eq(iceboxTranche2.address);
        expect(await perp.reserveAt(2)).to.eq(rotationInTranche.address);
        await expect(perp.reserveAt(3)).to.be.reverted;
      });
      it("should emit reserve synced", async function () {
        expect(tx).to.emit(perp, "ReserveSynced").withArgs(rotationInTranche.address, toFixedPtAmt("750"));
        expect(tx).to.emit(perp, "ReserveSynced").withArgs(iceboxTranche1.address, toFixedPtAmt("250"));
      });
    });

    describe("when trancheIn is NOT part of the queue", async function () {
      let tx: Transaction, newRotationInTranche: Contract;
      beforeEach(async function () {
        expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(1);
        expect(await perp.callStatic.getRedemptionQueueAt(0)).to.eq(rotationInTranche.address);
        await expect(perp.callStatic.getRedemptionQueueAt(1)).to.be.reverted;

        expect(await perp.reserveCount()).to.eq(3);
        expect(await perp.inReserve(rotationInTranche.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche1.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche2.address)).to.eq(true);
        expect(await perp.reserveAt(0)).to.eq(iceboxTranche1.address);
        expect(await perp.reserveAt(1)).to.eq(iceboxTranche2.address);
        expect(await perp.reserveAt(2)).to.eq(rotationInTranche.address);
        await expect(perp.reserveAt(3)).to.be.reverted;

        await advancePerpQueue(perp, 1200);
        const newRotationInBond = await bondAt(await perp.callStatic.getDepositBond());
        [newRotationInTranche] = await getTranches(newRotationInBond);
        await depositIntoBond(newRotationInBond, toFixedPtAmt("1000"), deployer);
        await newRotationInTranche.approve(perp.address, toFixedPtAmt("1000"));

        tx = perp.rollover(newRotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("250"));
        await tx;
      });

      it("should update the queue", async function () {
        expect(await perp.callStatic.getRedemptionQueueCount()).to.eq(2);
        expect(await perp.callStatic.getRedemptionQueueAt(0)).to.eq(rotationInTranche.address);
        expect(await perp.callStatic.getRedemptionQueueAt(1)).to.eq(newRotationInTranche.address);
        await expect(perp.callStatic.getRedemptionQueueAt(2)).to.be.reverted;
      });
      it("should emit enqueue", async function () {
        await expect(tx).to.emit(perp, "TrancheEnqueued").withArgs(newRotationInTranche.address);
      });
      it("should update the reserve", async function () {
        expect(await perp.reserveCount()).to.eq(4);
        expect(await perp.inReserve(rotationInTranche.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche1.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche2.address)).to.eq(true);
        expect(await perp.inReserve(newRotationInTranche.address)).to.eq(true);
        expect(await perp.reserveAt(0)).to.eq(iceboxTranche1.address);
        expect(await perp.reserveAt(1)).to.eq(iceboxTranche2.address);
        expect(await perp.reserveAt(2)).to.eq(rotationInTranche.address);
        expect(await perp.reserveAt(3)).to.eq(newRotationInTranche.address);
        await expect(perp.reserveAt(4)).to.be.reverted;
      });
      it("should emit reserve synced", async function () {
        expect(tx).to.emit(perp, "ReserveSynced").withArgs(newRotationInTranche.address, toFixedPtAmt("250"));
        expect(tx).to.emit(perp, "ReserveSynced").withArgs(iceboxTranche1.address, toFixedPtAmt("250"));
      });
    });

    describe("when trancheOut is fully redeemed", async function () {
      let tx: Transaction;
      beforeEach(async function () {
        expect(await perp.reserveCount()).to.eq(3);
        expect(await perp.inReserve(rotationInTranche.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche1.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche2.address)).to.eq(true);
        expect(await perp.reserveAt(0)).to.eq(iceboxTranche1.address);
        expect(await perp.reserveAt(1)).to.eq(iceboxTranche2.address);
        expect(await perp.reserveAt(2)).to.eq(rotationInTranche.address);
        await expect(perp.reserveAt(3)).to.be.reverted;

        tx = perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500"));
        await tx;
      });

      it("should update the reserve", async function () {
        expect(await perp.reserveCount()).to.eq(2);
        expect(await perp.inReserve(rotationInTranche.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche1.address)).to.eq(false);
        expect(await perp.inReserve(iceboxTranche2.address)).to.eq(true);
        expect(await perp.reserveAt(0)).to.eq(rotationInTranche.address);
        expect(await perp.reserveAt(1)).to.eq(iceboxTranche2.address);
        await expect(perp.reserveAt(2)).to.be.reverted;
      });
      it("should emit reserve synced", async function () {
        expect(tx).to.emit(perp, "ReserveSynced").withArgs(rotationInTranche.address, toFixedPtAmt("1000"));
        expect(tx).to.emit(perp, "ReserveSynced").withArgs(iceboxTranche1.address, toFixedPtAmt("0"));
      });
    });

    describe("when trancheOut is partially redeemed", async function () {
      let tx: Transaction;
      beforeEach(async function () {
        expect(await perp.reserveCount()).to.eq(3);
        expect(await perp.inReserve(rotationInTranche.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche1.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche2.address)).to.eq(true);
        expect(await perp.reserveAt(0)).to.eq(iceboxTranche1.address);
        expect(await perp.reserveAt(1)).to.eq(iceboxTranche2.address);
        expect(await perp.reserveAt(2)).to.eq(rotationInTranche.address);
        await expect(perp.reserveAt(3)).to.be.reverted;

        tx = perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("100"));
        await tx;
      });

      it("should update the reserve", async function () {
        expect(await perp.reserveCount()).to.eq(3);
        expect(await perp.inReserve(rotationInTranche.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche1.address)).to.eq(true);
        expect(await perp.inReserve(iceboxTranche2.address)).to.eq(true);
        expect(await perp.reserveAt(0)).to.eq(iceboxTranche1.address);
        expect(await perp.reserveAt(1)).to.eq(iceboxTranche2.address);
        expect(await perp.reserveAt(2)).to.eq(rotationInTranche.address);
        await expect(perp.reserveAt(3)).to.be.reverted;
      });

      it("should emit reserve synced", async function () {
        expect(tx).to.emit(perp, "ReserveSynced").withArgs(rotationInTranche.address, toFixedPtAmt("600"));
        expect(tx).to.emit(perp, "ReserveSynced").withArgs(iceboxTranche1.address, toFixedPtAmt("400"));
      });
    });

    describe("when trancheOut is not covered", async function () {
      beforeEach(async function () {
        await pricingStrategy.setTranchePrice(iceboxTranche1.address, toPriceFixedPtAmt("0.5"));
      });

      it("should revert", async function () {
        await expect(
          perp.rollover(rotationInTranche.address, iceboxTranche1.address, toFixedPtAmt("500")),
        ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
      });
    });
  });
});
