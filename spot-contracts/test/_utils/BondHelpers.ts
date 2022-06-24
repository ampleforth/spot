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
  getStdTrancheBalances,
  getTranches,
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
        expect(await bondHelpers.timeToMaturity(bond.address)).to.eq(bondLength / 2);
        expect(bondLength - (await bondHelpers.duration(bond.address)).toNumber()).to.lte(1);
      });
    });

    describe("when bond is mature", function () {
      it("should return the time to maturity", async function () {
        await TimeHelpers.setNextBlockTimestamp(maturityDate + 1);
        expect(await bondHelpers.timeToMaturity(bond.address)).to.eq(0);
        expect(bondLength - (await bondHelpers.duration(bond.address)).toNumber()).to.lte(1);
      });
    });
  });

  describe("#getTrancheData", function () {
    let bond: Contract;
    beforeEach(async function () {
      bond = await createBondWithFactory(bondFactory, collateralToken, [201, 301, 498], 86400);
    });

    it("should return the tranche data", async function () {
      const td = await bondHelpers.getTrancheData(bond.address);
      expect(td.trancheCount).to.eq(3);
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

  describe("#getTrancheIndex", function () {
    it("should return the tranche index", async function () {
      const bond = await createBondWithFactory(bondFactory, collateralToken, [100, 100, 100, 100, 100, 500], 86400);
      const td = await bondHelpers.getTrancheData(bond.address);

      for (const t in td.tranches) {
        expect(await bondHelpers.getTrancheIndex(bond.address, td.tranches[t])).to.eq(t);
      }

      await expect(bondHelpers.getTrancheIndex(bond.address, bond.address)).to.be.revertedWith(
        "UnacceptableTrancheIndex",
      );
      await expect(bondHelpers.getTrancheIndex(bond.address, deployerAddress)).to.be.revertedWith(
        "UnacceptableTrancheIndex",
      );
      await expect(bondHelpers.getTrancheIndex(bond.address, constants.AddressZero)).to.be.revertedWith(
        "UnacceptableTrancheIndex",
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
          const b = await getStdTrancheBalances(bond, deployerAddress);
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
            const b = await getStdTrancheBalances(bond, deployerAddress);
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
            const b = await getStdTrancheBalances(bond, deployerAddress);
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
            const b = await getStdTrancheBalances(bond, deployerAddress);
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
          const b = await getStdTrancheBalances(bond, deployerAddress);
          expect(b[0]).to.eq(toFixedPtAmt("497.5"));
          expect(b[1]).to.eq(toFixedPtAmt("497.5"));
          const c = await getStdTrancheBalances(bond, bond.address);
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
            const b = await getStdTrancheBalances(bond, deployerAddress);
            expect(b[0]).to.eq(toFixedPtAmt("995")); // 497.5 + 497.5
            expect(b[1]).to.eq(toFixedPtAmt("995"));
            const c = await getStdTrancheBalances(bond, bond.address);
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
            const b = await getStdTrancheBalances(bond, deployerAddress);
            expect(b[0]).to.eq(toFixedPtAmt("895.5")); // 497.5 + 398
            expect(b[1]).to.eq(toFixedPtAmt("895.5"));
            const c = await getStdTrancheBalances(bond, bond.address);
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
            const b = await getStdTrancheBalances(bond, deployerAddress);
            expect(b[0]).to.eq(toFixedPtAmt("1492.5")); // 497.5 + 995
            expect(b[1]).to.eq(toFixedPtAmt("1492.5"));
            const c = await getStdTrancheBalances(bond, bond.address);
            expect(c[0]).to.eq(toFixedPtAmt("7.5")); // 2.5 + 5
            expect(c[1]).to.eq(toFixedPtAmt("7.5"));
          });
        });
      });
    });
  });

  describe("#getTrancheCollateralization", function () {
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

  describe("#getTrancheCollateralBalances", function () {
    let bond: Contract, bondLength: number;
    beforeEach(async function () {
      bondLength = 86400;
      bond = await createBondWithFactory(bondFactory, collateralToken, [200, 300, 500], bondLength);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
      const tranches = await getTranches(bond);
      await tranches[0].transfer(userAddress, toFixedPtAmt("50"));
      await tranches[1].transfer(userAddress, toFixedPtAmt("50"));
      await tranches[2].transfer(userAddress, toFixedPtAmt("50"));
    });

    describe("when bond not mature", function () {
      describe("when no change in supply", function () {
        it("should calculate the balances", async function () {
          const b = await bondHelpers.getTrancheCollateralBalances(bond.address, deployerAddress);
          expect(b[1][0]).to.eq(toFixedPtAmt("150"));
          expect(b[1][1]).to.eq(toFixedPtAmt("250"));
          expect(b[1][2]).to.eq(toFixedPtAmt("450"));

          const c = await bondHelpers.getTrancheCollateralBalances(bond.address, userAddress);
          expect(c[1][0]).to.eq(toFixedPtAmt("50"));
          expect(c[1][1]).to.eq(toFixedPtAmt("50"));
          expect(c[1][2]).to.eq(toFixedPtAmt("50"));
        });
      });

      describe("when supply increases above z threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, 0.1);
          const b = await bondHelpers.getTrancheCollateralBalances(bond.address, deployerAddress);
          expect(b[1][0]).to.eq(toFixedPtAmt("150"));
          expect(b[1][1]).to.eq(toFixedPtAmt("250"));
          expect(b[1][2]).to.eq(toFixedPtAmt("540"));

          const c = await bondHelpers.getTrancheCollateralBalances(bond.address, userAddress);
          expect(c[1][0]).to.eq(toFixedPtAmt("50"));
          expect(c[1][1]).to.eq(toFixedPtAmt("50"));
          expect(c[1][2]).to.eq(toFixedPtAmt("60"));
        });
      });

      describe("when supply decreases below z threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.1);
          const b = await bondHelpers.getTrancheCollateralBalances(bond.address, deployerAddress);
          expect(b[1][0]).to.eq(toFixedPtAmt("150"));
          expect(b[1][1]).to.eq(toFixedPtAmt("250"));
          expect(b[1][2]).to.eq(toFixedPtAmt("360"));

          const c = await bondHelpers.getTrancheCollateralBalances(bond.address, userAddress);
          expect(c[1][0]).to.eq(toFixedPtAmt("50"));
          expect(c[1][1]).to.eq(toFixedPtAmt("50"));
          expect(c[1][2]).to.eq(toFixedPtAmt("40"));
        });
      });

      describe("when supply decreases below b threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.6);
          const b = await bondHelpers.getTrancheCollateralBalances(bond.address, deployerAddress);
          expect(b[1][0]).to.eq(toFixedPtAmt("150"));
          expect(b[1][1]).to.eq(toFixedPtAmt("166.666666666"));
          expect(b[1][2]).to.eq(toFixedPtAmt("0"));

          const c = await bondHelpers.getTrancheCollateralBalances(bond.address, userAddress);
          expect(c[1][0]).to.eq(toFixedPtAmt("50"));
          expect(c[1][1]).to.eq(toFixedPtAmt("33.333333333"));
          expect(c[1][2]).to.eq(toFixedPtAmt("0"));
        });
      });

      describe("when supply decreases below a threshold", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.85);
          const b = await bondHelpers.getTrancheCollateralBalances(bond.address, deployerAddress);
          expect(b[1][0]).to.eq(toFixedPtAmt("112.5"));
          expect(b[1][1]).to.eq(toFixedPtAmt("0"));
          expect(b[1][2]).to.eq(toFixedPtAmt("0"));

          const c = await bondHelpers.getTrancheCollateralBalances(bond.address, userAddress);
          expect(c[1][0]).to.eq(toFixedPtAmt("37.5"));
          expect(c[1][1]).to.eq(toFixedPtAmt("0"));
          expect(c[1][2]).to.eq(toFixedPtAmt("0"));
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
          const b = await bondHelpers.getTrancheCollateralBalances(bond.address, deployerAddress);
          expect(b[1][0]).to.eq(toFixedPtAmt("150"));
          expect(b[1][1]).to.eq(toFixedPtAmt("250"));
          expect(b[1][2]).to.eq(toFixedPtAmt("450"));

          const c = await bondHelpers.getTrancheCollateralBalances(bond.address, userAddress);
          expect(c[1][0]).to.eq(toFixedPtAmt("50"));
          expect(c[1][1]).to.eq(toFixedPtAmt("50"));
          expect(c[1][2]).to.eq(toFixedPtAmt("50"));
        });
      });

      describe("when supply increases", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, 0.1);
          const b = await bondHelpers.getTrancheCollateralBalances(bond.address, deployerAddress);
          expect(b[1][0]).to.eq(toFixedPtAmt("165"));
          expect(b[1][1]).to.eq(toFixedPtAmt("275"));
          expect(b[1][2]).to.eq(toFixedPtAmt("495"));

          const c = await bondHelpers.getTrancheCollateralBalances(bond.address, userAddress);
          expect(c[1][0]).to.eq(toFixedPtAmt("55"));
          expect(c[1][1]).to.eq(toFixedPtAmt("55"));
          expect(c[1][2]).to.eq(toFixedPtAmt("55"));
        });
      });

      describe("when supply decreases", function () {
        it("should calculate the balances", async function () {
          await rebase(collateralToken, rebaseOracle, -0.1);
          const b = await bondHelpers.getTrancheCollateralBalances(bond.address, deployerAddress);
          expect(b[1][0]).to.eq(toFixedPtAmt("135"));
          expect(b[1][1]).to.eq(toFixedPtAmt("225"));
          expect(b[1][2]).to.eq(toFixedPtAmt("405"));

          const c = await bondHelpers.getTrancheCollateralBalances(bond.address, userAddress);
          expect(c[1][0]).to.eq(toFixedPtAmt("45"));
          expect(c[1][1]).to.eq(toFixedPtAmt("45"));
          expect(c[1][2]).to.eq(toFixedPtAmt("45"));
        });
      });
    });
  });
});
