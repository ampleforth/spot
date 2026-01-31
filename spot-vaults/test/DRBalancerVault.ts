import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, amplFP, perpFP, drFP } from "./helpers";

const ONE = ethers.parseUnits("1", 18);
const DR_ONE = ethers.parseUnits("1", 8); // DR uses 8 decimals like FeePolicy
const DAY = 86400;

describe("DRBalancerVault", function () {
  async function setupContracts() {
    const accounts = await ethers.getSigners();
    const deployer = accounts[0];

    // Deploy mock underlying token (AMPL-like, 9 decimals)
    const Token = await ethers.getContractFactory("MockERC20");
    const underlying = await Token.deploy();
    await underlying.init("Ampleforth", "AMPL", 9);

    // Deploy mock perp token (SPOT-like, 9 decimals) with getTVL support
    const PerpToken = await ethers.getContractFactory("MockPerpetualTranche");
    const perp = await PerpToken.deploy();
    await perp.init("SPOT", "SPOT", 9);
    await perp.setTVL(amplFP("10000")); // Default perpTVL for rebalance calculations

    // Deploy mock rollover vault
    const rolloverVault = new DMock(
      "@ampleforthorg/spot-contracts/contracts/_interfaces/IRolloverVault.sol:IRolloverVault",
    );
    await rolloverVault.deploy();
    await rolloverVault.mockMethod("swapUnderlyingForPerps(uint256)", [0]);
    await rolloverVault.mockMethod("swapPerpsForUnderlying(uint256)", [0]);
    // Mock system DR at equilibrium (1.0 with 8 decimals as per FeePolicy)
    await rolloverVault.mockMethod("deviationRatio()", [drFP("1")]);
    // Mock compute functions with zero fee by default
    // Returns: (perpAmtOut, perpFeeAmtToBurn, SystemTVL)
    await rolloverVault.mockMethod("computeUnderlyingToPerpSwapAmt(uint256)", [
      perpFP("100"),
      0,
      { perpTVL: amplFP("1000"), vaultTVL: amplFP("1000") },
    ]);

    // Deploy DRBalancerVault
    const DRBalancerVault = await ethers.getContractFactory("DRBalancerVault");
    const vault = await upgrades.deployProxy(
      DRBalancerVault.connect(deployer),
      ["DR Balancer LP", "DRLP", underlying.target, perp.target, rolloverVault.target],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );

    // Mint tokens to deployer for testing
    await underlying.mint(deployer.getAddress(), amplFP("100000"));

    // Approve vault to spend tokens
    await underlying.connect(deployer).approve(vault.target, ethers.MaxUint256);

    return { deployer, underlying, perp, rolloverVault, vault };
  }

  describe("init", function () {
    it("should set initial values", async function () {
      const { deployer, vault, underlying, perp, rolloverVault } = await loadFixture(
        setupContracts,
      );

      expect(await vault.underlying()).to.eq(underlying.target);
      expect(await vault.perp()).to.eq(perp.target);
      expect(await vault.rolloverVault()).to.eq(rolloverVault.target);
      expect(await vault.underlyingUnitAmt()).to.eq(amplFP("1"));
      expect(await vault.perpUnitAmt()).to.eq(perpFP("1"));

      expect(await vault.owner()).to.eq(await deployer.getAddress());
      expect(await vault.keeper()).to.eq(await deployer.getAddress());

      // Target DR is 1.0 (system in balance) with 8 decimals
      expect(await vault.targetDR()).to.eq(DR_ONE);

      // Equilibrium zone: 95% - 105% with 8 decimals
      const equilibriumDR = await vault.equilibriumDR();
      expect(equilibriumDR.lower).to.eq((DR_ONE * 95n) / 100n);
      expect(equilibriumDR.upper).to.eq((DR_ONE * 105n) / 100n);

      expect(await vault.lagFactorUnderlyingToPerp()).to.eq(3);
      expect(await vault.lagFactorPerpToUnderlying()).to.eq(3);

      const percLimitsU2P = await vault.rebalancePercLimitsUnderlyingToPerp();
      expect(percLimitsU2P.lower).to.eq(ONE / 10n); // 10%
      expect(percLimitsU2P.upper).to.eq(ONE / 2n); // 50%

      const percLimitsP2U = await vault.rebalancePercLimitsPerpToUnderlying();
      expect(percLimitsP2U.lower).to.eq(ONE / 10n); // 10%
      expect(percLimitsP2U.upper).to.eq(ONE / 2n); // 50%

      expect(await vault.rebalanceFreqSec()).to.eq(DAY);
      expect(await vault.maxSwapFeePerc()).to.eq(ONE / 100n); // 1% default
    });
  });

  describe("#updateKeeper", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.renounceOwnership();
        await expect(vault.updateKeeper(ethers.ZeroAddress)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when set address is valid", function () {
      it("should update reference", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.updateKeeper(vault.target);
        expect(await vault.keeper()).to.eq(vault.target);
      });
    });
  });

  describe("#updateTargetDR", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.renounceOwnership();
        await expect(vault.updateTargetDR(DR_ONE)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when valid", function () {
      it("should update target DR", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.updateTargetDR((DR_ONE * 110n) / 100n);
        expect(await vault.targetDR()).to.eq((DR_ONE * 110n) / 100n);
      });
    });
  });

  describe("#updateEquilibriumDR", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.renounceOwnership();
        await expect(
          vault.updateEquilibriumDR({ lower: DR_ONE / 2n, upper: DR_ONE }),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when lower > upper", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await expect(
          vault.updateEquilibriumDR({ lower: DR_ONE, upper: DR_ONE / 2n }),
        ).to.be.revertedWithCustomError(vault, "InvalidDRBound");
      });
    });

    describe("when valid", function () {
      it("should update equilibrium DR", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.updateEquilibriumDR({
          lower: (DR_ONE * 90n) / 100n,
          upper: (DR_ONE * 110n) / 100n,
        });
        const eq = await vault.equilibriumDR();
        expect(eq.lower).to.eq((DR_ONE * 90n) / 100n);
        expect(eq.upper).to.eq((DR_ONE * 110n) / 100n);
      });
    });
  });

  describe("#updateRebalanceConfigUnderlyingToPerp", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.renounceOwnership();
        await expect(
          vault.updateRebalanceConfigUnderlyingToPerp(5, {
            lower: ONE / 100n,
            upper: ONE / 10n,
          }),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when perc limits lower > upper", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await expect(
          vault.updateRebalanceConfigUnderlyingToPerp(5, {
            lower: ONE / 10n,
            upper: ONE / 100n,
          }),
        ).to.be.revertedWithCustomError(vault, "InvalidRange");
      });
    });

    describe("when valid", function () {
      it("should update config", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.updateRebalanceConfigUnderlyingToPerp(5, {
          lower: ONE / 100n,
          upper: ONE / 10n,
        });
        expect(await vault.lagFactorUnderlyingToPerp()).to.eq(5);
        const limits = await vault.rebalancePercLimitsUnderlyingToPerp();
        expect(limits.lower).to.eq(ONE / 100n);
        expect(limits.upper).to.eq(ONE / 10n);
      });
    });
  });

  describe("#updateRebalanceConfigPerpToUnderlying", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.renounceOwnership();
        await expect(
          vault.updateRebalanceConfigPerpToUnderlying(5, {
            lower: ONE / 100n,
            upper: ONE / 10n,
          }),
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });

    describe("when perc limits lower > upper", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await expect(
          vault.updateRebalanceConfigPerpToUnderlying(5, {
            lower: ONE / 10n,
            upper: ONE / 100n,
          }),
        ).to.be.revertedWithCustomError(vault, "InvalidRange");
      });
    });

    describe("when valid", function () {
      it("should update config", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.updateRebalanceConfigPerpToUnderlying(8, {
          lower: ONE / 50n,
          upper: ONE / 5n,
        });
        expect(await vault.lagFactorPerpToUnderlying()).to.eq(8);
        const limits = await vault.rebalancePercLimitsPerpToUnderlying();
        expect(limits.lower).to.eq(ONE / 50n);
        expect(limits.upper).to.eq(ONE / 5n);
      });
    });
  });

  describe("#updateRebalanceFreqSec", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.renounceOwnership();
        await expect(vault.updateRebalanceFreqSec(DAY * 2)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when valid", function () {
      it("should update frequency", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.updateRebalanceFreqSec(DAY * 2);
        expect(await vault.rebalanceFreqSec()).to.eq(DAY * 2);
      });
    });
  });

  describe("#updateMaxSwapFeePerc", function () {
    describe("when triggered by non-owner", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.renounceOwnership();
        await expect(vault.updateMaxSwapFeePerc(ONE / 100n)).to.be.revertedWith(
          "Ownable: caller is not the owner",
        );
      });
    });

    describe("when fee > 100%", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await expect(vault.updateMaxSwapFeePerc(ONE + 1n)).to.be.revertedWithCustomError(
          vault,
          "InvalidPerc",
        );
      });
    });

    describe("when valid", function () {
      it("should update max swap fee", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.updateMaxSwapFeePerc(ONE / 50n);
        expect(await vault.maxSwapFeePerc()).to.eq(ONE / 50n);
      });
    });
  });

  describe("#pause", function () {
    describe("when triggered by non-keeper", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.updateKeeper(ethers.ZeroAddress);
        await expect(vault.pause()).to.be.revertedWithCustomError(
          vault,
          "UnauthorizedCall",
        );
      });
    });

    describe("when already paused", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.pause();
        await expect(vault.pause()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when valid", function () {
      it("should pause", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.pause();
        expect(await vault.paused()).to.eq(true);
      });
    });
  });

  describe("#unpause", function () {
    describe("when triggered by non-keeper", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.pause();
        await vault.updateKeeper(ethers.ZeroAddress);
        await expect(vault.unpause()).to.be.revertedWithCustomError(
          vault,
          "UnauthorizedCall",
        );
      });
    });

    describe("when not paused", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await expect(vault.unpause()).to.be.revertedWith("Pausable: not paused");
      });
    });

    describe("when valid", function () {
      it("should unpause", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.pause();
        await vault.unpause();
        expect(await vault.paused()).to.eq(false);
      });
    });
  });
});
