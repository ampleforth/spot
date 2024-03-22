import { expect } from "chai";
import { network, ethers } from "hardhat";
import { Contract, Signer } from "ethers";
import {
  TimeHelpers,
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  toFixedPtAmt,
  rebase,
  depositIntoBond,
  getTrancheBalances,
  getTranches,
  getContractFactoryFromExternalArtifacts,
  mintCollteralToken,
  DMock,
} from "../helpers";

let bondFactory: Contract,
  collateralToken: Contract,
  rebaseOracle: Contract,
  helper: Contract,
  accounts: Signer[],
  deployer: Signer,
  deployerAddress: string,
  user: Signer,
  userAddress: string,
  perp: Contract,
  depositBond: Contract,
  depositTranche: Contract;

async function setupContracts() {
  accounts = await ethers.getSigners();
  deployer = accounts[0];
  deployerAddress = await deployer.getAddress();
  user = accounts[1];
  userAddress = await user.getAddress();
  bondFactory = await setupBondFactory();
  ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));
  const HelpersTester = await ethers.getContractFactory("HelpersTester");
  helper = await HelpersTester.deploy();
}

describe("HelpersTester", function () {
  beforeEach(async () => {
    await setupContracts();
  });

  after(async function () {
    await network.provider.request({ method: "hardhat_reset" });
  });

  describe("#timeToMatirity", function () {
    let maturityDate: BigInt, bondLength: BigInt, bond: Contract;
    beforeEach(async function () {
      bondLength = 86400;
      bond = await createBondWithFactory(bondFactory, collateralToken, [1000], bondLength);
      maturityDate = await bond.maturityDate();
    });

    describe("when bond is NOT mature", function () {
      it("should return the time to maturity", async function () {
        await TimeHelpers.setNextBlockTimestamp(Number(maturityDate) - bondLength / 2);
        expect(await helper.secondsToMaturity(bond.target)).to.eq(bondLength / 2);
      });
    });

    describe("when bond is mature", function () {
      it("should return the time to maturity", async function () {
        await TimeHelpers.setNextBlockTimestamp(Number(maturityDate) + 1);
        expect(await helper.secondsToMaturity(bond.target)).to.eq(0);
      });
    });
  });

  describe("#getTranches", function () {
    it("should revert if bond has more than 2 tranches", async function () {
      const bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], 86400);
      await expect(helper.getTranches(bond.target)).to.be.revertedWithCustomError(helper, "UnacceptableTrancheLength");
    });

    it("should return the tranche data", async function () {
      const bond = await createBondWithFactory(bondFactory, collateralToken, [498, 502], 86400);
      const td = await helper.getTranches(bond.target);
      expect(td.tranches.length).to.eq(2);
      expect(td.trancheRatios.length).to.eq(2);
      expect(td.trancheRatios[0]).to.eq(498);
      expect(td.trancheRatios[1]).to.eq(502);
      expect(td.tranches[0]).to.eq((await bond.tranches(0))[0]);
      expect(td.tranches[1]).to.eq((await bond.tranches(1))[0]);
    });
  });

  describe("#trancheAt", function () {
    it("should return the tranche when given index", async function () {
      const bond = await createBondWithFactory(bondFactory, collateralToken, [100, 100, 100, 100, 100, 500], 86400);
      for (let i = 0; i < 6; i++) {
        expect(await helper.trancheAt(bond.target, i)).to.eq((await bond.tranches(i))[0]);
      }
      await expect(helper.trancheAt(bond.target, 7)).to.be.reverted;
    });
  });

  describe("#seniorTranche", function () {
    it("should return the tranche when given index", async function () {
      const bond = await createBondWithFactory(bondFactory, collateralToken, [300, 700], 86400);
      const td = await helper.getTranches(bond.target);
      expect(await helper.seniorTranche(bond.target)).to.eq(td.tranches[0]);
    });
  });

  describe("#seniorTrancheRatio", function () {
    it("should return the tranche when given index", async function () {
      const bond = await createBondWithFactory(bondFactory, collateralToken, [50, 950], 86400);
      const ratio = await helper.seniorTrancheRatio(bond.target);
      expect(ratio).to.eq(50);
    });
  });

  describe("#previewDeposit", function () {
    let bond: Contract;
    beforeEach(async function () {
      bond = await createBondWithFactory(bondFactory, collateralToken, [500, 500], 86400);
    });

    describe("if bond is mature", function () {
      it("should revert", async function () {
        await bond.mature();
        await expect(helper.previewDeposit(bond.target, toFixedPtAmt("1000"))).to.be.revertedWithCustomError(
          helper,
          "UnacceptableDeposit",
        );
      });
    });

    describe("first deposit", function () {
      it("should calculate the tranche balances after deposit", async function () {
        const d = await helper.previewDeposit(bond.target, toFixedPtAmt("1000"));
        expect(d[0].amount).to.eq(toFixedPtAmt("500"));
        expect(d[1].amount).to.eq(toFixedPtAmt("500"));
      });

      it("should be consistent with deposit", async function () {
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        const b = await getTrancheBalances(bond, deployerAddress);
        expect(b[0]).to.eq(toFixedPtAmt("500"));
        expect(b[1]).to.eq(toFixedPtAmt("500"));
      });
    });

    describe("later deposit", function () {
      beforeEach(async function () {
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
      });

      describe("with no supply change", function () {
        beforeEach(async function () {
          await rebase(collateralToken, rebaseOracle, 0);
        });
        it("should calculate the tranche balances after deposit", async function () {
          const d = await helper.previewDeposit(bond.target, toFixedPtAmt("1000"));
          expect(d[0].amount).to.eq(toFixedPtAmt("500"));
          expect(d[1].amount).to.eq(toFixedPtAmt("500"));
        });

        it("should be consistent with deposit", async function () {
          await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
          const b = await getTrancheBalances(bond, deployerAddress);
          expect(b[0]).to.eq(toFixedPtAmt("1000")); // 500 + 500
          expect(b[1]).to.eq(toFixedPtAmt("1000"));
        });
      });

      describe("with supply increase", function () {
        beforeEach(async function () {
          await rebase(collateralToken, rebaseOracle, +0.25);
        });
        it("should calculate the tranche balances after deposit", async function () {
          const d = await helper.previewDeposit(bond.target, toFixedPtAmt("1000"));
          expect(d[0].amount).to.eq(toFixedPtAmt("400"));
          expect(d[1].amount).to.eq(toFixedPtAmt("400"));
        });

        it("should be consistent with deposit", async function () {
          await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
          const b = await getTrancheBalances(bond, deployerAddress);
          expect(b[0]).to.eq(toFixedPtAmt("900")); // 500 + 400
          expect(b[1]).to.eq(toFixedPtAmt("900"));
        });
      });

      describe("with supply decrease", function () {
        beforeEach(async function () {
          await rebase(collateralToken, rebaseOracle, -0.5);
        });
        it("should calculate the tranche balances after deposit", async function () {
          const d = await helper.previewDeposit(bond.target, toFixedPtAmt("1000"));
          expect(d[0].amount).to.eq(toFixedPtAmt("1000"));
          expect(d[1].amount).to.eq(toFixedPtAmt("1000"));
        });
        it("should be consistent with deposit", async function () {
          await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
          const b = await getTrancheBalances(bond, deployerAddress);
          expect(b[0]).to.eq(toFixedPtAmt("1500")); // 500 + 1000
          expect(b[1]).to.eq(toFixedPtAmt("1500"));
        });
      });
    });
  });
});

