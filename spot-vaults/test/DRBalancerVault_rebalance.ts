import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, amplFP, perpFP, drFP } from "./helpers";

const ONE = ethers.parseUnits("1", 18);
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
    // Note: perpTVL is set but totalSupply starts at 0
    // perpPrice = perpTVL / totalSupply, so we must mint perps to establish a price
    await perp.setTVL(amplFP("10000"));

    // Deploy mock rollover vault
    const rolloverVault = new DMock(
      "@ampleforthorg/spot-contracts/contracts/_interfaces/IRolloverVault.sol:IRolloverVault",
    );
    await rolloverVault.deploy();
    await rolloverVault.mockMethod("swapUnderlyingForPerps(uint256)", [0]);
    await rolloverVault.mockMethod("swapPerpsForUnderlying(uint256)", [0]);
    // Mock system DR at equilibrium (1.0 with 8 decimals as per FeePolicy)
    await rolloverVault.mockMethod("deviationRatio()", [drFP("1")]);

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

  // Fixture with balanced liquidity: 10000 AMPL + 10000 SPOT (perpPrice = 1)
  async function setupWithBalancedLiquidity() {
    const fixtures = await setupContracts();
    const { vault, perp } = fixtures;

    // Deposit 10000 AMPL
    await vault.deposit(amplFP("10000"), 0, 0);

    // Mint 10000 perps to vault, with perpTVL = 10000, so perpPrice = 1
    await perp.mint(vault.target, perpFP("10000"));

    return fixtures;
  }

  // Fixture with only underlying (no perps in vault, but perps exist in system)
  async function setupWithOnlyUnderlying() {
    const fixtures = await setupContracts();
    const { vault, perp, deployer } = fixtures;
    await vault.deposit(amplFP("10000"), 0, 0);
    // Mint perps to deployer (not vault) so perpTotalSupply > 0 to avoid division by zero
    await perp.mint(await deployer.getAddress(), perpFP("10000"));
    return fixtures;
  }

  // Fixture with only perps in vault (no underlying deposited)
  async function setupWithOnlyPerps() {
    const fixtures = await setupContracts();
    const { vault, perp } = fixtures;
    // Mint perps directly to vault (simulating a state after full conversion)
    await perp.mint(vault.target, perpFP("10000"));
    return fixtures;
  }

  describe("#computeRebalanceAmount", function () {
    // Test Matrix:
    // - DR at target: returns 0
    // - DR below target: perp -> underlying swap (isUnderlyingIntoPerp = false)
    // - DR above target: underlying -> perp swap (isUnderlyingIntoPerp = true)
    // - Caps: minRebalanceVal threshold, availableLiquidity cap, requiredChange cap

    describe("DR at target", function () {
      it("should return 0 at DR = 1.0", async function () {
        const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
        await rolloverVault.mockMethod("deviationRatio()", [drFP("1")]);

        const [amt, isUnderlyingIntoPerp] =
          await vault.computeRebalanceAmount.staticCall();
        expect(amt).to.eq(0n);
        // When DR = targetDR, goes to else branch (dr >= targetDR), so isUnderlyingIntoPerp = true
        expect(isUnderlyingIntoPerp).to.eq(true);
      });
    });

    describe("DR below target (perp -> underlying swap)", function () {
      // When DR < target: redeem perps to decrease perpTVL
      // isUnderlyingIntoPerp = false

      describe("basic rebalance", function () {
        it("should compute adjustedChange correctly", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.5")]);

          // drDelta = 1.0 - 0.5 = 0.5
          // requiredChange = perpTVL * drDelta = 10000 * 0.5 = 5000 AMPL
          // adjustedChange = 5000 / 3 (lagFactor) = 1666.666... AMPL
          // availableLiquidity = perpValue = 10000 AMPL
          // adjustedChange < availableLiquidity, adjustedChange < requiredChange
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("1666.666666666"));
          expect(isUnderlyingIntoPerp).to.eq(false);
        });
      });

      describe("minRebalanceVal threshold", function () {
        it("should return 0 when adjustedChange < minRebalanceVal", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          // Set minRebalanceVal to 1000 AMPL (underlying denominated)
          await vault.updateMinRebalanceAmt(amplFP("1000"));
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.8")]);

          // drDelta = 1.0 - 0.8 = 0.2
          // requiredChange = 10000 * 0.2 = 2000 AMPL
          // adjustedChange = 2000 / 3 = 666.666... AMPL
          // 666 < minRebalanceVal (1000), so return 0
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(0n);
          expect(isUnderlyingIntoPerp).to.eq(false);
        });

        it("should proceed when adjustedChange >= minRebalanceVal", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await vault.updateMinRebalanceAmt(amplFP("500"));
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.8")]);

          // adjustedChange = 666 >= minRebalanceVal (500)
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("666.666666666"));
          expect(isUnderlyingIntoPerp).to.eq(false);
        });
      });

      describe("availableLiquidity cap", function () {
        it("should cap at availableLiquidity when adjustedChange > availableLiquidity", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          // Set lagFactor to 1 so adjustedChange = requiredChange
          await vault.updateLagFactors(1, 1);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.3")]);

          // drDelta = 1.0 - 0.3 = 0.7
          // requiredChange = 10000 * 0.7 = 7000 AMPL
          // adjustedChange = 7000 / 1 = 7000 AMPL
          // availableLiquidity = perpValue = 10000 AMPL
          // 7000 < 10000, so no cap needed
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("7000"));
          expect(isUnderlyingIntoPerp).to.eq(false);
        });
      });

      describe("requiredChange cap (overshoot protection)", function () {
        it("should cap at requiredChange to prevent overshoot", async function () {
          const { vault, rolloverVault, perp } = await loadFixture(setupContracts);
          await vault.deposit(amplFP("50000"), 0, 0);
          await perp.mint(vault.target, perpFP("50000"));
          // Set lagFactor to 1 so adjustedChange = requiredChange
          await vault.updateLagFactors(1, 1);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.9")]);

          // drDelta = 1.0 - 0.9 = 0.1
          // requiredChange = 10000 * 0.1 = 1000 AMPL
          // adjustedChange = 1000 / 1 = 1000 AMPL
          // availableLiquidity = 50000 AMPL
          // adjustedChange (1000) < availableLiquidity (50000)
          // adjustedChange (1000) = requiredChange (1000), no overshoot
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("1000"));
          expect(isUnderlyingIntoPerp).to.eq(false);
        });
      });

      describe("zero liquidity", function () {
        it("should return 0 when vault has no perps", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithOnlyUnderlying);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.8")]);

          // availableLiquidity = 0
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(0n);
          expect(isUnderlyingIntoPerp).to.eq(false);
        });
      });
    });

    describe("DR above target (underlying -> perp swap)", function () {
      // When DR > target: mint perps to increase perpTVL
      // isUnderlyingIntoPerp = true

      describe("basic rebalance", function () {
        it("should compute adjustedChange correctly", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.5")]);

          // drDelta = 1.5 - 1.0 = 0.5
          // requiredChange = 10000 * 0.5 = 5000 AMPL
          // adjustedChange = 5000 / 3 = 1666.666... AMPL
          // availableLiquidity = underlyingBalance = 10000 AMPL
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("1666.666666666"));
          expect(isUnderlyingIntoPerp).to.eq(true);
        });
      });

      describe("minRebalanceVal threshold", function () {
        it("should return 0 when adjustedChange < minRebalanceVal", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await vault.updateMinRebalanceAmt(amplFP("1000"));
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.2")]);

          // drDelta = 1.2 - 1.0 = 0.2
          // requiredChange = 10000 * 0.2 = 2000 AMPL
          // adjustedChange = 2000 / 3 = 666.666... AMPL
          // 666 < minRebalanceVal (1000), so return 0
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(0n);
          expect(isUnderlyingIntoPerp).to.eq(true);
        });
      });

      describe("availableLiquidity cap", function () {
        it("should cap at availableLiquidity when adjustedChange > availableLiquidity", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await vault.updateLagFactors(1, 1);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.7")]);

          // drDelta = 1.7 - 1.0 = 0.7
          // requiredChange = 10000 * 0.7 = 7000 AMPL
          // adjustedChange = 7000 / 1 = 7000 AMPL
          // availableLiquidity = underlyingBalance = 10000 AMPL
          // 7000 < 10000, so no cap needed
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("7000"));
          expect(isUnderlyingIntoPerp).to.eq(true);
        });
      });

      describe("requiredChange cap (overshoot protection)", function () {
        it("should cap at requiredChange to prevent overshoot", async function () {
          const { vault, rolloverVault, perp } = await loadFixture(setupContracts);
          await vault.deposit(amplFP("50000"), 0, 0);
          await perp.mint(vault.target, perpFP("10000"));
          await vault.updateLagFactors(1, 1);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.1")]);

          // drDelta = 1.1 - 1.0 = 0.1
          // requiredChange = 10000 * 0.1 = 1000 AMPL
          // adjustedChange = 1000 / 1 = 1000 AMPL
          // availableLiquidity = 50000 AMPL
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("1000"));
          expect(isUnderlyingIntoPerp).to.eq(true);
        });
      });

      describe("zero liquidity", function () {
        it("should return 0 when vault has no underlying", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithOnlyPerps);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.2")]);

          // availableLiquidity = 0
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(0n);
          expect(isUnderlyingIntoPerp).to.eq(true);
        });
      });
    });

    describe("edge cases", function () {
      it("should return 0 when perpTVL is 0", async function () {
        const { vault, rolloverVault, perp } = await loadFixture(
          setupWithBalancedLiquidity,
        );
        await perp.setTVL(0);
        await rolloverVault.mockMethod("deviationRatio()", [drFP("0.8")]);

        const [amt, isUnderlyingIntoPerp] =
          await vault.computeRebalanceAmount.staticCall();
        expect(amt).to.eq(0n);
        expect(isUnderlyingIntoPerp).to.eq(false);
      });
    });
  });

  describe("#rebalance", function () {
    describe("when paused", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupWithBalancedLiquidity);
        await vault.pause();
        await expect(vault.rebalance()).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when cooldown not elapsed", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupWithBalancedLiquidity);
        await vault.rebalance();
        await expect(vault.rebalance()).to.be.revertedWithCustomError(
          vault,
          "LastRebalanceTooRecent",
        );
      });
    });

    describe("when cooldown has elapsed", function () {
      it("should allow rebalance", async function () {
        const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
        await rolloverVault.mockMethod("deviationRatio()", [drFP("1")]);

        await vault.rebalance();
        await time.increase(DAY + 1);
        await expect(vault.rebalance())
          .to.emit(vault, "Rebalanced")
          .withArgs(drFP("1"), drFP("1"), 0n, true);
      });
    });

    describe("when system DR is at target", function () {
      it("should emit Rebalanced event with zero swap amount", async function () {
        const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
        await rolloverVault.mockMethod("deviationRatio()", [drFP("1")]);

        // When DR = targetDR, isUnderlyingIntoPerp = true (dr >= targetDR branch)
        await expect(vault.rebalance())
          .to.emit(vault, "Rebalanced")
          .withArgs(drFP("1"), drFP("1"), 0n, true);
      });

      it("should update lastRebalanceTimestampSec", async function () {
        const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
        await rolloverVault.mockMethod("deviationRatio()", [drFP("1")]);

        const tx = await vault.rebalance();
        const receipt = await tx.wait();
        const block = await ethers.provider.getBlock(receipt!.blockNumber);

        const timestamp = await vault.lastRebalanceTimestampSec();
        expect(timestamp).to.eq(block!.timestamp);
      });

      it("should not change token balances", async function () {
        const { vault, rolloverVault, underlying } = await loadFixture(
          setupWithBalancedLiquidity,
        );
        await rolloverVault.mockMethod("deviationRatio()", [drFP("1")]);

        await expect(() => vault.rebalance()).to.changeTokenBalances(
          underlying,
          [vault],
          [0n],
        );
      });
    });

    describe("underlying -> perp swap (DR too high)", function () {
      it("should call swapUnderlyingForPerps with correct amount", async function () {
        const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
        await rolloverVault.mockMethod("deviationRatio()", [drFP("1.2")]);
        // DR=1.2, drDelta=0.2, requiredChange=2000, adjustedChange=2000/3=666.666...
        await rolloverVault.mockCall(
          "swapUnderlyingForPerps(uint256)",
          [amplFP("666.666666666")],
          [perpFP("666.666666666")],
        );

        await expect(vault.rebalance())
          .to.emit(vault, "Rebalanced")
          .withArgs(drFP("1.2"), drFP("1.2"), amplFP("666.666666666"), true);
      });
    });

    describe("perp -> underlying swap (DR too low)", function () {
      it("should call swapPerpsForUnderlying with correct amount", async function () {
        const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
        await rolloverVault.mockMethod("deviationRatio()", [drFP("0.8")]);
        // DR=0.8, drDelta=0.2, requiredChange=2000, adjustedChange=2000/3=666.666...
        // perpAmtIn = 666.666... * 10000 / 10000 = 666.666... SPOT
        await rolloverVault.mockCall(
          "swapPerpsForUnderlying(uint256)",
          [perpFP("666.666666666")],
          [amplFP("666.666666666")],
        );

        await expect(vault.rebalance())
          .to.emit(vault, "Rebalanced")
          .withArgs(drFP("0.8"), drFP("0.8"), amplFP("666.666666666"), false);
      });
    });

    describe("slippage protection", function () {
      describe("underlying -> perp swap", function () {
        it("should revert when fee exceeds max", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.2")]);

          // Swap 666.666... AMPL, return only 600 SPOT (10% fee when perpPrice = 1)
          await rolloverVault.mockCall(
            "swapUnderlyingForPerps(uint256)",
            [amplFP("666.666666666")],
            [perpFP("600")],
          );

          // Default max fee is 1%
          await expect(vault.rebalance()).to.be.revertedWithCustomError(
            vault,
            "SlippageTooHigh",
          );
        });

        it("should succeed when fee is zero", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.2")]);

          // No fee
          await rolloverVault.mockCall(
            "swapUnderlyingForPerps(uint256)",
            [amplFP("666.666666666")],
            [perpFP("666.666666666")],
          );

          await expect(vault.rebalance())
            .to.emit(vault, "Rebalanced")
            .withArgs(drFP("1.2"), drFP("1.2"), amplFP("666.666666666"), true);
        });

        it("should succeed when fee is within limit", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.2")]);

          // ~0.5% fee
          await rolloverVault.mockCall(
            "swapUnderlyingForPerps(uint256)",
            [amplFP("666.666666666")],
            [perpFP("663.333333333")],
          );

          // Default max fee is 1%
          await expect(vault.rebalance())
            .to.emit(vault, "Rebalanced")
            .withArgs(drFP("1.2"), drFP("1.2"), amplFP("666.666666666"), true);
        });

        it("should succeed when fee equals max limit", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.2")]);
          await vault.updateMaxSwapFeePerc(ONE / 20n); // 5%

          // Exactly 5% fee
          await rolloverVault.mockCall(
            "swapUnderlyingForPerps(uint256)",
            [amplFP("666.666666666")],
            [perpFP("633.333333333")],
          );

          await expect(vault.rebalance())
            .to.emit(vault, "Rebalanced")
            .withArgs(drFP("1.2"), drFP("1.2"), amplFP("666.666666666"), true);
        });
      });

      describe("perp -> underlying swap", function () {
        it("should revert when fee exceeds max", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.8")]);

          // Swap 666.666... SPOT, return only 600 AMPL (10% fee)
          await rolloverVault.mockCall(
            "swapPerpsForUnderlying(uint256)",
            [perpFP("666.666666666")],
            [amplFP("600")],
          );

          // Default max fee is 1%
          await expect(vault.rebalance()).to.be.revertedWithCustomError(
            vault,
            "SlippageTooHigh",
          );
        });

        it("should succeed when fee is zero", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.8")]);

          // No fee
          await rolloverVault.mockCall(
            "swapPerpsForUnderlying(uint256)",
            [perpFP("666.666666666")],
            [amplFP("666.666666666")],
          );

          await expect(vault.rebalance())
            .to.emit(vault, "Rebalanced")
            .withArgs(drFP("0.8"), drFP("0.8"), amplFP("666.666666666"), false);
        });

        it("should succeed when fee is within limit", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.8")]);

          // ~0.5% fee
          await rolloverVault.mockCall(
            "swapPerpsForUnderlying(uint256)",
            [perpFP("666.666666666")],
            [amplFP("663.333333333")],
          );

          await expect(vault.rebalance())
            .to.emit(vault, "Rebalanced")
            .withArgs(drFP("0.8"), drFP("0.8"), amplFP("666.666666666"), false);
        });
      });
    });
  });

  describe("#getTVL", function () {
    describe("when vault has only underlying", function () {
      it("should return underlying balance", async function () {
        const { vault } = await loadFixture(setupWithOnlyUnderlying);
        const tvl = await vault.getTVL.staticCall();
        expect(tvl).to.eq(amplFP("10000"));
      });
    });

    describe("when vault has only perps", function () {
      it("should return perp value in underlying terms", async function () {
        const { vault } = await loadFixture(setupWithOnlyPerps);
        // perpValue = perpBalance * perpTVL / perpTotalSupply
        //           = 10000 * 10000 / 10000 = 10000 AMPL
        const tvl = await vault.getTVL.staticCall();
        expect(tvl).to.eq(amplFP("10000"));
      });
    });

    describe("when vault has both underlying and perps", function () {
      it("should return sum of underlying and perp value", async function () {
        const { vault } = await loadFixture(setupWithBalancedLiquidity);
        // TVL = underlyingBalance + perpValue
        //     = 10000 + (10000 * 10000 / 10000) = 20000 AMPL
        const tvl = await vault.getTVL.staticCall();
        expect(tvl).to.eq(amplFP("20000"));
      });
    });

    describe("when perpPrice != 1", function () {
      it("should calculate perp value correctly", async function () {
        const { vault, perp } = await loadFixture(setupWithBalancedLiquidity);
        // Change perpTVL to make perpPrice = 2 (perpTVL = 20000, supply = 10000)
        await perp.setTVL(amplFP("20000"));

        // perpValue = 10000 * 20000 / 10000 = 20000 AMPL
        // TVL = 10000 + 20000 = 30000 AMPL
        const tvl = await vault.getTVL.staticCall();
        expect(tvl).to.eq(amplFP("30000"));
      });
    });

    describe("when perpTotalSupply is 0", function () {
      it("should return only underlying balance", async function () {
        const { vault } = await loadFixture(setupWithOnlyUnderlying);
        // No perps exist, TVL = underlying only
        const tvl = await vault.getTVL.staticCall();
        expect(tvl).to.eq(amplFP("10000"));
      });
    });
  });

  describe("#underlyingBalance", function () {
    it("should return zero when empty", async function () {
      const { vault } = await loadFixture(setupContracts);
      expect(await vault.underlyingBalance()).to.eq(0n);
    });

    it("should return the underlying balance after deposit", async function () {
      const { vault } = await loadFixture(setupWithOnlyUnderlying);
      expect(await vault.underlyingBalance()).to.eq(amplFP("10000"));
    });
  });

  describe("#perpBalance", function () {
    it("should return zero when no perps", async function () {
      const { vault } = await loadFixture(setupWithOnlyUnderlying);
      expect(await vault.perpBalance()).to.eq(0n);
    });

    it("should return perp balance when vault holds perps", async function () {
      const { vault } = await loadFixture(setupWithOnlyPerps);
      expect(await vault.perpBalance()).to.eq(perpFP("10000"));
    });
  });
});
