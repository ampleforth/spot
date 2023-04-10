import { expect, use } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Transaction, Signer } from "ethers";
import {
  setupCollateralToken,
  mintCollteralToken,
  toFixedPtAmt,
  setupBondFactory,
  depositIntoBond,
  getTranches,
  toDiscountFixedPtAmt,
  toPriceFixedPtAmt,
  getDepositBond,
  advancePerpQueueToBondMaturity,
} from "../helpers";
import { smock, FakeContract } from "@defi-wonderland/smock";

use(smock.matchers);

let vault: Contract, perp: FakeContract, collateralToken: Contract, deployer: Signer, otherUser: Signer;
describe("RolloverVault", function () {
  beforeEach(async function () {
    await network.provider.send("hardhat_reset");

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

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

  describe("#init", function () {
    it("should set erc20 parameters", async function () {
      expect(await vault.name()).to.eq("RolloverVault");
      expect(await vault.symbol()).to.eq("VSHARE");
      expect(await vault.decimals()).to.eq(18);
    });

    it("should set owner", async function () {
      expect(await vault.owner()).to.eq(await deployer.getAddress());
    });

    it("should set ext service references", async function () {
      expect(await vault.perp()).to.eq(perp.address);
    });

    it("should set deposit asset reference", async function () {
      expect(await vault.underlying()).to.eq(collateralToken.address);
    });

    it("should initialize lists", async function () {
      expect(await vault.deployedCount()).to.eq(0);
      expect(await vault.earnedCount()).to.eq(1);
      expect(await vault.earnedAt(0)).to.eq(perp.address);
      await expect(vault.earnedAt(1)).to.be.revertedWithCustomError(vault, "OutOfBounds");
      expect(await vault.isVaultAsset(collateralToken.address)).to.eq(true);
      expect(await vault.isVaultAsset(perp.address)).to.eq(true);
    });

    it("should NOT be paused", async function () {
      expect(await vault.paused()).to.eq(false);
    });
  });

  describe("#pause", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await vault.connect(deployer).transferOwnership(await otherUser.getAddress());
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(vault.connect(deployer).pause()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when already paused", function () {
      beforeEach(async function () {
        await vault.connect(otherUser).pause();
      });
      it("should revert", async function () {
        await expect(vault.connect(otherUser).pause()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when valid", function () {
      beforeEach(async function () {
        tx = await vault.connect(otherUser).pause();
        await tx;
      });
      it("should pause", async function () {
        expect(await vault.paused()).to.eq(true);
      });
      it("should emit event", async function () {
        await expect(tx)
          .to.emit(vault, "Paused")
          .withArgs(await otherUser.getAddress());
      });
    });
  });

  describe("#unpause", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await vault.connect(deployer).transferOwnership(await otherUser.getAddress());
    });

    describe("when triggered by non-owner", function () {
      beforeEach(async function () {
        await vault.connect(otherUser).pause();
      });

      it("should revert", async function () {
        await expect(vault.connect(deployer).unpause()).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when not paused", function () {
      it("should revert", async function () {
        await expect(vault.connect(otherUser).unpause()).to.be.revertedWith("Pausable: not paused");
      });
    });

    describe("when valid", function () {
      beforeEach(async function () {
        tx = await vault.connect(otherUser).pause();
        await tx;
        tx = await vault.connect(otherUser).unpause();
        await tx;
      });
      it("should unpause", async function () {
        expect(await vault.paused()).to.eq(false);
      });
      it("should emit event", async function () {
        await expect(tx)
          .to.emit(vault, "Unpaused")
          .withArgs(await otherUser.getAddress());
      });
    });
  });

  describe("#transferERC20", function () {
    let transferToken: Contract, toAddress: string;

    beforeEach(async function () {
      const Token = await ethers.getContractFactory("MockERC20");
      transferToken = await Token.deploy();
      await transferToken.init("Mock Token", "MOCK");
      await transferToken.mint(vault.address, "100");
      toAddress = await deployer.getAddress();
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(
          vault.connect(otherUser).transferERC20(transferToken.address, toAddress, "100"),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when non vault asset", function () {
      it("should transfer", async function () {
        await expect(() => vault.transferERC20(transferToken.address, toAddress, "100")).to.changeTokenBalance(
          transferToken,
          deployer,
          "100",
        );
      });
    });

    describe("when underlying asset", function () {
      it("should revert", async function () {
        await expect(
          vault.transferERC20(await vault.underlying(), toAddress, toFixedPtAmt("100")),
        ).to.be.revertedWithCustomError(vault, "UnauthorizedTransferOut");
      });
    });

    describe("when earned asset", function () {
      it("should revert", async function () {
        await expect(
          vault.transferERC20(await vault.earnedAt(0), toAddress, toFixedPtAmt("100")),
        ).to.be.revertedWithCustomError(vault, "UnauthorizedTransferOut");
      });
    });

    describe("when deployed asset", function () {
      beforeEach(async function () {
        const bondFactory = await setupBondFactory();
        ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));
        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        const issuer = await BondIssuer.deploy(bondFactory.address, collateralToken.address);
        await issuer.init(4800, [200, 300, 500], 1200, 0);

        const FeeStrategy = await ethers.getContractFactory("BasicFeeStrategy");
        const feeStrategy = await smock.fake(FeeStrategy);
        await feeStrategy.computeMintFees.returns(["0", "0"]);
        await feeStrategy.computeBurnFees.returns(["0", "0"]);
        await feeStrategy.computeRolloverFees.returns(["0", "0"]);

        const PricingStrategy = await ethers.getContractFactory("UnitPricingStrategy");
        const pricingStrategy = await smock.fake(PricingStrategy);
        await pricingStrategy.decimals.returns(8);
        await pricingStrategy.computeMatureTranchePrice.returns(toPriceFixedPtAmt("1"));
        await pricingStrategy.computeTranchePrice.returns(toPriceFixedPtAmt("1"));

        const DiscountStrategy = await ethers.getContractFactory("TrancheClassDiscountStrategy");
        const discountStrategy = await smock.fake(DiscountStrategy);
        await discountStrategy.decimals.returns(18);
        await discountStrategy.computeTrancheDiscount
          .whenCalledWith(collateralToken.address)
          .returns(toDiscountFixedPtAmt("1"));

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
            discountStrategy.address,
          ],
          {
            initializer: "init(string,string,address,address,address,address,address)",
          },
        );

        await feeStrategy.feeToken.returns(perp.address);
        await perp.updateTolerableTrancheMaturity(1200, 4800);
        await pricingStrategy.computeTranchePrice.returns(toPriceFixedPtAmt("1"));
        await discountStrategy.computeTrancheDiscount.returns(toDiscountFixedPtAmt("1"));
        await advancePerpQueueToBondMaturity(perp, await getDepositBond(perp));

        const bond = await getDepositBond(perp);
        const tranches = await getTranches(bond);
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.address, toFixedPtAmt("200"));
        await perp.deposit(tranches[0].address, toFixedPtAmt("200"));
        await advancePerpQueueToBondMaturity(perp, bond);

        await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
        const RolloverVault = await ethers.getContractFactory("RolloverVault");
        vault = await upgrades.deployProxy(RolloverVault.connect(deployer));
        await vault.init("RolloverVault", "VSHARE", perp.address);
        await collateralToken.transfer(vault.address, toFixedPtAmt("1000"));
        await vault.deploy();
        expect(await vault.deployedCount()).to.eq(2);
      });
      it("should revert", async function () {
        await expect(
          vault.transferERC20(await vault.deployedAt(0), toAddress, toFixedPtAmt("100")),
        ).to.be.revertedWithCustomError(vault, "UnauthorizedTransferOut");
        await expect(
          vault.transferERC20(await vault.deployedAt(1), toAddress, toFixedPtAmt("100")),
        ).to.be.revertedWithCustomError(vault, "UnauthorizedTransferOut");
      });
    });
  });
});
