import { expect, use } from "chai";
import { network, ethers } from "hardhat";
import { Contract } from "ethers";
import { smock } from "@defi-wonderland/smock";

import {
  setupCollateralToken,
  setupBondFactory,
  createBondWithFactory,
  getTranches,
  toDiscountFixedPtAmt,
} from "../helpers";
use(smock.matchers);

let perp: Contract, bondFactory: Contract, collateralToken: Contract, perpHelpers: Contract;

async function setupContracts() {
  bondFactory = await setupBondFactory();
  ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));

  const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
  perp = await smock.fake(PerpetualTranche);

  const PerpHelpersTester = await ethers.getContractFactory("PerpHelpersTester");
  perpHelpers = await PerpHelpersTester.deploy();
  await perpHelpers.deployed();
}

describe("PerpHelpers", function () {
  beforeEach(async () => {
    await setupContracts();
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#computeEffectiveTrancheRatio", function () {
    async function computeRatioAndCheck(trancheRatios, discounts, expectedRatios) {
      const bond = await createBondWithFactory(bondFactory, collateralToken, trancheRatios, 86400);
      const tranches = await getTranches(bond);
      for (const t in tranches) {
        await perp.computeDiscount.whenCalledWith(tranches[t].address).returns(toDiscountFixedPtAmt(`${discounts[t]}`));
      }
      const ratios = await perpHelpers.computeEffectiveTrancheRatio(perp.address, bond.address);
      for (const t in tranches) {
        expect(ratios[t]).to.eq(expectedRatios[t]);
      }
    }

    describe("[250,750],[1:0]", function () {
      it("should compute the ratio", async function () {
        await computeRatioAndCheck([250, 750], [1, 0], [250, 750]);
      });
    });

    describe("[250,750],[1:1]", function () {
      it("should compute the ratio", async function () {
        await computeRatioAndCheck([250, 750], [1, 1], [1000, 0]);
      });
    });

    describe("[500,500],[0.5:0.5]", function () {
      it("should compute the ratio", async function () {
        await computeRatioAndCheck([500, 500], [1, 0.5], [750, 250]);
      });
    });

    describe("[200,300,500],[1,1,0]", function () {
      it("should compute the ratio", async function () {
        await computeRatioAndCheck([200, 300, 500], [1, 1, 0], [500, 500]);
      });
    });

    describe("[200,300,500],[1,0.5,0]", function () {
      it("should compute the ratio", async function () {
        await computeRatioAndCheck([200, 300, 500], [1, 0.5, 0], [350, 650]);
      });
    });

    describe("[200,300,500],[1,1,0.5]", function () {
      it("should compute the ratio", async function () {
        await computeRatioAndCheck([200, 300, 500], [1, 1, 0.5], [750, 250]);
      });
    });

    describe("[200,800],[1,0.33]", function () {
      it("should compute the ratio", async function () {
        await computeRatioAndCheck([200, 800], [1, 0.33], [464, 536]);
      });
    });
  });
});
