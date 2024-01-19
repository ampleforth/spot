import { expect, use } from "chai";
import { network, ethers } from "hardhat";
import { Contract, Signer } from "ethers";
import { smock } from "@defi-wonderland/smock";

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
} from "../helpers";
use(smock.matchers);

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
  await helper.deployed();
}

describe("HelpersTester", function () {
  beforeEach(async () => {
    await setupContracts();
  });

  after(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#timeToMatirity & #duration", function () {
    let maturityDate: number, bondLength: number, bond: Contract;
    beforeEach(async function () {
      bondLength = 86400;
      bond = await createBondWithFactory(bondFactory, collateralToken, [1000], bondLength);
      maturityDate = (await bond.maturityDate()).toNumber();
    });

    describe("when bond is NOT mature", function () {
      it("should return the time to maturity", async function () {
        await TimeHelpers.setNextBlockTimestamp(maturityDate - bondLength / 2);
        expect(await helper.secondsToMaturity(bond.address)).to.eq(bondLength / 2);
      });
    });

    describe("when bond is mature", function () {
      it("should return the time to maturity", async function () {
        await TimeHelpers.setNextBlockTimestamp(maturityDate + 1);
        expect(await helper.secondsToMaturity(bond.address)).to.eq(0);
      });
    });
  });

  describe("#getTranches", function () {
    let bond: Contract;
    beforeEach(async function () {
      bond = await createBondWithFactory(bondFactory, collateralToken, [201, 301, 498], 86400);
    });

    it("should return the tranche data", async function () {
      const td = await helper.getTranches(bond.address);
      expect(td.tranches.length).to.eq(3);
      expect(td.trancheRatios.length).to.eq(3);
      expect(td.trancheRatios[0]).to.eq(201);
      expect(td.trancheRatios[1]).to.eq(301);
      expect(td.trancheRatios[2]).to.eq(498);
      expect(td.tranches.length).to.eq(3);
      expect(td.tranches[0]).to.eq((await bond.tranches(0))[0]);
      expect(td.tranches[1]).to.eq((await bond.tranches(1))[0]);
      expect(td.tranches[2]).to.eq((await bond.tranches(2))[0]);
    });
  });

  describe("#trancheAt", function () {
    it("should return the tranche when given index", async function () {
      const bond = await createBondWithFactory(bondFactory, collateralToken, [100, 100, 100, 100, 100, 500], 86400);
      const td = await helper.getTranches(bond.address);

      for (const t in td.tranches) {
        expect(await helper.trancheAt(bond.address, parseInt(t))).to.eq(td.tranches[t]);
      }
      await expect(helper.trancheAt(bond.address, 7)).to.be.reverted;
    });
  });

  describe("#getSeniorTranche", function () {
    it("should return the tranche when given index", async function () {
      const bond = await createBondWithFactory(bondFactory, collateralToken, [100, 200, 700], 86400);
      const td = await helper.getTranches(bond.address);
      expect(await helper.getSeniorTranche(bond.address)).to.eq(td.tranches[0]);
    });
  });

  describe("#getSeniorTrancheRatio", function () {
    it("should return the tranche when given index", async function () {
      const bond = await createBondWithFactory(bondFactory, collateralToken, [50, 250, 700], 86400);
      const ratio = await helper.getSeniorTrancheRatio(bond.address);
      expect(ratio).to.eq(50);
    });
  });

  describe("#previewDeposit", function () {
    let bond: Contract;
    beforeEach(async function () {
      bond = await createBondWithFactory(bondFactory, collateralToken, [500, 500], 86400);
    });

    describe("first deposit", function () {
      it("should calculate the tranche balances after deposit", async function () {
        const d = await helper.previewDeposit(bond.address, toFixedPtAmt("1000"));
        expect(d[1][0]).to.eq(toFixedPtAmt("500"));
        expect(d[1][1]).to.eq(toFixedPtAmt("500"));
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
          const d = await helper.previewDeposit(bond.address, toFixedPtAmt("1000"));
          expect(d[1][0]).to.eq(toFixedPtAmt("500"));
          expect(d[1][1]).to.eq(toFixedPtAmt("500"));
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
          const d = await helper.previewDeposit(bond.address, toFixedPtAmt("1000"));
          expect(d[1][0]).to.eq(toFixedPtAmt("400"));
          expect(d[1][1]).to.eq(toFixedPtAmt("400"));
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
          const d = await helper.previewDeposit(bond.address, toFixedPtAmt("1000"));
          expect(d[1][0]).to.eq(toFixedPtAmt("1000"));
          expect(d[1][1]).to.eq(toFixedPtAmt("1000"));
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
    await network.provider.send("hardhat_reset");
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
        const b = await helper["computeRedeemableTrancheAmounts(address,address)"](bond.address, userAddress);
        if (b[1][0].gt("0")) {
          await bond.connect(user).redeem(b[1]);
        }
        for (const a in redemptionAmts) {
          expect(b[1][a]).to.eq(toFixedPtAmt(redemptionAmts[a]));
        }
      }

      describe("when the user has the entire supply", function () {
        describe("[200,300,500]:[200, 300, 500]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([200, 300, 500], ["200", "300", "500"], ["200", "300", "500"]);
          });
        });
      });

      describe("when the user does not have the entire supply", function () {
        describe("[200,300,500]:[10, 15, 25]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([200, 300, 500], ["10", "15", "25"], ["10", "15", "25"]);
          });
        });
      });
    });

    describe("when the user does not have tranches right proportions", function () {
      async function checkRedeemableAmts(
        trancheRatios: number[] = [],
        amounts: string[] = [],
        redemptionAmts: string[] = [],
      ) {
        const bond = await createBondWithFactory(bondFactory, collateralToken, trancheRatios, 86400);
        const amt = amounts
          .map((a, i) => toFixedPtAmt(a).mul("1000").div(trancheRatios[i]))
          .reduce((m, a) => (m.gt(a) ? m : a), toFixedPtAmt("0"));
        await depositIntoBond(bond, amt.add(toFixedPtAmt("1")), deployer);

        const tranches = await getTranches(bond);
        for (const a in amounts) {
          await tranches[a].transfer(userAddress, toFixedPtAmt(amounts[a]));
        }
        const b = await helper["computeRedeemableTrancheAmounts(address,address)"](bond.address, userAddress);
        if (b[1][0].gt("0")) {
          await bond.connect(user).redeem(b[1]);
        }
        for (const a in redemptionAmts) {
          expect(b[1][a]).to.eq(toFixedPtAmt(redemptionAmts[a]));
        }
      }

      describe("[200,300,500]:[9, 15, 25]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["9", "15", "25"], ["9", "13.5", "22.5"]);
        });
      });

      describe("[200,300,500]:[10, 15, 250]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["10", "15", "250"], ["10", "15", "25"]);
        });
      });

      describe("[200,300,500]:[10, 12, 250]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["10", "12", "250"], ["8", "12", "20"]);
        });
      });

      describe("[200,300,500]:[10, 12, 5]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["10", "12", "5"], ["2", "3", "5"]);
        });
      });

      describe("[200,300,500]:[10, 12, 0.5]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["10", "12", "0.5"], ["0.2", "0.3", "0.5"]);
        });
      });

      describe("[200,300,500]:[10, 0, 25]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["10", "0", "25"], ["0", "0", "0"]);
        });
      });

      describe("[200,300,500]:[0, 15, 25]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["0", "15", "25"], ["0", "0", "0"]);
        });
      });

      describe("imperfect rounding", function () {
        describe("[200,300,500]:[10, 15, 7.461048491123254231]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts(
              [200, 300, 500],
              ["10", "15", "7.461048491123254230"],
              ["2.984419396449301600", "4.476629094673952400", "7.461048491123254000"],
            );
          });
        });

        describe("[200,300,500]:[1000e-18,5001e-18,503e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts(
              [200, 300, 500],
              ["1000e-18", "5001e-18", "503e-18"],
              ["200e-18", "300e-18", "500e-18"],
            );
          });
        });

        describe("[200,300,500]:[1000e-18,5001e-18,506e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts(
              [200, 300, 500],
              ["1000e-18", "5001e-18", "506e-18"],
              ["200e-18", "300e-18", "500e-18"],
            );
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
          bond.address,
          amounts.map(toFixedPtAmt),
        );
        for (const a in redemptionAmts) {
          expect(b[1][a]).to.eq(toFixedPtAmt(redemptionAmts[a]));
        }
      }

      describe("[200, 300, 500]:[200, 300, 500]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["200", "300", "500"], ["200", "300", "500"]);
        });
      });

      describe("[200, 300, 500]:[6, 9, 15]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["6", "9", "15"], ["6", "9", "15"]);
        });
      });

      describe("[200, 300, 500]:[202, 303, 505]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["202", "303", "505"], ["202", "303", "505"]);
        });
      });

      describe("when the bond has a balance", async function () {
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);

        describe("[200, 300, 500]:[202, 303, 505]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts([200, 300, 500], ["202", "303", "505"], ["202", "303", "505"]);
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
          .map((a, i) => toFixedPtAmt(a).mul("1000").div(trancheRatios[i]))
          .reduce((m, a) => (m.gt(a) ? m : a), toFixedPtAmt("0"));
        await depositIntoBond(bond, amt.add(toFixedPtAmt("1")), deployer);

        const b = await helper["computeRedeemableTrancheAmounts(address,uint256[])"](
          bond.address,
          amounts.map(toFixedPtAmt),
        );
        for (const a in redemptionAmts) {
          expect(b[1][a]).to.eq(toFixedPtAmt(redemptionAmts[a]));
        }
      }

      describe("[200, 300, 500]:[9, 15, 25]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["9", "15", "25"], ["9", "13.5", "22.5"]);
        });
      });

      describe("[200, 300, 500]:[10, 15, 250]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["10", "15", "250"], ["10", "15", "25"]);
        });
      });

      describe("[200, 300, 500]:[10, 12, 250]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["10", "12", "250"], ["8", "12", "20"]);
        });
      });

      describe("[200, 300, 500]:[10, 12, 5]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["10", "12", "5"], ["2", "3", "5"]);
        });
      });

      describe("[200, 300, 500]:[10, 12, 0.5]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["10", "12", "0.5"], ["0.2", "0.3", "0.5"]);
        });
      });

      describe("[200, 300, 500]:[10, 0, 25]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["10", "0", "25"], ["0", "0", "0"]);
        });
      });

      describe("[200, 300, 500]:[0, 15, 25]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["0", "15", "25"], ["0", "0", "0"]);
        });
      });

      describe("[200, 300, 500]:[10, 15, 0]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["10", "15", "0"], ["0", "0", "0"]);
        });
      });

      describe("[200, 300, 500]:[200, 300, 505]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts([200, 300, 500], ["200", "300", "505"], ["200", "300", "500"]);
        });
      });

      describe("imperfect rounding", function () {
        describe("[200,300,500]:[10, 15, 7.461048491123254231]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts(
              [200, 300, 500],
              ["10", "15", "7.461048491123254230"],
              ["2.984419396449301600", "4.476629094673952400", "7.461048491123254000"],
            );
          });
        });

        describe("[200,300,500]:[1000e-18,5001e-18,503e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts(
              [200, 300, 500],
              ["1000e-18", "5001e-18", "503e-18"],
              ["200e-18", "300e-18", "500e-18"],
            );
          });
        });

        describe("[200,300,500]:[1000e-18,5001e-18,506e-18]", async function () {
          it("should calculate the amounts", async function () {
            await checkRedeemableAmts(
              [200, 300, 500],
              ["1000e-18", "5001e-18", "506e-18"],
              ["200e-18", "300e-18", "500e-18"],
            );
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
    await network.provider.send("hardhat_reset");
  });

  describe("#getTrancheCollateralizations", function () {
    let bond: Contract, bondLength: number, tranches: Contract[];
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
        await expect(helper.getTrancheCollateralizations(tranches[0].address)).to.be.revertedWithCustomError(
          helper,
          "UnacceptableTrancheLength",
        );
      });
    });

    describe("when bond has too few tranches", function () {
      it("should return 0", async function () {
        const bond = await createBondWithFactory(bondFactory, collateralToken, [100, 200, 700], bondLength);
        const tranches = await getTranches(bond);
        await expect(helper.getTrancheCollateralizations(tranches[0].address)).to.be.revertedWithCustomError(
          helper,
          "UnacceptableTrancheLength",
        );
      });
    });

    describe("when bond has no deposits", function () {
      it("should return 0", async function () {
        const bond = await createBondWithFactory(bondFactory, collateralToken, [333, 667], bondLength);
        const tranches = await getTranches(bond);

        const t0 = await helper.getTrancheCollateralizations(tranches[0].address);
        expect(t0[0]).to.eq("0");
        expect(t0[1]).to.eq("0");

        const t1 = await helper.getTrancheCollateralizations(tranches[1].address);
        expect(t1[0]).to.eq("0");
        expect(t1[1]).to.eq("0");
      });
    });

    describe("when bond not mature", function () {
      describe("when no change in supply", function () {
        it("should calculate the balances", async function () {
          const t0 = await helper.getTrancheCollateralizations(tranches[0].address);
          expect(t0[0]).to.eq(toFixedPtAmt("250"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));

          const t1 = await helper.getTrancheCollateralizations(tranches[1].address);
          expect(t1[0]).to.eq(toFixedPtAmt("750"));
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });

      describe("when supply increases above bond threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, 0.1);
          const t0 = await helper.getTrancheCollateralizations(tranches[0].address);
          expect(t0[0]).to.eq(toFixedPtAmt("250"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));
          const t1 = await helper.getTrancheCollateralizations(tranches[1].address);
          expect(t1[0]).to.eq(toFixedPtAmt("850"));
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });

      describe("when supply decreases below bond threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.1);
          const t0 = await helper.getTrancheCollateralizations(tranches[0].address);
          expect(t0[0]).to.eq(toFixedPtAmt("250"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));
          const t1 = await helper.getTrancheCollateralizations(tranches[1].address);
          expect(t1[0]).to.eq(toFixedPtAmt("650"));
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });

      describe("when supply decreases below junior threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.8);
          const t0 = await helper.getTrancheCollateralizations(tranches[0].address);
          expect(t0[0]).to.eq(toFixedPtAmt("200"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));
          const t1 = await helper.getTrancheCollateralizations(tranches[1].address);
          expect(t1[0]).to.eq("0");
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });
    });

    describe("when bond is mature", function () {
      beforeEach(async function () {
        await TimeHelpers.increaseTime(bondLength);
        await bond.mature(); // NOTE: Any rebase after maturity goes directly to the tranches
      });

      describe("when no change in supply", function () {
        it("should calculate the balances", async function () {
          const t0 = await helper.getTrancheCollateralizations(tranches[0].address);
          expect(t0[0]).to.eq(toFixedPtAmt("250"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));
          const t1 = await helper.getTrancheCollateralizations(tranches[1].address);
          expect(t1[0]).to.eq(toFixedPtAmt("750"));
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });

      describe("when supply increases", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, 0.1);
          const t0 = await helper.getTrancheCollateralizations(tranches[0].address);
          expect(t0[0]).to.eq(toFixedPtAmt("275"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));
          const t1 = await helper.getTrancheCollateralizations(tranches[1].address);
          expect(t1[0]).to.eq(toFixedPtAmt("825"));
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });

      describe("when supply decreases", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.1);
          const t0 = await helper.getTrancheCollateralizations(tranches[0].address);
          expect(t0[0]).to.eq(toFixedPtAmt("225"));
          expect(t0[1]).to.eq(toFixedPtAmt("250"));
          const t1 = await helper.getTrancheCollateralizations(tranches[1].address);
          expect(t1[0]).to.eq(toFixedPtAmt("675"));
          expect(t1[1]).to.eq(toFixedPtAmt("750"));
        });
      });
    });
  });

  describe("#getImmatureSeniorTrancheCollateralization", function () {
    let bond: Contract, bondLength: number, tranches: Contract[];
    beforeEach(async function () {
      bondLength = 86400;
      bond = await createBondWithFactory(bondFactory, collateralToken, [250, 750], bondLength);
      tranches = await getTranches(bond);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
    });

    describe("when no change in supply", function () {
      it("should calculate the balances", async function () {
        const t0 = await helper.getImmatureSeniorTrancheCollateralization(tranches[0].address);
        expect(t0[0]).to.eq(toFixedPtAmt("250"));
        expect(t0[1]).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when supply increases above bond threshold", function () {
      it("should calculate the balances", async function () {
        await rebase(collateralToken, rebaseOracle, 0.1);
        const t0 = await helper.getImmatureSeniorTrancheCollateralization(tranches[0].address);
        expect(t0[0]).to.eq(toFixedPtAmt("250"));
        expect(t0[1]).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when supply decreases below bond threshold", function () {
      it("should calculate the balances", async function () {
        await rebase(collateralToken, rebaseOracle, -0.1);
        const t0 = await helper.getImmatureSeniorTrancheCollateralization(tranches[0].address);
        expect(t0[0]).to.eq(toFixedPtAmt("250"));
        expect(t0[1]).to.eq(toFixedPtAmt("250"));
      });
    });

    describe("when supply decreases below junior threshold", function () {
      it("should calculate the balances", async function () {
        await rebase(collateralToken, rebaseOracle, -0.8);
        const t0 = await helper.getImmatureSeniorTrancheCollateralization(tranches[0].address);
        expect(t0[0]).to.eq(toFixedPtAmt("200"));
        expect(t0[1]).to.eq(toFixedPtAmt("250"));
      });
    });
  });
});

describe("PerpHelpers", function () {
  beforeEach(async () => {
    await setupContracts();

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await smock.fake(PerpetualTranche);

    const BondController = await getContractFactoryFromExternalArtifacts("BondController");
    depositBond = await smock.fake(BondController);

    const Tranche = await getContractFactoryFromExternalArtifacts("Tranche");
    depositTranche = await smock.fake(Tranche);

    await perp.getDepositBond.returns(depositBond.address);
    await perp.totalSupply.returns(toFixedPtAmt("100"));

    await mintCollteralToken(collateralToken, toFixedPtAmt("500"), deployer);
    await collateralToken.transfer(depositBond.address, toFixedPtAmt("500"));
    await depositBond.collateralToken.returns(collateralToken.address);
    await depositBond.tranches.whenCalledWith(0).returns([depositTranche.address, 200]);
    await depositBond.totalDebt.returns(toFixedPtAmt("500"));
    await depositTranche.totalSupply.returns(toFixedPtAmt("100"));
  });

  after(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("when perp price = 1", async function () {
    describe("when bond cdr = 1", async function () {
      it("should compute the underlying amount", async function () {
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
      const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
        perp.address,
        toFixedPtAmt("100"),
        toFixedPtAmt("0.999999999999999999"),
      );
      expect(r[0]).to.eq(toFixedPtAmt("4.999999999999999995"));
      expect(r[1]).to.eq(toFixedPtAmt("0.999999999999999999"));
    });
  });

  describe("when perp supply is zero", function () {
    beforeEach(async function () {
      await perp.totalSupply.returns("0");
    });

    describe("when bond cdr = 1", async function () {
      it("should compute the underlying amount", async function () {
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
        const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
          perp.address,
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
      await depositBond.totalDebt.returns("0");
      await depositTranche.totalSupply.returns("0");
    });

    it("should compute the underlying amount", async function () {
      const r = await helper.callStatic.estimateUnderlyingAmtToTranche(
        perp.address,
        toFixedPtAmt("100"),
        toFixedPtAmt("10"),
      );
      expect(r[0]).to.eq(toFixedPtAmt("50"));
      expect(r[1]).to.eq(toFixedPtAmt("10"));
    });
  });
});
