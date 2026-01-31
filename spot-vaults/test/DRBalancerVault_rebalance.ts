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
    await vault.deposit(amplFP("10000"));

    // Mint 10000 perps to vault, with perpTVL = 10000, so perpPrice = 1
    await perp.mint(vault.target, perpFP("10000"));

    return fixtures;
  }

  // Fixture with only underlying (no perps in vault, but perps exist in system)
  async function setupWithOnlyUnderlying() {
    const fixtures = await setupContracts();
    const { vault, perp, deployer } = fixtures;
    await vault.deposit(amplFP("10000"));
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
    // - DR ranges: equilibrium (0.95-1.05), low (<0.95), high (>1.05)
    // - Limiters: lag limiter, minAmt limiter, maxAmt limiter, overshoot protection

    describe("DR in equilibrium zone (0.95 - 1.05)", function () {
      it("should return 0 at DR = 1.0 (center)", async function () {
        const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
        await rolloverVault.mockMethod("deviationRatio()", [drFP("1")]);

        const [amt, isUnderlyingIntoPerp] =
          await vault.computeRebalanceAmount.staticCall();
        expect(amt).to.eq(0n);
        expect(isUnderlyingIntoPerp).to.eq(true);
      });

      it("should return 0 at DR = 0.95 (lower bound)", async function () {
        const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
        await rolloverVault.mockMethod("deviationRatio()", [drFP("0.95")]);

        const [amt, isUnderlyingIntoPerp] =
          await vault.computeRebalanceAmount.staticCall();
        expect(amt).to.eq(0n);
        expect(isUnderlyingIntoPerp).to.eq(true);
      });

      it("should return 0 at DR = 1.05 (upper bound)", async function () {
        const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
        await rolloverVault.mockMethod("deviationRatio()", [drFP("1.05")]);

        const [amt, isUnderlyingIntoPerp] =
          await vault.computeRebalanceAmount.staticCall();
        expect(amt).to.eq(0n);
        expect(isUnderlyingIntoPerp).to.eq(true);
      });
    });

    describe("DR below equilibrium (perp -> underlying swap)", function () {
      // When DR < target: redeem perps to decrease perpTVL
      // isUnderlyingIntoPerp = false

      describe("lag limiter active", function () {
        it("should use adjustedChange when within [minAmt, maxAmt]", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.5")]);

          // drDelta = 1.0 - 0.5 = 0.5
          // requiredChange = perpTVL * drDelta = 10000 * 0.5 = 5000 AMPL
          // adjustedChange = 5000 / 3 (lagFactor) = 1666.666... AMPL
          // availableLiquidity = perpValue = 10000 * 10000 / 10000 = 10000 AMPL
          // minAmt = 10000 * 10% = 1000, maxAmt = 10000 * 50% = 5000
          // 1000 < 1666 < 5000, so lag limiter is active
          // 1666 < requiredChange (5000), no overshoot
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("1666.666666666"));
          expect(isUnderlyingIntoPerp).to.eq(false);
        });
      });

      describe("minAmt limiter active", function () {
        it("should use minAmt when adjustedChange < minAmt", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.8")]);

          // drDelta = 1.0 - 0.8 = 0.2
          // requiredChange = 10000 * 0.2 = 2000 AMPL
          // adjustedChange = 2000 / 3 = 666.666... AMPL
          // availableLiquidity = 10000 AMPL
          // minAmt = 1000, maxAmt = 5000
          // 666 < minAmt (1000), so minAmt limiter is active
          // minAmt (1000) < requiredChange (2000), no overshoot
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("1000"));
          expect(isUnderlyingIntoPerp).to.eq(false);
        });
      });

      describe("maxAmt limiter active", function () {
        it("should use maxAmt when adjustedChange > maxAmt", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          // Set lagFactor to 1 so adjustedChange = requiredChange
          await vault.updateRebalanceConfigPerpToUnderlying(1, {
            lower: ONE / 10n,
            upper: ONE / 2n,
          });
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.3")]);

          // drDelta = 1.0 - 0.3 = 0.7
          // requiredChange = 10000 * 0.7 = 7000 AMPL
          // adjustedChange = 7000 / 1 = 7000 AMPL
          // availableLiquidity = 10000 AMPL
          // minAmt = 1000, maxAmt = 5000
          // 7000 > maxAmt (5000), so maxAmt limiter is active
          // maxAmt (5000) < requiredChange (7000), no overshoot
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("5000"));
          expect(isUnderlyingIntoPerp).to.eq(false);
        });
      });

      describe("overshoot protection active", function () {
        it("should cap at requiredChange when minAmt > requiredChange", async function () {
          const { vault, rolloverVault, perp } = await loadFixture(setupContracts);
          // Large liquidity = high minAmt
          await vault.deposit(amplFP("50000"));
          await perp.mint(vault.target, perpFP("50000"));
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.9")]);

          // drDelta = 1.0 - 0.9 = 0.1
          // requiredChange = 10000 * 0.1 = 1000 AMPL
          // adjustedChange = 1000 / 3 = 333 AMPL
          // availableLiquidity = 50000 * 10000 / 10000 = 50000 AMPL
          // minAmt = 50000 * 10% = 5000, maxAmt = 25000
          // 333 < minAmt, so would use 5000
          // But 5000 > requiredChange (1000), so overshoot protection caps at 1000
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("1000"));
          expect(isUnderlyingIntoPerp).to.eq(false);
        });

        it("should cap at requiredChange when maxAmt > requiredChange", async function () {
          const { vault, rolloverVault, perp } = await loadFixture(setupContracts);
          // Large liquidity with high max percentage
          await vault.deposit(amplFP("50000"));
          await perp.mint(vault.target, perpFP("50000"));
          // Set min=1%, max=90%, lagFactor=1
          await vault.updateRebalanceConfigPerpToUnderlying(1, {
            lower: ONE / 100n,
            upper: (ONE * 90n) / 100n,
          });
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.9")]);

          // drDelta = 0.1
          // requiredChange = 10000 * 0.1 = 1000 AMPL
          // adjustedChange = 1000 / 1 = 1000 AMPL
          // availableLiquidity = 50000 AMPL
          // minAmt = 500, maxAmt = 45000
          // 500 < 1000 < 45000, so lag limiter would give 1000
          // 1000 = requiredChange, so no overshoot (boundary case)
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

          // availableLiquidity = 0, minAmt = maxAmt = 0
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(0n);
          expect(isUnderlyingIntoPerp).to.eq(false);
        });
      });
    });

    describe("DR above equilibrium (underlying -> perp swap)", function () {
      // When DR > target: mint perps to increase perpTVL
      // isUnderlyingIntoPerp = true

      describe("lag limiter active", function () {
        it("should use adjustedChange when within [minAmt, maxAmt]", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.5")]);

          // drDelta = 1.5 - 1.0 = 0.5
          // requiredChange = 10000 * 0.5 = 5000 AMPL
          // adjustedChange = 5000 / 3 = 1666.666... AMPL
          // availableLiquidity = underlyingBalance = 10000 AMPL
          // minAmt = 1000, maxAmt = 5000
          // 1000 < 1666 < 5000, so lag limiter is active
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("1666.666666666"));
          expect(isUnderlyingIntoPerp).to.eq(true);
        });
      });

      describe("minAmt limiter active", function () {
        it("should use minAmt when adjustedChange < minAmt", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.2")]);

          // drDelta = 1.2 - 1.0 = 0.2
          // requiredChange = 10000 * 0.2 = 2000 AMPL
          // adjustedChange = 2000 / 3 = 666.666... AMPL
          // availableLiquidity = 10000 AMPL
          // minAmt = 1000, maxAmt = 5000
          // 666 < minAmt (1000), so minAmt limiter is active
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("1000"));
          expect(isUnderlyingIntoPerp).to.eq(true);
        });
      });

      describe("maxAmt limiter active", function () {
        it("should use maxAmt when adjustedChange > maxAmt", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          // Set lagFactor to 1 so adjustedChange = requiredChange
          await vault.updateRebalanceConfigUnderlyingToPerp(1, {
            lower: ONE / 10n,
            upper: ONE / 2n,
          });
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.7")]);

          // drDelta = 1.7 - 1.0 = 0.7
          // requiredChange = 10000 * 0.7 = 7000 AMPL
          // adjustedChange = 7000 / 1 = 7000 AMPL
          // availableLiquidity = 10000 AMPL
          // minAmt = 1000, maxAmt = 5000
          // 7000 > maxAmt (5000), so maxAmt limiter is active
          const [amt, isUnderlyingIntoPerp] =
            await vault.computeRebalanceAmount.staticCall();
          expect(amt).to.eq(amplFP("5000"));
          expect(isUnderlyingIntoPerp).to.eq(true);
        });
      });

      describe("overshoot protection active", function () {
        it("should cap at requiredChange when minAmt > requiredChange", async function () {
          const { vault, rolloverVault, perp } = await loadFixture(setupContracts);
          // Large liquidity = high minAmt
          await vault.deposit(amplFP("50000"));
          await perp.mint(vault.target, perpFP("10000")); // Need perps for perpTotalSupply
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.1")]);

          // drDelta = 1.1 - 1.0 = 0.1
          // requiredChange = 10000 * 0.1 = 1000 AMPL
          // adjustedChange = 1000 / 3 = 333 AMPL
          // availableLiquidity = 50000 AMPL
          // minAmt = 50000 * 10% = 5000, maxAmt = 25000
          // 333 < minAmt, so would use 5000
          // But 5000 > requiredChange (1000), so overshoot protection caps at 1000
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

          // availableLiquidity = 0, minAmt = maxAmt = 0
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
        expect(isUnderlyingIntoPerp).to.eq(true);
      });

      it("should handle DR just outside equilibrium (0.9499...)", async function () {
        const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
        // DR = 0.94999999 (just below 0.95 equilibrium lower bound)
        await rolloverVault.mockMethod("deviationRatio()", [drFP("0.94999999")]);

        const [amt, isUnderlyingIntoPerp] =
          await vault.computeRebalanceAmount.staticCall();
        // Should trigger rebalance since outside equilibrium
        expect(amt).to.be.gt(0n);
        expect(isUnderlyingIntoPerp).to.eq(false);
      });

      it("should handle DR just outside equilibrium (1.0500...)", async function () {
        const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
        // DR = 1.05000001 (just above 1.05 equilibrium upper bound)
        await rolloverVault.mockMethod("deviationRatio()", [drFP("1.05000001")]);

        const [amt, isUnderlyingIntoPerp] =
          await vault.computeRebalanceAmount.staticCall();
        // Should trigger rebalance since outside equilibrium
        expect(amt).to.be.gt(0n);
        expect(isUnderlyingIntoPerp).to.eq(true);
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
          .to.emit(vault, "Rebalance")
          .withArgs(drFP("1"), drFP("1"), 0n, true);
      });
    });

    describe("when system DR is in equilibrium zone", function () {
      it("should emit Rebalance event with zero swap amount", async function () {
        const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
        await rolloverVault.mockMethod("deviationRatio()", [drFP("1")]);

        await expect(vault.rebalance())
          .to.emit(vault, "Rebalance")
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
        // mockCall only returns value when called with exact parameters
        // This verifies the contract passes amplFP("1000") to swapUnderlyingForPerps
        await rolloverVault.mockCall(
          "swapUnderlyingForPerps(uint256)",
          [amplFP("1000")],
          [perpFP("1000")],
        );

        // underlyingAmt = 1000 (see computeRebalanceAmount tests)
        // isUnderlyingIntoPerp = true
        await expect(vault.rebalance())
          .to.emit(vault, "Rebalance")
          .withArgs(drFP("1.2"), drFP("1.2"), amplFP("1000"), true);
      });
    });

    describe("perp -> underlying swap (DR too low)", function () {
      it("should call swapPerpsForUnderlying with correct amount", async function () {
        const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
        await rolloverVault.mockMethod("deviationRatio()", [drFP("0.8")]);
        // underlyingValSwapped = 1000 AMPL
        // perpAmtIn = underlyingValSwapped * perpTotalSupply / perpTVL
        //           = 1000 * 10000 / 10000 = 1000 SPOT
        // mockCall verifies the contract passes perpFP("1000") to swapPerpsForUnderlying
        await rolloverVault.mockCall(
          "swapPerpsForUnderlying(uint256)",
          [perpFP("1000")],
          [amplFP("1000")],
        );

        // underlyingAmt = 1000 (see computeRebalanceAmount tests)
        // isUnderlyingIntoPerp = false
        await expect(vault.rebalance())
          .to.emit(vault, "Rebalance")
          .withArgs(drFP("0.8"), drFP("0.8"), amplFP("1000"), false);
      });
    });

    describe("slippage protection", function () {
      describe("underlying -> perp swap", function () {
        it("should revert when fee exceeds max", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.2")]);

          // Swap 1000 AMPL, return only 900 SPOT (10% fee when perpPrice = 1)
          // feePerc = 1 - 900/1000 = 10%
          await rolloverVault.mockCall(
            "swapUnderlyingForPerps(uint256)",
            [amplFP("1000")],
            [perpFP("900")],
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

          // No fee: swap 1000 AMPL, return 1000 SPOT
          await rolloverVault.mockCall(
            "swapUnderlyingForPerps(uint256)",
            [amplFP("1000")],
            [perpFP("1000")],
          );

          await expect(vault.rebalance())
            .to.emit(vault, "Rebalance")
            .withArgs(drFP("1.2"), drFP("1.2"), amplFP("1000"), true);
        });

        it("should succeed when fee is within limit", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.2")]);

          // 0.5% fee: swap 1000 AMPL, return 995 SPOT
          await rolloverVault.mockCall(
            "swapUnderlyingForPerps(uint256)",
            [amplFP("1000")],
            [perpFP("995")],
          );

          // Default max fee is 1%
          await expect(vault.rebalance())
            .to.emit(vault, "Rebalance")
            .withArgs(drFP("1.2"), drFP("1.2"), amplFP("1000"), true);
        });

        it("should succeed when fee equals max limit", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("1.2")]);
          await vault.updateMaxSwapFeePerc(ONE / 20n); // 5%

          // Exactly 5% fee: swap 1000 AMPL, return 950 SPOT
          await rolloverVault.mockCall(
            "swapUnderlyingForPerps(uint256)",
            [amplFP("1000")],
            [perpFP("950")],
          );

          await expect(vault.rebalance())
            .to.emit(vault, "Rebalance")
            .withArgs(drFP("1.2"), drFP("1.2"), amplFP("1000"), true);
        });
      });

      describe("perp -> underlying swap", function () {
        it("should revert when fee exceeds max", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.8")]);

          // Swap 1000 SPOT (perpAmtIn), return only 900 AMPL (10% fee)
          await rolloverVault.mockCall(
            "swapPerpsForUnderlying(uint256)",
            [perpFP("1000")],
            [amplFP("900")],
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

          // No fee: swap 1000 SPOT, return 1000 AMPL
          await rolloverVault.mockCall(
            "swapPerpsForUnderlying(uint256)",
            [perpFP("1000")],
            [amplFP("1000")],
          );

          await expect(vault.rebalance())
            .to.emit(vault, "Rebalance")
            .withArgs(drFP("0.8"), drFP("0.8"), amplFP("1000"), false);
        });

        it("should succeed when fee is within limit", async function () {
          const { vault, rolloverVault } = await loadFixture(setupWithBalancedLiquidity);
          await rolloverVault.mockMethod("deviationRatio()", [drFP("0.8")]);

          // 0.5% fee: swap 1000 SPOT, return 995 AMPL
          await rolloverVault.mockCall(
            "swapPerpsForUnderlying(uint256)",
            [perpFP("1000")],
            [amplFP("995")],
          );

          await expect(vault.rebalance())
            .to.emit(vault, "Rebalance")
            .withArgs(drFP("0.8"), drFP("0.8"), amplFP("1000"), false);
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

  describe("#getSystemDeviationRatio", function () {
    it("should return DR from rollover vault", async function () {
      const { vault, rolloverVault } = await loadFixture(setupContracts);
      await rolloverVault.mockMethod("deviationRatio()", [drFP("0.95")]);

      const dr = await vault.getSystemDeviationRatio.staticCall();
      expect(dr).to.eq(drFP("0.95"));
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
