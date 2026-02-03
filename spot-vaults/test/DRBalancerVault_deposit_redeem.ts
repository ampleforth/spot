import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock, amplFP, perpFP, drFP, noteFP } from "./helpers";

describe("DRBalancerVault", function () {
  async function setupContracts() {
    const accounts = await ethers.getSigners();
    const deployer = accounts[0];
    const otherUser = accounts[1];

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

    // Mint tokens to users for testing
    await underlying.mint(deployer.getAddress(), amplFP("100000"));
    await underlying.mint(otherUser.getAddress(), amplFP("100000"));

    // Mint perp tokens to users for testing
    await perp.mint(deployer.getAddress(), perpFP("100000"));
    await perp.mint(otherUser.getAddress(), perpFP("100000"));

    // Approve vault to spend tokens
    await underlying.connect(deployer).approve(vault.target, ethers.MaxUint256);
    await underlying.connect(otherUser).approve(vault.target, ethers.MaxUint256);
    await perp.connect(deployer).approve(vault.target, ethers.MaxUint256);
    await perp.connect(otherUser).approve(vault.target, ethers.MaxUint256);

    return { deployer, otherUser, underlying, perp, rolloverVault, vault };
  }

  describe("#computeMintAmt", function () {
    describe("when both amounts are zero", function () {
      it("should return zeros", async function () {
        const { vault } = await loadFixture(setupContracts);
        const [notesMinted, underlyingAmtIn, perpAmtIn] =
          await vault.computeMintAmt.staticCall(0, 0);
        expect(notesMinted).to.eq(0n);
        expect(underlyingAmtIn).to.eq(0n);
        expect(perpAmtIn).to.eq(0n);
      });
    });

    describe("first mint (totalSupply = 0)", function () {
      it("should compute mint amount for underlying only", async function () {
        const { vault } = await loadFixture(setupContracts);
        // notesMinted = underlyingAmtIn * ONE / underlyingUnitAmt
        // = 1000 * 10^9 * 10^18 / 10^9 = 1000 * 10^18
        const [notesMinted, underlyingAmtIn, perpAmtIn] =
          await vault.computeMintAmt.staticCall(amplFP("1000"), 0);
        expect(notesMinted).to.eq(noteFP("1000"));
        expect(underlyingAmtIn).to.eq(amplFP("1000"));
        expect(perpAmtIn).to.eq(0n);
      });

      it("should compute mint amount for perp only", async function () {
        const { vault } = await loadFixture(setupContracts);
        // notesMinted = perpAmtIn * ONE / perpUnitAmt
        // = 500 * 10^9 * 10^18 / 10^9 = 500 * 10^18
        const [notesMinted, underlyingAmtIn, perpAmtIn] =
          await vault.computeMintAmt.staticCall(0, perpFP("500"));
        expect(notesMinted).to.eq(noteFP("500"));
        expect(underlyingAmtIn).to.eq(0n);
        expect(perpAmtIn).to.eq(perpFP("500"));
      });

      it("should compute mint amount for both tokens", async function () {
        const { vault } = await loadFixture(setupContracts);
        // notesMinted = (underlyingAmtIn * ONE / underlyingUnitAmt) + (perpAmtIn * ONE / perpUnitAmt)
        // = (1000 * 10^9 * 10^18 / 10^9) + (500 * 10^9 * 10^18 / 10^9)
        // = 1000 * 10^18 + 500 * 10^18 = 1500 * 10^18
        const [notesMinted, underlyingAmtIn, perpAmtIn] =
          await vault.computeMintAmt.staticCall(amplFP("1000"), perpFP("500"));
        expect(notesMinted).to.eq(noteFP("1500"));
        expect(underlyingAmtIn).to.eq(amplFP("1000"));
        expect(perpAmtIn).to.eq(perpFP("500"));
      });
    });

    describe("subsequent mint (totalSupply > 0, vault has only underlying)", function () {
      it("should compute mint amount proportional to balance", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), 0, 0);
        // notesMinted = totalSupply * underlyingAmtIn / underlyingBal
        // = 1000 * 10^18 * 500 * 10^9 / (1000 * 10^9) = 500 * 10^18
        const [notesMinted, underlyingAmtIn, perpAmtIn] =
          await vault.computeMintAmt.staticCall(amplFP("500"), perpFP("100"));
        expect(notesMinted).to.eq(noteFP("500"));
        expect(underlyingAmtIn).to.eq(amplFP("500"));
        expect(perpAmtIn).to.eq(0n); // perps ignored when vault has only underlying
      });
    });

    describe("subsequent mint (totalSupply > 0, vault has only perps)", function () {
      it("should compute mint amount proportional to balance", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.deposit(0, perpFP("1000"), 0);
        // notesMinted = totalSupply * perpAmtIn / perpBal
        // = 1000 * 10^18 * 500 * 10^9 / (1000 * 10^9) = 500 * 10^18
        const [notesMinted, underlyingAmtIn, perpAmtIn] =
          await vault.computeMintAmt.staticCall(amplFP("100"), perpFP("500"));
        expect(notesMinted).to.eq(noteFP("500"));
        expect(underlyingAmtIn).to.eq(0n); // underlying ignored when vault has only perps
        expect(perpAmtIn).to.eq(perpFP("500"));
      });
    });

    describe("subsequent mint (totalSupply > 0, vault has both tokens)", function () {
      it("should enforce vault ratio (underlying limited)", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), perpFP("500"), 0);
        // Vault ratio: 1000 AMPL : 500 SPOT = 2:1
        // User wants: 200 AMPL max, 200 SPOT max
        // Required perp for 200 AMPL: 500 * 200 / 1000 = 100 SPOT
        // Since 100 < 200 (perpAmtMax), underlying is the limit
        // notesMinted = totalSupply * underlyingAmtIn / underlyingBal
        // = 1500 * 10^18 * 200 * 10^9 / (1000 * 10^9) = 300 * 10^18
        const [notesMinted, underlyingAmtIn, perpAmtIn] =
          await vault.computeMintAmt.staticCall(amplFP("200"), perpFP("200"));
        expect(notesMinted).to.eq(noteFP("300"));
        expect(underlyingAmtIn).to.eq(amplFP("200"));
        expect(perpAmtIn).to.eq(perpFP("100"));
      });

      it("should enforce vault ratio (perp limited)", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), perpFP("500"), 0);
        // Vault ratio: 1000 AMPL : 500 SPOT = 2:1
        // User wants: 400 AMPL max, 100 SPOT max
        // Required perp for 400 AMPL: 500 * 400 / 1000 = 200 SPOT
        // Since 200 > 100 (perpAmtMax), perp is the limit
        // Required underlying for 100 SPOT: 1000 * 100 / 500 = 200 AMPL
        // notesMinted = totalSupply * underlyingAmtIn / underlyingBal
        // = 1500 * 10^18 * 200 * 10^9 / (1000 * 10^9) = 300 * 10^18
        const [notesMinted, underlyingAmtIn, perpAmtIn] =
          await vault.computeMintAmt.staticCall(amplFP("400"), perpFP("100"));
        expect(notesMinted).to.eq(noteFP("300"));
        expect(underlyingAmtIn).to.eq(amplFP("200"));
        expect(perpAmtIn).to.eq(perpFP("100"));
      });
    });
  });

  describe("#deposit", function () {
    describe("when paused", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.pause();
        await expect(vault.deposit(amplFP("100"), 0, 0)).to.be.revertedWith(
          "Pausable: paused",
        );
      });
    });

    describe("when both amounts are zero", function () {
      it("should return zero", async function () {
        const { vault } = await loadFixture(setupContracts);
        expect(await vault.deposit.staticCall(0, 0, 0)).to.eq(0n);
      });
    });

    describe("when slippage is too high", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        // Request 100 AMPL which would mint 100 notes, but require minimum 200 notes
        await expect(
          vault.deposit(amplFP("100"), 0, noteFP("200")),
        ).to.be.revertedWithCustomError(vault, "SlippageTooHigh");
      });
    });

    describe("first deposit (underlying only)", function () {
      it("should transfer underlying from user", async function () {
        const { deployer, vault, underlying } = await loadFixture(setupContracts);
        await expect(() => vault.deposit(amplFP("1000"), 0, 0)).to.changeTokenBalance(
          underlying,
          deployer,
          amplFP("-1000"),
        );
      });

      it("should mint notes to user", async function () {
        const { deployer, vault } = await loadFixture(setupContracts);
        // First deposit: notesMinted = underlyingAmtIn * ONE / underlyingUnitAmt
        // = 1000 * 10^9 * 10^18 / 10^9 = 1000 * 10^18
        await expect(() => vault.deposit(amplFP("1000"), 0, 0)).to.changeTokenBalance(
          vault,
          deployer,
          noteFP("1000"),
        );
        expect(await vault.totalSupply()).to.eq(noteFP("1000"));
      });

      it("should return mint amount", async function () {
        const { vault } = await loadFixture(setupContracts);
        const notesMinted = await vault.deposit.staticCall(amplFP("1000"), 0, 0);
        expect(notesMinted).to.eq(noteFP("1000"));
      });

      it("should emit Deposit event", async function () {
        const { deployer, vault } = await loadFixture(setupContracts);
        await expect(vault.deposit(amplFP("1000"), 0, 0))
          .to.emit(vault, "Deposit")
          .withArgs(await deployer.getAddress(), amplFP("1000"), 0n, noteFP("1000"));
      });
    });

    describe("first deposit (perp only)", function () {
      it("should transfer perp from user", async function () {
        const { deployer, vault, perp } = await loadFixture(setupContracts);
        await expect(() => vault.deposit(0, perpFP("500"), 0)).to.changeTokenBalance(
          perp,
          deployer,
          perpFP("-500"),
        );
      });

      it("should mint notes to user", async function () {
        const { deployer, vault } = await loadFixture(setupContracts);
        await expect(() => vault.deposit(0, perpFP("500"), 0)).to.changeTokenBalance(
          vault,
          deployer,
          noteFP("500"),
        );
        expect(await vault.totalSupply()).to.eq(noteFP("500"));
      });

      it("should emit Deposit event", async function () {
        const { deployer, vault } = await loadFixture(setupContracts);
        await expect(vault.deposit(0, perpFP("500"), 0))
          .to.emit(vault, "Deposit")
          .withArgs(await deployer.getAddress(), 0n, perpFP("500"), noteFP("500"));
      });
    });

    describe("first deposit (both tokens)", function () {
      it("should transfer both tokens from user", async function () {
        const { deployer, vault, underlying } = await loadFixture(setupContracts);
        await expect(() =>
          vault.deposit(amplFP("1000"), perpFP("500"), 0),
        ).to.changeTokenBalances(underlying, [deployer], [amplFP("-1000")]);
      });

      it("should transfer perp from user", async function () {
        const { deployer, vault, perp } = await loadFixture(setupContracts);
        await expect(() =>
          vault.deposit(amplFP("1000"), perpFP("500"), 0),
        ).to.changeTokenBalance(perp, deployer, perpFP("-500"));
      });

      it("should mint combined notes to user", async function () {
        const { deployer, vault } = await loadFixture(setupContracts);
        // notesMinted = (1000 + 500) * 10^18 = 1500 * 10^18
        await expect(() =>
          vault.deposit(amplFP("1000"), perpFP("500"), 0),
        ).to.changeTokenBalance(vault, deployer, noteFP("1500"));
        expect(await vault.totalSupply()).to.eq(noteFP("1500"));
      });

      it("should emit Deposit event", async function () {
        const { deployer, vault } = await loadFixture(setupContracts);
        await expect(vault.deposit(amplFP("1000"), perpFP("500"), 0))
          .to.emit(vault, "Deposit")
          .withArgs(
            await deployer.getAddress(),
            amplFP("1000"),
            perpFP("500"),
            noteFP("1500"),
          );
      });
    });

    describe("subsequent deposits (vault has only underlying)", function () {
      it("should transfer underlying from user", async function () {
        const { vault, underlying, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), 0, 0);
        await expect(() =>
          vault.connect(otherUser).deposit(amplFP("500"), perpFP("100"), 0),
        ).to.changeTokenBalance(underlying, otherUser, amplFP("-500"));
      });

      it("should not transfer perp (vault has only underlying)", async function () {
        const { vault, perp, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), 0, 0);
        await expect(() =>
          vault.connect(otherUser).deposit(amplFP("500"), perpFP("100"), 0),
        ).to.changeTokenBalance(perp, otherUser, 0n);
      });

      it("should mint proportional notes", async function () {
        const { vault, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), 0, 0);
        // notesMinted = totalSupply * underlyingAmtIn / underlyingBal
        // = 1000 * 10^18 * 500 * 10^9 / (1000 * 10^9) = 500 * 10^18
        await expect(() =>
          vault.connect(otherUser).deposit(amplFP("500"), 0, 0),
        ).to.changeTokenBalance(vault, otherUser, noteFP("500"));
        expect(await vault.totalSupply()).to.eq(noteFP("1500"));
      });

      it("should return mint amount", async function () {
        const { vault, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), 0, 0);
        const notesMinted = await vault
          .connect(otherUser)
          .deposit.staticCall(amplFP("500"), 0, 0);
        expect(notesMinted).to.eq(noteFP("500"));
      });

      it("should emit Deposit event", async function () {
        const { vault, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), 0, 0);
        await expect(vault.connect(otherUser).deposit(amplFP("500"), 0, 0))
          .to.emit(vault, "Deposit")
          .withArgs(await otherUser.getAddress(), amplFP("500"), 0n, noteFP("500"));
      });
    });

    describe("subsequent deposits (vault has only perps)", function () {
      it("should not transfer underlying (vault has only perps)", async function () {
        const { vault, underlying, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(0, perpFP("1000"), 0);
        await expect(() =>
          vault.connect(otherUser).deposit(amplFP("100"), perpFP("500"), 0),
        ).to.changeTokenBalance(underlying, otherUser, 0n);
      });

      it("should transfer perp from user", async function () {
        const { vault, perp, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(0, perpFP("1000"), 0);
        await expect(() =>
          vault.connect(otherUser).deposit(amplFP("100"), perpFP("500"), 0),
        ).to.changeTokenBalance(perp, otherUser, perpFP("-500"));
      });

      it("should mint proportional notes", async function () {
        const { vault, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(0, perpFP("1000"), 0);
        // notesMinted = totalSupply * perpAmtIn / perpBal
        // = 1000 * 10^18 * 500 * 10^9 / (1000 * 10^9) = 500 * 10^18
        await expect(() =>
          vault.connect(otherUser).deposit(0, perpFP("500"), 0),
        ).to.changeTokenBalance(vault, otherUser, noteFP("500"));
        expect(await vault.totalSupply()).to.eq(noteFP("1500"));
      });
    });

    describe("subsequent deposits (vault has both tokens)", function () {
      it("should transfer proportional amounts (underlying limited)", async function () {
        const { vault, underlying, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), perpFP("500"), 0);
        // Vault ratio: 1000 AMPL : 500 SPOT = 2:1
        // User offers: 200 AMPL max, 200 SPOT max
        // Required perp for 200 AMPL: 500 * 200 / 1000 = 100 SPOT
        await expect(() =>
          vault.connect(otherUser).deposit(amplFP("200"), perpFP("200"), 0),
        ).to.changeTokenBalances(
          underlying,
          [otherUser, vault],
          [amplFP("-200"), amplFP("200")],
        );
      });

      it("should transfer proportional perp (underlying limited)", async function () {
        const { vault, perp, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), perpFP("500"), 0);
        await expect(() =>
          vault.connect(otherUser).deposit(amplFP("200"), perpFP("200"), 0),
        ).to.changeTokenBalance(perp, otherUser, perpFP("-100"));
      });

      it("should transfer proportional amounts (perp limited)", async function () {
        const { vault, underlying, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), perpFP("500"), 0);
        // Vault ratio: 1000 AMPL : 500 SPOT = 2:1
        // User offers: 400 AMPL max, 100 SPOT max
        // Required perp for 400 AMPL: 500 * 400 / 1000 = 200 SPOT > 100 max
        // So perp is limiting: required underlying = 1000 * 100 / 500 = 200 AMPL
        await expect(() =>
          vault.connect(otherUser).deposit(amplFP("400"), perpFP("100"), 0),
        ).to.changeTokenBalance(underlying, otherUser, amplFP("-200"));
      });

      it("should transfer proportional perp (perp limited)", async function () {
        const { vault, perp, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), perpFP("500"), 0);
        await expect(() =>
          vault.connect(otherUser).deposit(amplFP("400"), perpFP("100"), 0),
        ).to.changeTokenBalance(perp, otherUser, perpFP("-100"));
      });

      it("should mint proportional notes", async function () {
        const { vault, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), perpFP("500"), 0);
        // notesMinted = totalSupply * underlyingAmtIn / underlyingBal
        // = 1500 * 10^18 * 200 * 10^9 / (1000 * 10^9) = 300 * 10^18
        await expect(() =>
          vault.connect(otherUser).deposit(amplFP("200"), perpFP("200"), 0),
        ).to.changeTokenBalance(vault, otherUser, noteFP("300"));
      });

      it("should emit Deposit event", async function () {
        const { vault, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), perpFP("500"), 0);
        await expect(vault.connect(otherUser).deposit(amplFP("200"), perpFP("200"), 0))
          .to.emit(vault, "Deposit")
          .withArgs(
            await otherUser.getAddress(),
            amplFP("200"),
            perpFP("100"),
            noteFP("300"),
          );
      });
    });

    describe("slippage protection", function () {
      it("should succeed when notes meet minimum", async function () {
        const { vault } = await loadFixture(setupContracts);
        // Deposit 1000 AMPL, expect at least 1000 notes
        const notesMinted = await vault.deposit.staticCall(
          amplFP("1000"),
          0,
          noteFP("1000"),
        );
        expect(notesMinted).to.eq(noteFP("1000"));
      });

      it("should revert when notes below minimum", async function () {
        const { vault } = await loadFixture(setupContracts);
        // Deposit 1000 AMPL (would mint 1000 notes), but require 1001 notes
        await expect(
          vault.deposit(amplFP("1000"), 0, noteFP("1001")),
        ).to.be.revertedWithCustomError(vault, "SlippageTooHigh");
      });
    });
  });

  describe("#computeRedemptionAmts", function () {
    describe("when notesAmt is zero", function () {
      it("should return zeros", async function () {
        const { vault } = await loadFixture(setupContracts);
        const [underlyingOut, perpOut] = await vault.computeRedemptionAmts.staticCall(0);
        expect(underlyingOut).to.eq(0n);
        expect(perpOut).to.eq(0n);
      });
    });

    describe("when totalSupply is zero", function () {
      it("should return zeros", async function () {
        const { vault } = await loadFixture(setupContracts);
        const [underlyingOut, perpOut] = await vault.computeRedemptionAmts.staticCall(
          noteFP("100"),
        );
        expect(underlyingOut).to.eq(0n);
        expect(perpOut).to.eq(0n);
      });
    });

    describe("when redeeming partial supply (only underlying)", function () {
      it("should return proportional amounts", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), 0, 0);
        // underlyingAmtOut = underlyingBalance * notesAmt / totalSupply
        // = 1000 * 10^9 * 500 * 10^18 / (1000 * 10^18) = 500 * 10^9
        const [underlyingOut, perpOut] = await vault.computeRedemptionAmts.staticCall(
          noteFP("500"),
        );
        expect(underlyingOut).to.eq(amplFP("500"));
        expect(perpOut).to.eq(0n);
      });
    });

    describe("when redeeming entire supply (only underlying)", function () {
      it("should return all underlying", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), 0, 0);
        const [underlyingOut, perpOut] = await vault.computeRedemptionAmts.staticCall(
          noteFP("1000"),
        );
        expect(underlyingOut).to.eq(amplFP("1000"));
        expect(perpOut).to.eq(0n);
      });
    });

    describe("when vault holds both underlying and perps", function () {
      it("should return proportional amounts of both", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"), perpFP("200"), 0);
        // underlyingAmtOut = 1000 * 10^9 * 600 * 10^18 / (1200 * 10^18) = 500 * 10^9
        // perpAmtOut = 200 * 10^9 * 600 * 10^18 / (1200 * 10^18) = 100 * 10^9
        const [underlyingOut, perpOut] = await vault.computeRedemptionAmts.staticCall(
          noteFP("600"),
        );
        expect(underlyingOut).to.eq(amplFP("500"));
        expect(perpOut).to.eq(perpFP("100"));
      });
    });
  });

  describe("#redeem", function () {
    async function setupWithDeposited() {
      const fixtures = await setupContracts();
      const { vault } = fixtures;
      await vault.deposit(amplFP("1000"), 0, 0);
      return fixtures;
    }

    describe("when paused", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupWithDeposited);
        await vault.pause();
        await expect(vault.redeem(noteFP("100"), 0, 0)).to.be.revertedWith(
          "Pausable: paused",
        );
      });
    });

    describe("when amount is zero", function () {
      it("should return zeros", async function () {
        const { vault } = await loadFixture(setupWithDeposited);
        const [underlyingOut, perpOut] = await vault.redeem.staticCall(0, 0, 0);
        expect(underlyingOut).to.eq(0n);
        expect(perpOut).to.eq(0n);
      });
    });

    describe("when slippage is too high", function () {
      it("should revert when underlying below minimum", async function () {
        const { vault } = await loadFixture(setupWithDeposited);
        // Request 400 notes redeem which would give 400 AMPL, but require minimum 500 AMPL
        await expect(
          vault.redeem(noteFP("400"), amplFP("500"), 0),
        ).to.be.revertedWithCustomError(vault, "SlippageTooHigh");
      });

      it("should revert when perp below minimum", async function () {
        const { vault } = await loadFixture(setupWithDeposited);
        // Request 400 notes redeem which would give 0 SPOT, but require minimum 1 SPOT
        await expect(
          vault.redeem(noteFP("400"), 0, perpFP("1")),
        ).to.be.revertedWithCustomError(vault, "SlippageTooHigh");
      });
    });

    describe("on partial redemption", function () {
      it("should burn notes from user", async function () {
        const { deployer, vault } = await loadFixture(setupWithDeposited);
        await expect(() => vault.redeem(noteFP("400"), 0, 0)).to.changeTokenBalance(
          vault,
          deployer,
          noteFP("-400"),
        );
        expect(await vault.totalSupply()).to.eq(noteFP("600"));
      });

      it("should transfer underlying to user", async function () {
        const { deployer, vault, underlying } = await loadFixture(setupWithDeposited);
        // underlyingAmtOut = 1000 * 10^9 * 400 * 10^18 / (1000 * 10^18) = 400 * 10^9
        await expect(() => vault.redeem(noteFP("400"), 0, 0)).to.changeTokenBalance(
          underlying,
          deployer,
          amplFP("400"),
        );
      });

      it("should return redemption amounts", async function () {
        const { vault } = await loadFixture(setupWithDeposited);
        const [underlyingOut, perpOut] = await vault.redeem.staticCall(
          noteFP("400"),
          0,
          0,
        );
        expect(underlyingOut).to.eq(amplFP("400"));
        expect(perpOut).to.eq(0n);
      });

      it("should emit Redeem event", async function () {
        const { deployer, vault } = await loadFixture(setupWithDeposited);
        await expect(vault.redeem(noteFP("400"), 0, 0))
          .to.emit(vault, "Redeem")
          .withArgs(await deployer.getAddress(), noteFP("400"), amplFP("400"), 0n);
      });
    });

    describe("on complete redemption", function () {
      it("should burn all notes from user", async function () {
        const { deployer, vault } = await loadFixture(setupWithDeposited);
        await expect(() => vault.redeem(noteFP("1000"), 0, 0)).to.changeTokenBalance(
          vault,
          deployer,
          noteFP("-1000"),
        );
        expect(await vault.balanceOf(await deployer.getAddress())).to.eq(0n);
        expect(await vault.totalSupply()).to.eq(0n);
      });

      it("should transfer all underlying to user", async function () {
        const { deployer, vault, underlying } = await loadFixture(setupWithDeposited);
        await expect(() => vault.redeem(noteFP("1000"), 0, 0)).to.changeTokenBalance(
          underlying,
          deployer,
          amplFP("1000"),
        );
      });

      it("should return redemption amounts", async function () {
        const { vault } = await loadFixture(setupWithDeposited);
        const [underlyingOut, perpOut] = await vault.redeem.staticCall(
          noteFP("1000"),
          0,
          0,
        );
        expect(underlyingOut).to.eq(amplFP("1000"));
        expect(perpOut).to.eq(0n);
      });

      it("should emit Redeem event", async function () {
        const { deployer, vault } = await loadFixture(setupWithDeposited);
        await expect(vault.redeem(noteFP("1000"), 0, 0))
          .to.emit(vault, "Redeem")
          .withArgs(await deployer.getAddress(), noteFP("1000"), amplFP("1000"), 0n);
      });
    });

    describe("when vault holds both underlying and perps", function () {
      async function setupWithBothTokens() {
        const fixtures = await setupContracts();
        const { vault } = fixtures;
        // Deposit both: 1000 AMPL + 500 SPOT = 1500 notes
        await vault.deposit(amplFP("1000"), perpFP("500"), 0);
        return fixtures;
      }

      it("should transfer proportional amounts of both", async function () {
        const { deployer, vault, underlying } = await loadFixture(setupWithBothTokens);
        // Redeem 750 notes (half): should get 500 AMPL and 250 SPOT
        await expect(() => vault.redeem(noteFP("750"), 0, 0)).to.changeTokenBalances(
          underlying,
          [deployer],
          [amplFP("500")],
        );
      });

      it("should transfer proportional perps to user", async function () {
        const { deployer, vault, perp } = await loadFixture(setupWithBothTokens);
        // perpAmtOut = 500 * 10^9 * 750 * 10^18 / (1500 * 10^18) = 250 * 10^9
        await expect(() => vault.redeem(noteFP("750"), 0, 0)).to.changeTokenBalance(
          perp,
          deployer,
          perpFP("250"),
        );
      });

      it("should return both redemption amounts", async function () {
        const { vault } = await loadFixture(setupWithBothTokens);
        const [underlyingOut, perpOut] = await vault.redeem.staticCall(
          noteFP("750"),
          0,
          0,
        );
        expect(underlyingOut).to.eq(amplFP("500"));
        expect(perpOut).to.eq(perpFP("250"));
      });

      it("should emit Redeem event with both amounts", async function () {
        const { deployer, vault } = await loadFixture(setupWithBothTokens);
        await expect(vault.redeem(noteFP("750"), 0, 0))
          .to.emit(vault, "Redeem")
          .withArgs(
            await deployer.getAddress(),
            noteFP("750"),
            amplFP("500"),
            perpFP("250"),
          );
      });
    });

    describe("slippage protection", function () {
      async function setupWithBothTokens() {
        const fixtures = await setupContracts();
        const { vault } = fixtures;
        await vault.deposit(amplFP("1000"), perpFP("500"), 0);
        return fixtures;
      }

      it("should succeed when amounts meet minimum", async function () {
        const { vault } = await loadFixture(setupWithBothTokens);
        // Redeem 750 notes: expect 500 AMPL and 250 SPOT
        const [underlyingOut, perpOut] = await vault.redeem.staticCall(
          noteFP("750"),
          amplFP("500"),
          perpFP("250"),
        );
        expect(underlyingOut).to.eq(amplFP("500"));
        expect(perpOut).to.eq(perpFP("250"));
      });

      it("should revert when underlying below minimum", async function () {
        const { vault } = await loadFixture(setupWithBothTokens);
        await expect(
          vault.redeem(noteFP("750"), amplFP("501"), perpFP("250")),
        ).to.be.revertedWithCustomError(vault, "SlippageTooHigh");
      });

      it("should revert when perp below minimum", async function () {
        const { vault } = await loadFixture(setupWithBothTokens);
        await expect(
          vault.redeem(noteFP("750"), amplFP("500"), perpFP("251")),
        ).to.be.revertedWithCustomError(vault, "SlippageTooHigh");
      });
    });
  });
});
