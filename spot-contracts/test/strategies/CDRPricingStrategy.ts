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
  getTranches,
} from "../helpers";
use(smock.matchers);

let bondFactory: Contract,
  collateralToken: Contract,
  rebaseOracle: Contract,
  pricingStrategy: Contract,
  perp: Contract,
  deployer: Signer;

async function setupContracts() {
  const accounts = await ethers.getSigners();
  deployer = accounts[0];

  bondFactory = await setupBondFactory();
  ({ collateralToken, rebaseOracle } = await setupCollateralToken("Bitcoin", "BTC"));

  const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
  perp = await smock.fake(PerpetualTranche);
  await perp.collateral.returns(collateralToken.address);

  const CDRPricingStrategy = await ethers.getContractFactory("CDRPricingStrategy");
  pricingStrategy = await CDRPricingStrategy.deploy();
}

describe("CDRPricingStrategy", function () {
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
      tranches = await getTranches(bond);
    });

    describe("when bond is empty", function () {
      it("should return zero", async function () {
        expect(await pricingStrategy.computeTranchePrice(tranches[0].address)).to.eq("100000000");
      });
    });

    describe("when bond has assets", function () {
      beforeEach(async function () {
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
      });

      describe("when pricing the tranche", function () {
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
              expect(await pricingStrategy.computeTranchePrice(tranches[0].address)).to.eq("90000000");
            });
          });
        });
      });
    });
  });
});