describe("BondTranchesHelpers", function () {
  beforeEach(async () => {
    await setupContracts();
  });

  after(async function () {
    await network.provider.request({ method: "hardhat_reset" });
  });

  describe("#computeRedeemableTrancheAmounts", function () {
    describe("when the user has all the tranches in the right proportions", function () {
      async function checkRedeemableAmts(
        trancheRatios: number[] = [],
        amounts: string[] = [],
        redemptionAmts: string[] = [],
      ) {
        const bond = await createBondWithFactory(bondFactory, collateralToken, trancheRatios, 86400);
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);

        const tranches = await getTranches(bond);
        for (const a in amounts) {
          await tranches[a].transfer(userAddress, toFixedPtAmt(amounts[a]));
        }
        const b = await helper["computeRedeemableTrancheAmounts(address,address)"](bond.target, userAddress);
        for (const a in redemptionAmts) {
          expect(b[1][a]).to.eq(toFixedPtAmt(redemptionAmts[a]));
        }
        if (b[1][0] > 0n) {
          await bond.connect(user).redeem([b[1][0], b[1][1]]);
        }
      }

      describe("when the user has the entire supply", function () {
        describe("[200,800]:[200,800]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([200, 800], ["200", "800"], ["200", "800"]);
          });
        });
      });

      describe("when the user does not have the entire supply", function () {
        describe("[200,800]:[10, 15, 25]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([200, 800], ["10", "40"], ["10", "40"]);
          });
        });
      });
    });

    describe("when the user does not have tranches right proportions", function () {
      async function checkRedeemableAmts(
        trancheRatios: BigInt[] = [],
        amounts: string[] = [],
        redemptionAmts: string[] = [],
      ) {
        const bond = await createBondWithFactory(bondFactory, collateralToken, trancheRatios, 86400);
        const amt = amounts
          .map((a, i) => (toFixedPtAmt(a) * BigInt("1000")) / BigInt(trancheRatios[i]))
          .reduce((m, a) => (m > a ? m : a), 0n);
        await depositIntoBond(bond, amt + toFixedPtAmt("1"), deployer);

        const tranches = await getTranches(bond);
        for (const a in amounts) {
          await tranches[a].transfer(userAddress, toFixedPtAmt(amounts[a]));
        }
        const b = await helper["computeRedeemableTrancheAmounts(address,address)"](bond.target, userAddress);
        for (const a in redemptionAmts) {
          expect(b[1][a]).to.eq(toFixedPtAmt(redemptionAmts[a]));
        }
        if (b[1][0] > 0n) {
          await bond.connect(user).redeem([b[1][0], b[1][1]]);
        }
      }

      describe("[200,800]:[9, 40]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["9", "40"], ["9", "36"]);
        });
      });

      describe("[200,800]:[10, 265]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["10", "265"], ["10", "40"]);
        });
      });

      describe("[200,800]:[10, 32]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["10", "32"], ["8", "32"]);
        });
      });

      describe("[200,800]:[100, 9]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["100", "9"], ["2.25", "9"]);
        });
      });

      describe("[200,800]:[10, 0.8]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["10", "0.8"], ["0.2", "0.8"]);
        });
      });

      describe("[200,800]:[10, 0]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["10", "0"], ["0", "0"]);
        });
      });

      describe("[200,800]:[0, 40]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["0", "40"], ["0", "0"]);
        });
      });

      describe("imperfect rounding", function () {
        describe("[200,800]:[10, 22.461048491123254231]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts(
              [200, 800],
              ["10", "22.461048491123254231"],
              ["5.6152621227808134", "22.4610484911232536"],
            );
          });
        });

        describe("[200,800]:[1000e-18,801e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([200, 800], ["1000e-18", "801e-18"], ["200e-18", "800e-18"]);
          });
        });

        describe("[200,800]:[1000e-18,1001e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([200, 800], ["1000e-18", "1001e-18"], ["200e-18", "800e-18"]);
          });
        });

        describe("[200,800]:[1000e-18,1601e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([200, 800], ["1000e-18", "1601e-18"], ["400e-18", "1600e-18"]);
          });
        });

        describe("[1,999]:[1000e-18,2001e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([1, 999], ["1000e-18", "2001e-18"], ["2e-18", "1998e-18"]);
          });
        });

        describe("[1,999]:[5e-18,1]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([1, 999], ["5e-18", "1"], ["5e-18", "4995e-18"]);
          });
        });

        describe("[499,501]:[1232e-18,1]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([499, 501], ["1232e-18", "1"], ["998e-18", "1002e-18"]);
          });
        });

        describe("[499,501]:[1,499e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([499, 501], ["1", "499e-18"], ["0", "0"]);
          });
        });

        describe("[499,501]:[13224e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([499, 501], ["1", "1322e-18"], ["998e-18", "1002e-18"]);
          });
        });
      });
    });
  });

  describe("#computeRedeemableTrancheAmounts", function () {
    let bond: Contract;
    describe("when balances are in the right proportions", function () {
      async function checkRedeemableAmts(
        trancheRatios: number[] = [],
        amounts: string[] = [],
        redemptionAmts: string[] = [],
      ) {
        bond = await createBondWithFactory(bondFactory, collateralToken, trancheRatios, 86400);
        const b = await helper["computeRedeemableTrancheAmounts(address,uint256[])"](
          bond.target,
          amounts.map(toFixedPtAmt),
        );
        for (const a in redemptionAmts) {
          expect(b[1][a]).to.eq(toFixedPtAmt(redemptionAmts[a]));
        }
      }

      describe("[200,800]:[200,800]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["200", "800"], ["200", "800"]);
        });
      });

      describe("[200,800]:[6, 9, 15]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["6", "24"], ["6", "24"]);
        });
      });

      describe("[200,800]:[202, 808]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["202", "808"], ["202", "808"]);
        });
      });

      describe("when the bond has a balance", async function () {
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);

        describe("[200,800]:[202, 808]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([200, 800], ["202", "808"], ["202", "808"]);
          });
        });
      });
    });

    describe("when balances are not right proportions", function () {
      async function checkRedeemableAmts(
        trancheRatios: number[] = [],
        amounts: string[] = [],
        redemptionAmts: string[] = [],
      ) {
        const bond = await createBondWithFactory(bondFactory, collateralToken, trancheRatios, 86400);
        const amt = amounts
          .map((a, i) => (toFixedPtAmt(a) * BigInt("1000")) / BigInt(trancheRatios[i]))
          .reduce((m, a) => (m > a ? m : a), 0n);
        await depositIntoBond(bond, amt + toFixedPtAmt("1"), deployer);

        const b = await helper["computeRedeemableTrancheAmounts(address,uint256[])"](
          bond.target,
          amounts.map(toFixedPtAmt),
        );
        for (const a in redemptionAmts) {
          expect(b[1][a]).to.eq(toFixedPtAmt(redemptionAmts[a]));
        }
      }

      describe("[200,800]:[9, 40]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["9", "40"], ["9", "36"]);
        });
      });

      describe("[200,800]:[10, 265]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["10", "265"], ["10", "40"]);
        });
      });

      describe("[200,800]:[10, 32]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["10", "32"], ["8", "32"]);
        });
      });

      describe("[200,800]:[100, 9]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["100", "9"], ["2.25", "9"]);
        });
      });

      describe("[200,800]:[10, 0.8]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["10", "0.8"], ["0.2", "0.8"]);
        });
      });

      describe("[200,800]:[10, 0]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["10", "0"], ["0", "0"]);
        });
      });

      describe("[200,800]:[0, 40]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 800], ["0", "40"], ["0", "0"]);
        });
      });

      describe("imperfect rounding", function () {
        describe("[200,800]:[10, 22.461048491123254231]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts(
              [200, 800],
              ["10", "22.461048491123254231"],
              ["5.6152621227808134", "22.4610484911232536"],
            );
          });
        });

        describe("[200,800]:[1000e-18,801e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([200, 800], ["1000e-18", "801e-18"], ["200e-18", "800e-18"]);
          });
        });

        describe("[200,800]:[1000e-18,1001e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([200, 800], ["1000e-18", "1001e-18"], ["200e-18", "800e-18"]);
          });
        });

        describe("[200,800]:[1000e-18,1601e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([200, 800], ["1000e-18", "1601e-18"], ["400e-18", "1600e-18"]);
          });
        });

        describe("[1,999]:[1000e-18,2001e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([1, 999], ["1000e-18", "2001e-18"], ["2e-18", "1998e-18"]);
          });
        });

        describe("[1,999]:[5e-18,1]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([1, 999], ["5e-18", "1"], ["5e-18", "4995e-18"]);
          });
        });

        describe("[499,501]:[1232e-18,1]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([499, 501], ["1232e-18", "1"], ["998e-18", "1002e-18"]);
          });
        });

        describe("[499,501]:[1,499e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([499, 501], ["1", "499e-18"], ["0", "0"]);
          });
        });

        describe("[499,501]:[13224e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([499, 501], ["1", "1322e-18"], ["998e-18", "1002e-18"]);
          });
        });
      });
    });
  });
});

