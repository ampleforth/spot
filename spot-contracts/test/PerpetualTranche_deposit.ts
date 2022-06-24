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
  checkReserveComposition,
} from "./helpers";

let perp: Contract,
  bondFactory: Contract,
  collateralToken: Contract,
  issuer: Contract,
  feeStrategy: Contract,
  pricingStrategy: Contract,
  yieldStrategy: Contract,
  deployer: Signer,
  deployerAddress: string,
  depositBond: Contract,
  depositTrancheA: Contract,
  depositTrancheZ: Contract;
describe("PerpetualTranche", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");
    
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

    const YieldStrategy = await ethers.getContractFactory("MockYieldStrategy");
    yieldStrategy = await YieldStrategy.deploy();

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
        yieldStrategy.address,
      ],
      {
        initializer: "init(string,string,address,address,address,address,address)",
      },
    );
    await advancePerpQueue(perp, 3600);

    depositBond = await bondAt(await perp.callStatic.getDepositBond());
    [depositTrancheA, depositTrancheZ] = await getTranches(depositBond);

    await feeStrategy.setFeeToken(perp.address);
    await feeStrategy.setMintFee(toFixedPtAmt("0"));
    await pricingStrategy.setTranchePrice(depositTrancheA.address, toPriceFixedPtAmt("1"));
    await yieldStrategy.setTrancheYield(depositTrancheA.address, toYieldFixedPtAmt("1"));

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
          "UnacceptableDepositTranche",
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

    describe("when the supply cap is exceeded", function () {
      beforeEach(async function () {
        await perp.updateMintingLimits(toFixedPtAmt("499"), toFixedPtAmt("1000"));
      });

      it("should mint the correct amount", async function () {
        await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.revertedWith("ExceededMaxSupply");
      });
    });

    describe("when the supply cap is exceeded and existing supply > 0", function () {
      beforeEach(async function () {
        await perp.deposit(depositTrancheA.address, toFixedPtAmt("400"));
        await perp.updateMintingLimits(toFixedPtAmt("499"), toFixedPtAmt("1000"));
      });

      it("should mint the correct amount", async function () {
        await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("100"))).to.revertedWith(
          "ExceededMaxSupply(500000000000000000000, 499000000000000000000)",
        );
      });
    });

    describe("when the tranche mint limit is exceeded", function () {
      beforeEach(async function () {
        await perp.updateMintingLimits(toFixedPtAmt("1000"), toFixedPtAmt("499"));
      });

      it("should mint the correct amount", async function () {
        await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.revertedWith(
          "ExceededMaxMintPerTranche",
        );
      });
    });

    describe("when the tranche mint limit is exceeded and existing supply > 0", function () {
      beforeEach(async function () {
        await perp.deposit(depositTrancheA.address, toFixedPtAmt("400"));
        await perp.updateMintingLimits(toFixedPtAmt("1000"), toFixedPtAmt("499"));
      });

      it("should mint the correct amount", async function () {
        await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("100"))).to.revertedWith(
          `ExceededMaxMintPerTranche("${depositTrancheA.address}", 500000000000000000000, 499000000000000000000)`,
        );
      });
    });

    describe("when tranche amount is zero", function () {
      it("should revert", async function () {
        await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("0"))).to.revertedWith("UnacceptableMintAmt");
      });
    });

    describe("when tranche price is zero", function () {
      beforeEach(async function () {
        await pricingStrategy.setTranchePrice(depositTrancheA.address, toPriceFixedPtAmt("0"));
      });

      it("should revert", async function () {
        await expect(perp.deposit(depositTrancheA.address, toFixedPtAmt("500"))).to.revertedWith("UnacceptableMintAmt");
      });
    });

    describe("when tranche yield is zero", function () {
      it("should revert", async function () {
        await expect(perp.deposit(depositTrancheZ.address, toFixedPtAmt("500"))).to.revertedWith("UnacceptableMintAmt");
      });
    });

    describe("when total supply is zero", function () {
      describe("when tranche price is 0.5", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(depositTrancheA.address, toPriceFixedPtAmt("0.5"));
        });

        it("should mint the correct amount", async function () {
          const r = await perp.computeMintAmt(depositTrancheA.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("250"));
          expect(r[1]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when tranche yield is 0.5", function () {
        beforeEach(async function () {
          await yieldStrategy.setTrancheYield(depositTrancheA.address, toYieldFixedPtAmt("0.5"));
        });

        it("should mint the correct amount", async function () {
          const r = await perp.computeMintAmt(depositTrancheA.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("250"));
          expect(r[1]).to.eq(toFixedPtAmt("250"));
        });
      });

      describe("when tranche yield is 0.5 and tranche price is 0.5", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(depositTrancheA.address, toPriceFixedPtAmt("0.5"));
          await yieldStrategy.setTrancheYield(depositTrancheA.address, toYieldFixedPtAmt("0.5"));
        });

        it("should mint the correct amount", async function () {
          const r = await perp.computeMintAmt(depositTrancheA.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("125"));
          expect(r[1]).to.eq(toFixedPtAmt("250"));
        });
      });
    });

    describe("when total supply > zero", function () {
      let newBond: Contract, newTranche: Contract;
      beforeEach(async function () {
        await yieldStrategy.setTrancheYield(depositTrancheA.address, toYieldFixedPtAmt("1"));
        await pricingStrategy.setTranchePrice(depositTrancheA.address, toPriceFixedPtAmt("1"));
        await perp.deposit(depositTrancheA.address, toFixedPtAmt("200"));

        await advancePerpQueue(perp, 1200);
        newBond = await bondAt(await perp.callStatic.getDepositBond());
        await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
        const tranches = await getTranches(newBond);
        newTranche = tranches[0];
        await newTranche.approve(perp.address, toFixedPtAmt("250"));
      });

      describe("when price is eql to avg reserve price", function () {
        describe("when yield is 1", function () {
          beforeEach(async function () {
            await yieldStrategy.setTrancheYield(newTranche.address, toYieldFixedPtAmt("1"));
            await pricingStrategy.setTranchePrice(newTranche.address, toPriceFixedPtAmt("1"));
          });

          it("should mint the correct amount", async function () {
            const r = await perp.computeMintAmt(newTranche.address, toFixedPtAmt("250"));
            expect(r[0]).to.eq(toFixedPtAmt("250"));
            expect(r[1]).to.eq(toFixedPtAmt("250"));
          });
        });

        describe("when yield < 1", function () {
          beforeEach(async function () {
            await yieldStrategy.setTrancheYield(newTranche.address, toYieldFixedPtAmt("0.5"));
            await pricingStrategy.setTranchePrice(newTranche.address, toPriceFixedPtAmt("1"));
          });

          it("should mint the correct amount", async function () {
            const r = await perp.computeMintAmt(newTranche.address, toFixedPtAmt("250"));
            expect(r[0]).to.eq(toFixedPtAmt("125"));
            expect(r[1]).to.eq(toFixedPtAmt("125"));
          });
        });

        describe("when yield > 1", function () {
          beforeEach(async function () {
            await yieldStrategy.setTrancheYield(newTranche.address, toYieldFixedPtAmt("2"));
            await pricingStrategy.setTranchePrice(newTranche.address, toPriceFixedPtAmt("1"));
          });

          it("should mint the correct amount", async function () {
            const r = await perp.computeMintAmt(newTranche.address, toFixedPtAmt("250"));
            expect(r[0]).to.eq(toFixedPtAmt("500"));
            expect(r[1]).to.eq(toFixedPtAmt("500"));
          });
        });
      });

      describe("when price is > avg reserve price", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(depositTrancheA.address, toPriceFixedPtAmt("0.5"));
          await yieldStrategy.setTrancheYield(newTranche.address, toYieldFixedPtAmt("1"));
          await pricingStrategy.setTranchePrice(newTranche.address, toPriceFixedPtAmt("1"));
        });

        it("should mint the correct amount", async function () {
          const r = await perp.computeMintAmt(newTranche.address, toFixedPtAmt("250"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("250"));
        });
      });

      describe("when price is < avg reserve price", function () {
        beforeEach(async function () {
          await pricingStrategy.setTranchePrice(depositTrancheA.address, toPriceFixedPtAmt("2"));
          await yieldStrategy.setTrancheYield(newTranche.address, toYieldFixedPtAmt("1"));
          await pricingStrategy.setTranchePrice(newTranche.address, toPriceFixedPtAmt("1"));
        });

        it("should mint the correct amount", async function () {
          const r = await perp.computeMintAmt(newTranche.address, toFixedPtAmt("250"));
          expect(r[0]).to.eq(toFixedPtAmt("125"));
          expect(r[1]).to.eq(toFixedPtAmt("250"));
        });
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
        it("should return the mintAmt and std tranche amt", async function () {
          const r = await perp.computeMintAmt(depositTrancheA.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("500"));
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
        it("should return the mintAmt and std tranche amt", async function () {
          const r = await perp.computeMintAmt(depositTrancheA.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("500"));
        });
      });
      describe("when fee < 0", function () {
        beforeEach(async function () {
          await depositIntoBond(await bondAt(await perp.callStatic.getDepositBond()), toFixedPtAmt("2"), deployer);
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
        it("should return the mintAmt and std tranche amt", async function () {
          const r = await perp.computeMintAmt(depositTrancheA.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("500"));
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
        it("should return the mintAmt and std tranche amt", async function () {
          const r = await perp.computeMintAmt(depositTrancheA.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("500"));
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
          it("should return the mintAmt and std tranche amt", async function () {
            const r = await perp.computeMintAmt(depositTrancheA.address, toFixedPtAmt("500"));
            expect(r[0]).to.eq(toFixedPtAmt("500"));
            expect(r[1]).to.eq(toFixedPtAmt("500"));
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
        it("should return the mintAmt and std tranche amt", async function () {
          const r = await perp.computeMintAmt(depositTrancheA.address, toFixedPtAmt("500"));
          expect(r[0]).to.eq(toFixedPtAmt("500"));
          expect(r[1]).to.eq(toFixedPtAmt("500"));
        });
      });
    });

    describe("when the reserve has no tranches", function () {
      let tx: Transaction;
      beforeEach(async function () {
        expect(await perp.callStatic.getDepositBond()).to.eq(depositBond.address);

        await checkReserveComposition(perp, [collateralToken], [toFixedPtAmt("0")]);
        expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(0);
        expect(await perp.totalSupply()).to.eq(0);

        tx = perp.deposit(depositTrancheA.address, toFixedPtAmt("500"));
        await tx;
      });

      it("should NOT update the deposit bond", async function () {
        expect(await perp.callStatic.getDepositBond()).to.eq(depositBond.address);
      });
      it("should emit tranche yield", async function () {
        await expect(tx).to.emit(perp, "YieldApplied").withArgs(depositTrancheA.address, toYieldFixedPtAmt("1"));
      });
      it("should emit reserve synced", async function () {
        await expect(tx).to.emit(perp, "ReserveSynced").withArgs(depositTrancheA.address, toFixedPtAmt("500"));
      });
      it("should update the reserve", async function () {
        await checkReserveComposition(
          perp,
          [collateralToken, depositTrancheA],
          [toFixedPtAmt("0"), toFixedPtAmt("500")],
        );
      });
      it("should update totalTrancheBalance", async function () {
        expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(toFixedPtAmt("500"));
      });
      it("should update the total supply", async function () {
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("when the reserve has tranches", function () {
      beforeEach(async function () {
        await perp.deposit(depositTrancheA.address, toFixedPtAmt("200"));

        expect(await perp.callStatic.getDepositBond()).to.eq(depositBond.address);
        await checkReserveComposition(
          perp,
          [collateralToken, depositTrancheA],
          [toFixedPtAmt("0"), toFixedPtAmt("200")],
        );

        expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(toFixedPtAmt("200"));
        expect(await perp.totalSupply()).to.eq(toFixedPtAmt("200"));
      });

      describe("when inserting the an existing tranche", async function () {
        let tx: Transaction;
        beforeEach(async function () {
          tx = perp.deposit(depositTrancheA.address, toFixedPtAmt("300"));
          await tx;
        });

        it("should NOT update the deposit bond", async function () {
          expect(await perp.callStatic.getDepositBond()).to.eq(depositBond.address);
        });
        it("should NOT emit tranche yield", async function () {
          await expect(tx).not.to.emit(perp, "YieldApplied").withArgs(depositTrancheA.address, toYieldFixedPtAmt("1"));
        });
        it("should emit reserve synced", async function () {
          await expect(tx).to.emit(perp, "ReserveSynced").withArgs(depositTrancheA.address, toFixedPtAmt("500"));
        });
        it("should update the reserve", async function () {
          await checkReserveComposition(
            perp,
            [collateralToken, depositTrancheA],
            [toFixedPtAmt("0"), toFixedPtAmt("500")],
          );
        });
        it("should update totalTrancheBalance", async function () {
          expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(toFixedPtAmt("500"));
        });
        it("should update the total supply", async function () {
          expect(await perp.totalSupply()).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when inserting a new tranche", function () {
        let newBond: Contract, newTranche: Contract, tx: Transaction;
        beforeEach(async function () {
          await advancePerpQueue(perp, 1200);

          newBond = await bondAt(await perp.callStatic.getDepositBond());
          await depositIntoBond(newBond, toFixedPtAmt("1000"), deployer);
          const tranches = await getTranches(newBond);
          newTranche = tranches[0];
          await yieldStrategy.setTrancheYield(newTranche.address, toYieldFixedPtAmt("0.5"));
          await pricingStrategy.setTranchePrice(newTranche.address, toPriceFixedPtAmt("0.2"));

          await checkReserveComposition(
            perp,
            [collateralToken, depositTrancheA],
            [toFixedPtAmt("0"), toFixedPtAmt("200")],
          );
          expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(toFixedPtAmt("200"));
          expect(await perp.totalSupply()).to.eq(toFixedPtAmt("200"));

          await newTranche.approve(perp.address, toFixedPtAmt("250"));
          tx = perp.deposit(newTranche.address, toFixedPtAmt("250"));
          await tx;
        });

        it("should update the deposit bond", async function () {
          expect(await perp.callStatic.getDepositBond()).to.eq(newBond.address);
        });
        it("should emit tranche yield", async function () {
          await expect(tx).to.emit(perp, "YieldApplied").withArgs(newTranche.address, toYieldFixedPtAmt("0.5"));
        });
        it("should emit reserve synced", async function () {
          await expect(tx).to.emit(perp, "ReserveSynced").withArgs(newTranche.address, toFixedPtAmt("250"));
        });
        it("should update the reserve", async function () {
          await checkReserveComposition(
            perp,
            [collateralToken, depositTrancheA, newTranche],
            [toFixedPtAmt("0"), toFixedPtAmt("200"), toFixedPtAmt("250")],
          );
        });
        it("should update totalTrancheBalance", async function () {
          expect((await perp.callStatic.getStdTrancheBalances())[0]).to.eq(toFixedPtAmt("325"));
        });
        it("should update the total supply", async function () {
          expect(await perp.totalSupply()).to.eq(toFixedPtAmt("225"));
        });
      });
    });
  });
});
