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
  getTranches,
} from "../helpers";

let bondFactory: Contract,
  collateralToken: Contract,
  rebaseOracle: Contract,
  pricingStrategy: Contract,
  deployer: Signer;

async function setupContracts() {
  const accounts = await ethers.getSigners();
  deployer = accounts[0];

  bondFactory = await setupBondFactory();
  ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));

  const CDRLBPricingStrategy = await ethers.getContractFactory("CDRLBPricingStrategy");
  pricingStrategy = await CDRLBPricingStrategy.deploy();
}

describe("CDRLBPricingStrategy", function () {
  beforeEach(async () => {
    await setupContracts();
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("decimals", function () {
    it("should be set", async function () {
      expect(await pricingStrategy.decimals()).to.eq(8);
    });
  });

  describe("computeTranchePrice", function () {
    let bond: Contract, tranches: Contract[];
    beforeEach(async function () {
      bond = await createBondWithFactory(bondFactory, collateralToken, [500, 500], 86400);
      await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
      tranches = await getTranches(bond);
    });

    describe("when bond not mature", function () {
      it("should return the price", async function () {
        expect(await pricingStrategy.computeTranchePrice(tranches[0].address)).to.eq("100000000");
      });
    });

    describe("when bond is mature", function () {
      beforeEach(async function () {
        await TimeHelpers.increaseTime(86400);
        await bond.mature(); // NOTE: Any rebase after maturity goes directly to the tranches
      });

      describe("when cdr = 1", async function () {
        it("should return the price", async function () {
          expect(await pricingStrategy.computeTranchePrice(tranches[0].address)).to.eq("100000000");
        });
      });

      describe("when cdr > 1", async function () {
        beforeEach(async function () {
          await rebase(collateralToken, rebaseOracle, 0.1);
        });
        it("should return the price", async function () {
          expect(await pricingStrategy.computeTranchePrice(tranches[0].address)).to.eq("110000000");
        });
      });

      describe("when cdr < 1", async function () {
        beforeEach(async function () {
          await rebase(collateralToken, rebaseOracle, -0.1);
        });
        it("should return the price", async function () {
          expect(await pricingStrategy.computeTranchePrice(tranches[0].address)).to.eq("100000000");
        });
      });
    });
  });
});