describe("TrancheHelpers", function () {
  beforeEach(async () => {
    await setupContracts();
  });

  after(async function () {
    await network.provider.request({ method: "hardhat_reset" });
  });

  describe("#getTrancheCollateralizations", function () {
    let bond: Contract, bondLength: BigInt, tranches: Contract[];
    beforeEach(async function () {
      bondLength = 86400;
      bond = await createBondWithFactory(bondFactory, collateralToken, [250, 750], bondLength);
      tranches = await getTranches(bond);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
    });

    describe("when bond has too few tranches", function () {
      it("should return 0", async function () {
        const bond = await createBondWithFactory(bondFactory, collateralToken, [1000], bondLength);
        const tranches = await getTranches(bond);
        await expect(helper.getTrancheCollateralizations(tranches[0].target)).to.be.revertedWithCustomError(
          helper,
          "UnacceptableTrancheLength",
        );
      });
    });

    describe("when bond has too few tranches", function () {
      it("should return 0", async function () {
        const bond = await createBondWithFactory(bondFactory, collateralToken, [100, 200, 700], bondLength);
        const tranches = await getTranches(bond);
        await expect(helper.getTrancheCollateralizations(tranches[0].target)).to.be.revertedWithCustomError(
          helper,
          "UnacceptableTrancheLength",
        );
      });
    });

    describe("when bond has no deposits", function () {
      it("should return 0", async function () {
        const bond = await createBondWithFactory(bondFactory, collateralToken, [333, 667], bondLength);
        const tranches = await getTranches(bond);

        const t0 = await helper.getTrancheCollateralizations(tranches[0].target);
        expect(t0[0]).to.eq("0");
        expect(t0[1]).to.eq("0");

        const t1 = await helper.getTrancheCollateralizations(tranches[1].target);
        expect(t1[0]).to.eq("0");
        expect(t1[1]).to.eq("0");
      });
    });

    describe("when bond not mature", function () {
      describe("when no change in supply", function () {
        it("should calculate the balances", async function () {
          const t0 = await helper.getTrancheCollateralizations(tranches[0].target);
          expect(t0[0]).to.eq(toFixedPtAmt("250"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));

          const t1 = await helper.getTrancheCollateralizations(tranches[1].target);
          expect(t1[0]).to.eq(toFixedPtAmt("750"));
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });

      describe("when supply increases above bond threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, 0.1);
          const t0 = await helper.getTrancheCollateralizations(tranches[0].target);
          expect(t0[0]).to.eq(toFixedPtAmt("250"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));
          const t1 = await helper.getTrancheCollateralizations(tranches[1].target);
          expect(t1[0]).to.eq(toFixedPtAmt("850"));
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });

      describe("when supply decreases below bond threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.1);
          const t0 = await helper.getTrancheCollateralizations(tranches[0].target);
          expect(t0[0]).to.eq(toFixedPtAmt("250"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));
          const t1 = await helper.getTrancheCollateralizations(tranches[1].target);
          expect(t1[0]).to.eq(toFixedPtAmt("650"));
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });

      describe("when supply decreases below junior threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.8);
          const t0 = await helper.getTrancheCollateralizations(tranches[0].target);
          expect(t0[0]).to.eq(toFixedPtAmt("200"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));
          const t1 = await helper.getTrancheCollateralizations(tranches[1].target);
          expect(t1[0]).to.eq("0");
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });
    });

    describe("when bond is mature", function () {
      beforeEach(async function () {
        await TimeHelpers.increaseTime(Number(bondLength));
        await bond.mature(); // NOTE: Any rebase after maturity goes directly to the tranches
      });

      describe("when no change in supply", function () {
        it("should calculate the balances", async function () {
          const t0 = await helper.getTrancheCollateralizations(tranches[0].target);
          expect(t0[0]).to.eq(toFixedPtAmt("250"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));
          const t1 = await helper.getTrancheCollateralizations(tranches[1].target);
          expect(t1[0]).to.eq(toFixedPtAmt("750"));
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });

      describe("when supply increases", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, 0.1);
          const t0 = await helper.getTrancheCollateralizations(tranches[0].target);
          expect(t0[0]).to.eq(toFixedPtAmt("275"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));
          const t1 = await helper.getTrancheCollateralizations(tranches[1].target);
          expect(t1[0]).to.eq(toFixedPtAmt("825"));
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });

      describe("when supply decreases", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.1);
          const t0 = await helper.getTrancheCollateralizations(tranches[0].target);
          expect(t0[0]).to.eq(toFixedPtAmt("225"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));
          const t1 = await helper.getTrancheCollateralizations(tranches[1].target);
          expect(t1[0]).to.eq(toFixedPtAmt("675"));
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });
    });
  });
});

