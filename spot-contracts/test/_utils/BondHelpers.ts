import { expect } from "chai";
import { network, ethers } from "hardhat";
import { Contract, Signer, constants } from "ethers";

import {
  TimeHelpers,
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  toFixedPtAmt,
  rebase,
  depositIntoBond,
  getTranches,
  getTrancheBalances,
} from "../helpers";

let bondFactory: Contract,
  collateralToken: Contract,
  rebaseOracle: Contract,
  bondHelpers: Contract,
  accounts: Signer[],
  deployer: Signer,
  deployerAddress: string,
  user: Signer,
  userAddress: string;

async function setupContracts() {
  accounts = await ethers.getSigners();
  deployer = accounts[0];
  deployerAddress = await deployer.getAddress();
  user = accounts[1];
  userAddress = await user.getAddress();

  bondFactory = await setupBondFactory();
  ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));

  const BondHelpersTester = await ethers.getContractFactory("BondHelpersTester");
  bondHelpers = await BondHelpersTester.deploy();
  await bondHelpers.deployed();
}

describe("BondHelpers", function () {
  beforeEach(async () => {
    await setupContracts();
  });

  afterEach(async function () {
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
        expect(await bondHelpers.secondsToMaturity(bond.address)).to.eq(bondLength / 2);
      });
    });

    describe("when bond is mature", function () {
      it("should return the time to maturity", async function () {
        await TimeHelpers.setNextBlockTimestamp(maturityDate + 1);
        expect(await bondHelpers.secondsToMaturity(bond.address)).to.eq(0);
      });
    });
  });

  describe("#getTranches", function () {
    let bond: Contract;
    beforeEach(async function () {
      bond = await createBondWithFactory(bondFactory, collateralToken, [201, 301, 498], 86400);
    });

    it("should return the tranche data", async function () {
      const td = await bondHelpers.getTranches(bond.address);
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

  describe("#indexOf", function () {
    it("should return the tranche index", async function () {
      const bond = await createBondWithFactory(bondFactory, collateralToken, [100, 100, 100, 100, 100, 500], 86400);
      const td = await bondHelpers.getTranches(bond.address);

      for (const t in td.tranches) {
        expect(await bondHelpers.indexOf(bond.address, td.tranches[t])).to.eq(parseInt(t));
      }

      await expect(bondHelpers.indexOf(bond.address, bond.address)).to.be.revertedWithCustomError(
        bondHelpers,
        "UnacceptableTranche",
      );
      await expect(bondHelpers.indexOf(bond.address, deployerAddress)).to.be.revertedWithCustomError(
        bondHelpers,
        "UnacceptableTranche",
      );
      await expect(bondHelpers.indexOf(bond.address, constants.AddressZero)).to.be.revertedWithCustomError(
        bondHelpers,
        "UnacceptableTranche",
      );
    });
  });

  describe("#previewDeposit", function () {
    let bond: Contract;
    beforeEach(async function () {
      bond = await createBondWithFactory(bondFactory, collateralToken, [500, 500], 86400);
    });

    describe("fee = 0", function () {
      describe("first deposit", function () {
        it("should calculate the tranche balances after deposit", async function () {
          const d = await bondHelpers.previewDeposit(bond.address, toFixedPtAmt("1000"));
          expect(d[1][0]).to.eq(toFixedPtAmt("500"));
          expect(d[1][1]).to.eq(toFixedPtAmt("500"));
          expect(d[2][0]).to.eq("0");
          expect(d[2][1]).to.eq("0");
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
            const d = await bondHelpers.previewDeposit(bond.address, toFixedPtAmt("1000"));
            expect(d[1][0]).to.eq(toFixedPtAmt("500"));
            expect(d[1][1]).to.eq(toFixedPtAmt("500"));
            expect(d[2][0]).to.eq("0");
            expect(d[2][1]).to.eq("0");
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
            const d = await bondHelpers.previewDeposit(bond.address, toFixedPtAmt("1000"));
            expect(d[1][0]).to.eq(toFixedPtAmt("400"));
            expect(d[1][1]).to.eq(toFixedPtAmt("400"));
            expect(d[2][0]).to.eq("0");
            expect(d[2][1]).to.eq("0");
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
            const d = await bondHelpers.previewDeposit(bond.address, toFixedPtAmt("1000"));
            expect(d[1][0]).to.eq(toFixedPtAmt("1000"));
            expect(d[1][1]).to.eq(toFixedPtAmt("1000"));
            expect(d[2][0]).to.eq("0");
            expect(d[2][1]).to.eq("0");
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

    describe("fee > 0", function () {
      beforeEach(async function () {
        await bond.setFee(50);
      });

      describe("first deposit", function () {
        it("should calculate the tranche balances after deposit", async function () {
          const d = await bondHelpers.previewDeposit(bond.address, toFixedPtAmt("1000"));
          expect(d[1][0]).to.eq(toFixedPtAmt("497.5"));
          expect(d[1][1]).to.eq(toFixedPtAmt("497.5"));
          expect(d[2][0]).to.eq(toFixedPtAmt("2.5"));
          expect(d[2][1]).to.eq(toFixedPtAmt("2.5"));
        });

        it("should be consistent with deposit", async function () {
          await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
          const b = await getTrancheBalances(bond, deployerAddress);
          expect(b[0]).to.eq(toFixedPtAmt("497.5"));
          expect(b[1]).to.eq(toFixedPtAmt("497.5"));
          const c = await getTrancheBalances(bond, bond.address);
          expect(c[0]).to.eq(toFixedPtAmt("2.5"));
          expect(c[1]).to.eq(toFixedPtAmt("2.5"));
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
            const d = await bondHelpers.previewDeposit(bond.address, toFixedPtAmt("1000"));
            expect(d[1][0]).to.eq(toFixedPtAmt("497.5"));
            expect(d[1][1]).to.eq(toFixedPtAmt("497.5"));
            expect(d[2][0]).to.eq(toFixedPtAmt("2.5"));
            expect(d[2][1]).to.eq(toFixedPtAmt("2.5"));
          });

          it("should be consistent with deposit", async function () {
            await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
            const b = await getTrancheBalances(bond, deployerAddress);
            expect(b[0]).to.eq(toFixedPtAmt("995")); // 497.5 + 497.5
            expect(b[1]).to.eq(toFixedPtAmt("995"));
            const c = await getTrancheBalances(bond, bond.address);
            expect(c[0]).to.eq(toFixedPtAmt("5")); // 2.5 + 2.5
            expect(c[1]).to.eq(toFixedPtAmt("5"));
          });
        });

        describe("with supply increase", function () {
          beforeEach(async function () {
            await rebase(collateralToken, rebaseOracle, +0.25);
          });
          it("should calculate the tranche balances after deposit", async function () {
            const d = await bondHelpers.previewDeposit(bond.address, toFixedPtAmt("1000"));
            expect(d[1][0]).to.eq(toFixedPtAmt("398"));
            expect(d[1][1]).to.eq(toFixedPtAmt("398"));
            expect(d[2][0]).to.eq(toFixedPtAmt("2"));
            expect(d[2][1]).to.eq(toFixedPtAmt("2"));
          });

          it("should be consistent with deposit", async function () {
            await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
            const b = await getTrancheBalances(bond, deployerAddress);
            expect(b[0]).to.eq(toFixedPtAmt("895.5")); // 497.5 + 398
            expect(b[1]).to.eq(toFixedPtAmt("895.5"));
            const c = await getTrancheBalances(bond, bond.address);
            expect(c[0]).to.eq(toFixedPtAmt("4.5")); // 2.5 + 2
            expect(c[1]).to.eq(toFixedPtAmt("4.5"));
          });
        });

        describe("with supply decrease", function () {
          beforeEach(async function () {
            await rebase(collateralToken, rebaseOracle, -0.5);
          });
          it("should calculate the tranche balances after deposit", async function () {
            const d = await bondHelpers.previewDeposit(bond.address, toFixedPtAmt("1000"));
            expect(d[1][0]).to.eq(toFixedPtAmt("995"));
            expect(d[1][1]).to.eq(toFixedPtAmt("995"));
            expect(d[2][0]).to.eq(toFixedPtAmt("5"));
            expect(d[2][1]).to.eq(toFixedPtAmt("5"));
          });
          it("should be consistent with deposit", async function () {
            await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
            const b = await getTrancheBalances(bond, deployerAddress);
            expect(b[0]).to.eq(toFixedPtAmt("1492.5")); // 497.5 + 995
            expect(b[1]).to.eq(toFixedPtAmt("1492.5"));
            const c = await getTrancheBalances(bond, bond.address);
            expect(c[0]).to.eq(toFixedPtAmt("7.5")); // 2.5 + 5
            expect(c[1]).to.eq(toFixedPtAmt("7.5"));
          });
        });
      });
    });
  });

  describe("#getTrancheCollateralizations", function () {
    let bond: Contract, bondLength: number;
    beforeEach(async function () {
      bondLength = 86400;
      bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], bondLength);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
    });

    describe("when bond not mature", function () {
      describe("when no change in supply", function () {
        it("should calculate the balances", async function () {
          const b = await bondHelpers.getTrancheCollateralizations(bond.address);
          expect(b[1][0]).to.eq(toFixedPtAmt("200"));
          expect(b[1][1]).to.eq(toFixedPtAmt("300"));
          expect(b[1][2]).to.eq(toFixedPtAmt("500"));
          expect(b[2][0]).to.eq(toFixedPtAmt("200"));
          expect(b[2][1]).to.eq(toFixedPtAmt("300"));
          expect(b[2][2]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when supply increases above z threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, 0.1);
          const b = await bondHelpers.getTrancheCollateralizations(bond.address);
          expect(b[1][0]).to.eq(toFixedPtAmt("200"));
          expect(b[1][1]).to.eq(toFixedPtAmt("300"));
          expect(b[1][2]).to.eq(toFixedPtAmt("600"));
          expect(b[2][0]).to.eq(toFixedPtAmt("200"));
          expect(b[2][1]).to.eq(toFixedPtAmt("300"));
          expect(b[2][2]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when supply decreases below z threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.1);
          const b = await bondHelpers.getTrancheCollateralizations(bond.address);
          expect(b[1][0]).to.eq(toFixedPtAmt("200"));
          expect(b[1][1]).to.eq(toFixedPtAmt("300"));
          expect(b[1][2]).to.eq(toFixedPtAmt("400"));
          expect(b[2][0]).to.eq(toFixedPtAmt("200"));
          expect(b[2][1]).to.eq(toFixedPtAmt("300"));
          expect(b[2][2]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when supply decreases below b threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.6);
          const b = await bondHelpers.getTrancheCollateralizations(bond.address);
          expect(b[1][0]).to.eq(toFixedPtAmt("200"));
          expect(b[1][1]).to.eq(toFixedPtAmt("200"));
          expect(b[1][2]).to.eq(toFixedPtAmt("0"));
          expect(b[2][0]).to.eq(toFixedPtAmt("200"));
          expect(b[2][1]).to.eq(toFixedPtAmt("300"));
          expect(b[2][2]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when supply decreases below a threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.85);
          const b = await bondHelpers.getTrancheCollateralizations(bond.address);
          expect(b[1][0]).to.eq(toFixedPtAmt("150"));
          expect(b[1][1]).to.eq(toFixedPtAmt("0"));
          expect(b[1][2]).to.eq(toFixedPtAmt("0"));
          expect(b[2][0]).to.eq(toFixedPtAmt("200"));
          expect(b[2][1]).to.eq(toFixedPtAmt("300"));
          expect(b[2][2]).to.eq(toFixedPtAmt("500"));
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
          const b = await bondHelpers.getTrancheCollateralizations(bond.address);
          expect(b[1][0]).to.eq(toFixedPtAmt("200"));
          expect(b[1][1]).to.eq(toFixedPtAmt("300"));
          expect(b[1][2]).to.eq(toFixedPtAmt("500"));
          expect(b[2][0]).to.eq(toFixedPtAmt("200"));
          expect(b[2][1]).to.eq(toFixedPtAmt("300"));
          expect(b[2][2]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when supply increases", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, 0.1);
          const b = await bondHelpers.getTrancheCollateralizations(bond.address);
          expect(b[1][0]).to.eq(toFixedPtAmt("220"));
          expect(b[1][1]).to.eq(toFixedPtAmt("330"));
          expect(b[1][2]).to.eq(toFixedPtAmt("550"));
          expect(b[2][0]).to.eq(toFixedPtAmt("200"));
          expect(b[2][1]).to.eq(toFixedPtAmt("300"));
          expect(b[2][2]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when supply decreases", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.1);
          const b = await bondHelpers.getTrancheCollateralizations(bond.address);
          expect(b[1][0]).to.eq(toFixedPtAmt("180"));
          expect(b[1][1]).to.eq(toFixedPtAmt("270"));
          expect(b[1][2]).to.eq(toFixedPtAmt("450"));
          expect(b[2][0]).to.eq(toFixedPtAmt("200"));
          expect(b[2][1]).to.eq(toFixedPtAmt("300"));
          expect(b[2][2]).to.eq(toFixedPtAmt("500"));
        });
      });
    });
  });

  describe("#computeRedeemableTrancheAmounts", function () {
    let bond: Contract, bondLength: number;
    beforeEach(async function () {
      bondLength = 86400;
      bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], bondLength);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
    });

    describe("when the user has all the tranches in the right proportions", function () {
      describe("when the user has the entire supply", function () {
        it("should calculate the amounts", async function () {
          const b = await bondHelpers.computeRedeemableTrancheAmounts(bond.address, deployerAddress);
          expect(b[1][0]).to.eq(toFixedPtAmt("200"));
          expect(b[1][1]).to.eq(toFixedPtAmt("300"));
          expect(b[1][2]).to.eq(toFixedPtAmt("500"));
        });
      });

      describe("when the user does not have the entire supply", function () {
        beforeEach(async function () {
          const tranches = await getTranches(bond);
          await tranches[0].transfer(userAddress, toFixedPtAmt("10"));
          await tranches[1].transfer(userAddress, toFixedPtAmt("15"));
          await tranches[2].transfer(userAddress, toFixedPtAmt("25"));
        });
        it("should calculate the amounts", async function () {
          const b1 = await bondHelpers.computeRedeemableTrancheAmounts(bond.address, userAddress);
          expect(b1[1][0]).to.eq(toFixedPtAmt("10"));
          expect(b1[1][1]).to.eq(toFixedPtAmt("15"));
          expect(b1[1][2]).to.eq(toFixedPtAmt("25"));

          const b2 = await bondHelpers.computeRedeemableTrancheAmounts(bond.address, deployerAddress);
          expect(b2[1][0]).to.eq(toFixedPtAmt("190"));
          expect(b2[1][1]).to.eq(toFixedPtAmt("285"));
          expect(b2[1][2]).to.eq(toFixedPtAmt("475"));
        });
      });
    });

    describe("when the user does not have tranches right proportions", function () {
      async function checkRedeemableAmts(
        bond: Contract,
        userAddress: string,
        amounts: string[] = [],
        redemptionAmts: string[] = [],
      ) {
        const tranches = await getTranches(bond);
        for (const a in amounts) {
          await tranches[a].transfer(userAddress, toFixedPtAmt(amounts[a]));
        }
        const b = await bondHelpers.computeRedeemableTrancheAmounts(bond.address, userAddress);
        for (const a in redemptionAmts) {
          expect(b[1][a]).to.eq(toFixedPtAmt(redemptionAmts[a]));
        }
      }

      describe("[9, 15, 25]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts(bond, userAddress, ["9", "15", "25"], ["9", "13.5", "22.5"]);
        });
      });

      describe("[10, 15, 250]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts(bond, userAddress, ["10", "15", "250"], ["10", "15", "25"]);
        });
      });

      describe("[10, 12, 250]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts(bond, userAddress, ["10", "12", "250"], ["8", "12", "20"]);
        });
      });

      describe("[10, 12, 5]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts(bond, userAddress, ["10", "12", "5"], ["2", "3", "5"]);
        });
      });

      describe("[10, 12, 0.5]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts(bond, userAddress, ["10", "12", "0.5"], ["0.2", "0.3", "0.5"]);
        });
      });

      describe("[10, 0, 25]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts(bond, userAddress, ["10", "0", "25"], ["0", "0", "0"]);
        });
      });

      describe("[0, 15, 25]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts(bond, userAddress, ["0", "15", "25"], ["0", "0", "0"]);
        });
      });

      describe("[10, 15, 0]", async function () {
        it("should calculate the amounts", async function () {
          await checkRedeemableAmts(bond, userAddress, ["10", "15", "0"], ["0", "0", "0"]);
        });
      });
    });
  });
});
