import { expect } from "chai";
import { network, ethers, upgrades } from "hardhat";
import { Contract, Transaction, Signer } from "ethers";
import {
  setupCollateralToken,
  mintCollteralToken,
  toFixedPtAmt,
  toPercFixedPtAmt,
  setupBondFactory,
  depositIntoBond,
  getTranches,
  getDepositBond,
  advancePerpQueueToBondMaturity,
  DMock,
} from "../helpers";

let vault: Contract, perp: Contract, balancer: Contract, collateralToken: Contract, deployer: Signer, otherUser: Signer;
describe("RolloverVault", function () {
  beforeEach(async function () {
    await network.provider.request({ method: "hardhat_reset" });

    const accounts = await ethers.getSigners();
    deployer = accounts[0];
    otherUser = accounts[1];

    ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));
    await mintCollteralToken(collateralToken, toFixedPtAmt("1000"), deployer);

    perp = new DMock(await ethers.getContractFactory("PerpetualTranche"));
    await perp.deploy();
    await perp.mockMethod("underlying()", [collateralToken.target]);

    balancer = new DMock(await ethers.getContractFactory("Balancer"));
    await balancer.deploy();
    await balancer.mockMethod("decimals()", [8]);

    const RolloverVault = await ethers.getContractFactory("RolloverVault");
    vault = await upgrades.deployProxy(RolloverVault.connect(deployer));
    await collateralToken.approve(vault.target, toFixedPtAmt("1"));
    await vault.init("RolloverVault", "VSHARE", perp.target);
    await vault.updateBalancer(balancer.target);

    await perp.mockMethod("balancer()", [balancer.target]);
    await perp.mockMethod("vault()", [vault.target]);
  });

  afterEach(async function () {
    await network.provider.request({ method: "hardhat_reset" });
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
      expect(await vault.perp()).to.eq(perp.target);
    });

    it("should set deposit asset reference", async function () {
      expect(await vault.underlying()).to.eq(collateralToken.target);
    });

    it("should set initial param values", async function () {
      expect(await vault.minDeploymentAmt()).to.eq("0");
      expect(await vault.minUnderlyingBal()).to.eq("0");
      expect(await vault.minRolloverAmtPerc()).to.eq("0");
      expect(await vault.maxRolloverAmtPerc()).to.eq(ethers.MaxUint256);
    });

    it("should initialize lists", async function () {
      expect(await vault.assetCount()).to.eq(1);
      expect(await vault.assetAt(0)).to.eq(collateralToken.target);
      expect(await vault.isVaultAsset(collateralToken.target)).to.eq(true);
      expect(await vault.isVaultAsset(perp.target)).to.eq(false);
    });

    it("should NOT be paused", async function () {
      expect(await vault.paused()).to.eq(false);
    });
  });

  describe("#pause", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await vault.updateKeeper(await otherUser.getAddress());
    });

    describe("when triggered by non-keeper", function () {
      it("should revert", async function () {
        await expect(vault.connect(deployer).pause()).to.be.revertedWithCustomError(vault, "UnauthorizedCall");
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
      await vault.updateKeeper(await otherUser.getAddress());
    });

    describe("when triggered by non-owner", function () {
      beforeEach(async function () {
        await vault.connect(otherUser).pause();
      });

      it("should revert", async function () {
        await expect(vault.connect(deployer).unpause()).to.be.revertedWithCustomError(vault, "UnauthorizedCall");
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
      await transferToken.mint(vault.target, "100");
      toAddress = await deployer.getAddress();
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(vault.connect(otherUser).transferERC20(transferToken.target, toAddress, "100")).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when non vault asset", function () {
      it("should transfer", async function () {
        await expect(() => vault.transferERC20(transferToken.target, toAddress, "100")).to.changeTokenBalance(
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

    describe("when perp", function () {
      it("should not revert", async function () {
        await perp.mockMethod("transfer(address,uint256)", [true]);
        await expect(vault.transferERC20(perp.target, toAddress, toFixedPtAmt("100"))).not.to.be.reverted;
      });
    });

    describe("when deployed asset", function () {
      beforeEach(async function () {
        const bondFactory = await setupBondFactory();
        ({ collateralToken } = await setupCollateralToken("Bitcoin", "BTC"));

        const BondIssuer = await ethers.getContractFactory("BondIssuer");
        const issuer = await upgrades.deployProxy(
          BondIssuer.connect(deployer),
          [bondFactory.target, collateralToken.target, 4800, [200, 800], 1200, 0],
          {
            initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
          },
        );

        const PerpetualTranche = await ethers.getContractFactory("PerpetualTranche");
        perp = await upgrades.deployProxy(
          PerpetualTranche.connect(deployer),
          ["PerpetualTranche", "PERP", collateralToken.target, issuer.target],
          {
            initializer: "init(string,string,address,address)",
          },
        );
        await perp.updateTolerableTrancheMaturity(1200, 4800);
        await perp.updateDepositBond();
        await advancePerpQueueToBondMaturity(perp, await getDepositBond(perp));

        balancer = new DMock(await ethers.getContractFactory("Balancer"));
        await balancer.deploy();
        await balancer.mockMethod("decimals()", [8]);
        await balancer.mockMethod("computeRolloverFeePerc(uint256)", [0n]);
        await balancer.mockMethod("computeDeviationRatio((uint256,uint256,uint256))", [toPercFixedPtAmt("1")]);

        const RolloverVault = await ethers.getContractFactory("RolloverVault");
        vault = await upgrades.deployProxy(RolloverVault.connect(deployer));
        await vault.init("RolloverVault", "VSHARE", perp.target);
        await vault.updateBalancer(balancer.target);
        await perp.updateVault(vault.target);
        await perp.updateBalancer(balancer.target);

        await mintCollteralToken(collateralToken, toFixedPtAmt("100000"), deployer);
        const bond = await getDepositBond(perp);
        const tranches = await getTranches(bond);
        await depositIntoBond(bond, toFixedPtAmt("1000"), deployer);
        await tranches[0].approve(perp.target, toFixedPtAmt("200"));

        await perp.updateVault(await deployer.getAddress());
        await perp.deposit(tranches[0].target, toFixedPtAmt("200"));
        await advancePerpQueueToBondMaturity(perp, bond);

        await perp.updateBalancer(balancer.target);
        await perp.updateVault(vault.target);
        await collateralToken.transfer(vault.target, toFixedPtAmt("1000"));
        await vault.deploy();
        expect(await vault.assetCount()).to.eq(2);
      });
      it("should revert", async function () {
        await expect(
          vault.transferERC20(await vault.assetAt(1), toAddress, toFixedPtAmt("100")),
        ).to.be.revertedWithCustomError(vault, "UnauthorizedTransferOut");
      });
    });
  });

  describe("#updateBalancer", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await vault.connect(deployer).transferOwnership(await otherUser.getAddress());
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(vault.connect(deployer).updateBalancer(ethers.ZeroAddress)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when triggered by owner", function () {
      let newBalancer: Contract;
      beforeEach(async function () {
        newBalancer = new DMock(await ethers.getContractFactory("Balancer"));
        await newBalancer.deploy();
        await newBalancer.mockMethod("decimals()", [8]);
        tx = await vault.connect(otherUser).updateBalancer(newBalancer.target);
        await tx;
      });
      it("should update the fee policy", async function () {
        expect(await vault.balancer()).to.eq(newBalancer.target);
      });
    });
  });

  describe("#updateMinDeploymentAmt", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await vault.connect(deployer).updateKeeper(await otherUser.getAddress());
    });

    describe("when triggered by non-keeper", function () {
      it("should revert", async function () {
        await expect(vault.connect(deployer).updateMinDeploymentAmt(0)).to.be.revertedWithCustomError(
          vault,
          "UnauthorizedCall",
        );
      });
    });

    describe("when triggered by keeper", function () {
      beforeEach(async function () {
        tx = await vault.connect(otherUser).updateMinDeploymentAmt(toFixedPtAmt("1000"));
        await tx;
      });
      it("should update the min deployment amount", async function () {
        expect(await vault.minDeploymentAmt()).to.eq(toFixedPtAmt("1000"));
      });
    });
  });

  describe("#updateLiquidityLimits", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await vault.connect(deployer).updateKeeper(await otherUser.getAddress());
    });

    describe("when triggered by non-keeper", function () {
      it("should revert", async function () {
        await expect(
          vault.connect(deployer).updateLiquidityLimits(0, 0, ethers.MaxUint256),
        ).to.be.revertedWithCustomError(vault, "UnauthorizedCall");
      });
    });

    describe("when range is invalid", function () {
      it("should revert", async function () {
        await expect(
          vault.connect(otherUser).updateLiquidityLimits(0, toPercFixedPtAmt("1"), toPercFixedPtAmt("0.5")),
        ).to.be.revertedWithCustomError(vault, "InvalidRange");
      });
    });

    describe("when triggered by keeper", function () {
      beforeEach(async function () {
        tx = await vault
          .connect(otherUser)
          .updateLiquidityLimits(toFixedPtAmt("1000"), toPercFixedPtAmt("0.5"), toPercFixedPtAmt("1"));
        await tx;
      });
      it("should update the min underlying balance", async function () {
        expect(await vault.minUnderlyingBal()).to.eq(toFixedPtAmt("1000"));
        expect(await vault.minRolloverAmtPerc()).to.eq(toPercFixedPtAmt("0.5"));
        expect(await vault.maxRolloverAmtPerc()).to.eq(toPercFixedPtAmt("1"));
      });
    });
  });

  describe("#updateKeeper", function () {
    let tx: Transaction;
    beforeEach(async function () {
      await vault.connect(deployer).transferOwnership(await otherUser.getAddress());
    });

    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        await expect(vault.connect(deployer).updateKeeper(ethers.ZeroAddress)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when triggered by owner", function () {
      beforeEach(async function () {
        tx = await vault.connect(otherUser).updateKeeper(await otherUser.getAddress());
        await tx;
      });
      it("should update the keeper", async function () {
        expect(await vault.keeper()).to.eq(await otherUser.getAddress());
      });
    });
  });
});