describe("PerpHelpers", function () {
  beforeEach(async () => {
    await setupContracts();

    perp = new DMock(await ethers.getContractFactory("PerpetualTranche"));
    await perp.deploy();
    depositBond = new DMock(await getContractFactoryFromExternalArtifacts("BondController"));
    await depositBond.deploy();
    depositTranche = new DMock(await getContractFactoryFromExternalArtifacts("Tranche"));
    await depositTranche.deploy();

    await perp.mockMethod("depositBond()", [depositBond.target]);
    await perp.mockMethod("totalSupply()", [toFixedPtAmt("100")]);
    await mintCollteralToken(collateralToken, toFixedPtAmt("500"), deployer);
    await collateralToken.transfer(depositBond.target, toFixedPtAmt("500"));
    await depositBond.mockMethod("collateralToken()", [collateralToken.target]);
    await depositBond.mockMethod("tranches(uint256)", [depositTranche.target, 200]);
    await depositBond.mockMethod("totalDebt()", [toFixedPtAmt("500")]);
    await depositTranche.mockMethod("totalSupply()", [toFixedPtAmt("100")]);
  });

  after(async function () {
    await network.provider.request({ method: "hardhat_reset" });
  });

  describe("when perp price = 1", async function () {
    describe("when bond cdr = 1", async function () {
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("100"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("50"));
        expect(r[1]).to.eq(toFixedPtAmt("10"));
      });
    });

    describe("when bond cdr > 1", async function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, 0.1);
      });
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("100"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("55"));
        expect(r[1]).to.eq(toFixedPtAmt("10"));
      });
    });

    describe("when bond cdr < 1", async function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.1);
      });
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("100"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("45"));
        expect(r[1]).to.eq(toFixedPtAmt("10"));
      });
    });

    describe("when bond cdr < 1 and seniors are impaired", async function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.9);
      });
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("100"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("10"));
        expect(r[1]).to.eq(toFixedPtAmt("20"));
      });
    });
  });

  describe("when perp price > 1", async function () {
    describe("when bond cdr = 1", async function () {
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("200"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("100"));
        expect(r[1]).to.eq(toFixedPtAmt("20"));
      });
    });

    describe("when bond cdr > 1", async function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, 0.1);
      });
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("200"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("110"));
        expect(r[1]).to.eq(toFixedPtAmt("20"));
      });
    });

    describe("when bond cdr < 1", async function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.1);
      });
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("200"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("90"));
        expect(r[1]).to.eq(toFixedPtAmt("20"));
      });
    });

    describe("when bond cdr < 1 and seniors are impaired", async function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.9);
      });
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("200"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("20"));
        expect(r[1]).to.eq(toFixedPtAmt("40"));
      });
    });
  });

  describe("when perp price < 1", async function () {
    describe("when bond cdr = 1", async function () {
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("50"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("25"));
        expect(r[1]).to.eq(toFixedPtAmt("5"));
      });
    });

    describe("when bond cdr > 1", async function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, 0.1);
      });
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("50"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("27.5"));
        expect(r[1]).to.eq(toFixedPtAmt("5"));
      });
    });

    describe("when bond cdr < 1", async function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.1);
      });
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("50"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("22.5"));
        expect(r[1]).to.eq(toFixedPtAmt("5"));
      });
    });

    describe("when bond cdr < 1 and seniors are impaired", async function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.9);
      });
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("50"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("5"));
        expect(r[1]).to.eq(toFixedPtAmt("10"));
      });
    });
  });

  describe("imperfect rounding", async function () {
    it("should compute the underlying amount", async function () {
      const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
        perp.target,
        toFixedPtAmt("100"),
        toFixedPtAmt("0.999999999999999999"),
      );
      expect(r[0]).to.eq(toFixedPtAmt("4.999999999999999995"));
      expect(r[1]).to.eq(toFixedPtAmt("0.999999999999999999"));
    });
  });

  describe("when perp supply is zero", function () {
    beforeEach(async function () {
      await perp.mockMethod("totalSupply()", [0n]);
    });

    describe("when bond cdr = 1", async function () {
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("100"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("50"));
        expect(r[1]).to.eq(toFixedPtAmt("10"));
      });
    });

    describe("when bond cdr > 1", async function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, 0.1);
      });
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("100"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("55"));
        expect(r[1]).to.eq(toFixedPtAmt("10"));
      });
    });

    describe("when bond cdr < 1", async function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.1);
      });
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("100"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("45"));
        expect(r[1]).to.eq(toFixedPtAmt("10"));
      });
    });

    describe("when bond cdr < 1 and seniors are impaired", async function () {
      beforeEach(async function () {
        await rebase(collateralToken, rebaseOracle, -0.9);
      });
      it("should compute the underlying amount", async function () {
        const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
          perp.target,
          toFixedPtAmt("100"),
          toFixedPtAmt("10"),
        );
        expect(r[0]).to.eq(toFixedPtAmt("10"));
        expect(r[1]).to.eq(toFixedPtAmt("20"));
      });
    });
  });

  describe("when deposit bond has no deposits yet", function () {
    beforeEach(async function () {
      await depositBond.mockMethod("totalDebt()", [0n]);
      await depositTranche.mockMethod("totalSupply()", [0n]);
    });

    it("should compute the underlying amount", async function () {
      const r = await helper.estimateUnderlyingAmtToTranche.staticCall(
        perp.target,
        toFixedPtAmt("100"),
        toFixedPtAmt("10"),
      );
      expect(r[0]).to.eq(toFixedPtAmt("50"));
      expect(r[1]).to.eq(toFixedPtAmt("10"));
    });
  });
});
