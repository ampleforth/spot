import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Signer } from "ethers";
import { setupCollateralToken, mintCollteralToken, toFixedPtAmt } from "../helpers";
import { smock, FakeContract } from "@defi-wonderland/smock";

use(smock.matchers);

let vault: Contract, perp: FakeContract, collateralToken: Contract, deployer: Signer;
describe("RolloverVault_erc20params_upgrade", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];

    ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));
    await mintCollteralToken(collateralToken, toFixedPtAmt("1000"), deployer);

    const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
    perp = await smock.fake(PerpetualTranche);

    await perp.collateral.returns(collateralToken.address);
    await perp.feeToken.returns(perp.address);

    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    vault = await upgrades.deployProxy(RolloverVault.connect(deployer));
    await collateralToken.approve(vault.address, toFixedPtAmt("1"));
    await vault.init("RolloverVault", "VSHARE", perp.address);
  });

  afterEach(async function () {
    await network.provider.send("hardhat_reset");
  });

  describe("#updateERC20", function () {
    it("should change the params", async function () {
      expect(await vault.name()).to.eq("RolloverVault");
      expect(await vault.symbol()).to.eq("VSHARE");
      await vault.forceUpdateERC20Params();
      expect(await vault.name()).to.eq("Staked Ampleforth");
      expect(await vault.symbol()).to.eq("stAMPL");
    });
  });
});
