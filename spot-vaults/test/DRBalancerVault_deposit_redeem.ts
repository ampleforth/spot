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

    // Approve vault to spend tokens
    await underlying.connect(deployer).approve(vault.target, ethers.MaxUint256);
    await underlying.connect(otherUser).approve(vault.target, ethers.MaxUint256);

    return { deployer, otherUser, underlying, perp, rolloverVault, vault };
  }

  describe("#computeMintAmt", function () {
    describe("when underlyingAmtIn is zero", function () {
      it("should return zero", async function () {
        const { vault } = await loadFixture(setupContracts);
        expect(await vault.computeMintAmt.staticCall(0)).to.eq(0n);
      });
    });

    describe("first mint (totalSupply = 0)", function () {
      it("should compute mint amount", async function () {
        const { vault } = await loadFixture(setupContracts);
        // notesMinted = underlyingAmtIn * ONE / underlyingUnitAmt
        // = 1000 * 10^9 * 10^18 / 10^9 = 1000 * 10^18
        expect(await vault.computeMintAmt.staticCall(amplFP("1000"))).to.eq(
          noteFP("1000"),
        );
      });
    });

    describe("subsequent mint (totalSupply > 0)", function () {
      it("should compute mint amount proportional to TVL", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"));
        // notesMinted = totalSupply * underlyingAmtIn / TVL
        // = 1000 * 10^18 * 500 * 10^9 / (1000 * 10^9) = 500 * 10^18
        expect(await vault.computeMintAmt.staticCall(amplFP("500"))).to.eq(noteFP("500"));
      });
    });
  });

  describe("#deposit", function () {
    describe("when paused", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupContracts);
        await vault.pause();
        await expect(vault.deposit(amplFP("100"))).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when amount is zero", function () {
      it("should return zero", async function () {
        const { vault } = await loadFixture(setupContracts);
        expect(await vault.deposit.staticCall(0)).to.eq(0n);
      });
    });

    describe("first deposit", function () {
      it("should transfer underlying from user", async function () {
        const { deployer, vault, underlying } = await loadFixture(setupContracts);
        await expect(() => vault.deposit(amplFP("1000"))).to.changeTokenBalance(
          underlying,
          deployer,
          amplFP("-1000"),
        );
      });

      it("should mint notes to user", async function () {
        const { deployer, vault } = await loadFixture(setupContracts);
        // First deposit: notesMinted = underlyingAmtIn * ONE / underlyingUnitAmt
        // = 1000 * 10^9 * 10^18 / 10^9 = 1000 * 10^18
        await expect(() => vault.deposit(amplFP("1000"))).to.changeTokenBalance(
          vault,
          deployer,
          noteFP("1000"),
        );
        expect(await vault.totalSupply()).to.eq(noteFP("1000"));
      });

      it("should return mint amount", async function () {
        const { vault } = await loadFixture(setupContracts);
        const notesMinted = await vault.deposit.staticCall(amplFP("1000"));
        expect(notesMinted).to.eq(noteFP("1000"));
      });

      it("should emit Deposit event", async function () {
        const { deployer, vault } = await loadFixture(setupContracts);
        await expect(vault.deposit(amplFP("1000")))
          .to.emit(vault, "Deposit")
          .withArgs(await deployer.getAddress(), amplFP("1000"), noteFP("1000"));
      });
    });

    describe("subsequent deposits", function () {
      it("should transfer underlying from user", async function () {
        const { vault, underlying, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"));
        await expect(() =>
          vault.connect(otherUser).deposit(amplFP("500")),
        ).to.changeTokenBalance(underlying, otherUser, amplFP("-500"));
      });

      it("should mint proportional notes", async function () {
        const { vault, otherUser } = await loadFixture(setupContracts);
        // First deposit: 1000 AMPL -> 1000 notes
        await vault.deposit(amplFP("1000"));
        // Second deposit: 500 AMPL -> 500 notes (same ratio)
        // notesMinted = totalSupply * underlyingAmtIn / TVL
        // = 1000 * 10^18 * 500 * 10^9 / (1000 * 10^9) = 500 * 10^18
        await expect(() =>
          vault.connect(otherUser).deposit(amplFP("500")),
        ).to.changeTokenBalance(vault, otherUser, noteFP("500"));
        expect(await vault.totalSupply()).to.eq(noteFP("1500"));
      });

      it("should return mint amount", async function () {
        const { vault, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"));
        const notesMinted = await vault
          .connect(otherUser)
          .deposit.staticCall(amplFP("500"));
        expect(notesMinted).to.eq(noteFP("500"));
      });

      it("should emit Deposit event", async function () {
        const { vault, otherUser } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"));
        await expect(vault.connect(otherUser).deposit(amplFP("500")))
          .to.emit(vault, "Deposit")
          .withArgs(await otherUser.getAddress(), amplFP("500"), noteFP("500"));
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
        await vault.deposit(amplFP("1000"));
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
        await vault.deposit(amplFP("1000"));
        const [underlyingOut, perpOut] = await vault.computeRedemptionAmts.staticCall(
          noteFP("1000"),
        );
        expect(underlyingOut).to.eq(amplFP("1000"));
        expect(perpOut).to.eq(0n);
      });
    });

    describe("when vault holds both underlying and perps", function () {
      it("should return proportional amounts of both", async function () {
        const { vault, perp } = await loadFixture(setupContracts);
        await vault.deposit(amplFP("1000"));
        // Simulate vault receiving perps (e.g., from a rebalance)
        await perp.mint(vault.target, perpFP("200"));
        // underlyingAmtOut = 1000 * 10^9 * 500 * 10^18 / (1000 * 10^18) = 500 * 10^9
        // perpAmtOut = 200 * 10^9 * 500 * 10^18 / (1000 * 10^18) = 100 * 10^9
        const [underlyingOut, perpOut] = await vault.computeRedemptionAmts.staticCall(
          noteFP("500"),
        );
        expect(underlyingOut).to.eq(amplFP("500"));
        expect(perpOut).to.eq(perpFP("100"));
      });
    });
  });

  describe("#redeem", function () {
    async function setupWithDeposit() {
      const fixtures = await setupContracts();
      const { vault } = fixtures;
      await vault.deposit(amplFP("1000"));
      return fixtures;
    }

    describe("when paused", function () {
      it("should revert", async function () {
        const { vault } = await loadFixture(setupWithDeposit);
        await vault.pause();
        await expect(vault.redeem(noteFP("100"))).to.be.revertedWith("Pausable: paused");
      });
    });

    describe("when amount is zero", function () {
      it("should return zeros", async function () {
        const { vault } = await loadFixture(setupWithDeposit);
        const [underlyingOut, perpOut] = await vault.redeem.staticCall(0);
        expect(underlyingOut).to.eq(0n);
        expect(perpOut).to.eq(0n);
      });
    });

    describe("on partial redemption", function () {
      it("should burn notes from user", async function () {
        const { deployer, vault } = await loadFixture(setupWithDeposit);
        await expect(() => vault.redeem(noteFP("400"))).to.changeTokenBalance(
          vault,
          deployer,
          noteFP("-400"),
        );
        expect(await vault.totalSupply()).to.eq(noteFP("600"));
      });

      it("should transfer underlying to user", async function () {
        const { deployer, vault, underlying } = await loadFixture(setupWithDeposit);
        // underlyingAmtOut = 1000 * 10^9 * 400 * 10^18 / (1000 * 10^18) = 400 * 10^9
        await expect(() => vault.redeem(noteFP("400"))).to.changeTokenBalance(
          underlying,
          deployer,
          amplFP("400"),
        );
      });

      it("should return redemption amounts", async function () {
        const { vault } = await loadFixture(setupWithDeposit);
        const [underlyingOut, perpOut] = await vault.redeem.staticCall(noteFP("400"));
        expect(underlyingOut).to.eq(amplFP("400"));
        expect(perpOut).to.eq(0n);
      });

      it("should emit Redeem event", async function () {
        const { deployer, vault } = await loadFixture(setupWithDeposit);
        await expect(vault.redeem(noteFP("400")))
          .to.emit(vault, "Redeem")
          .withArgs(await deployer.getAddress(), noteFP("400"), amplFP("400"), 0n);
      });
    });

    describe("on complete redemption", function () {
      it("should burn all notes from user", async function () {
        const { deployer, vault } = await loadFixture(setupWithDeposit);
        await expect(() => vault.redeem(noteFP("1000"))).to.changeTokenBalance(
          vault,
          deployer,
          noteFP("-1000"),
        );
        expect(await vault.balanceOf(await deployer.getAddress())).to.eq(0n);
        expect(await vault.totalSupply()).to.eq(0n);
      });

      it("should transfer all underlying to user", async function () {
        const { deployer, vault, underlying } = await loadFixture(setupWithDeposit);
        await expect(() => vault.redeem(noteFP("1000"))).to.changeTokenBalance(
          underlying,
          deployer,
          amplFP("1000"),
        );
      });

      it("should return redemption amounts", async function () {
        const { vault } = await loadFixture(setupWithDeposit);
        const [underlyingOut, perpOut] = await vault.redeem.staticCall(noteFP("1000"));
        expect(underlyingOut).to.eq(amplFP("1000"));
        expect(perpOut).to.eq(0n);
      });

      it("should emit Redeem event", async function () {
        const { deployer, vault } = await loadFixture(setupWithDeposit);
        await expect(vault.redeem(noteFP("1000")))
          .to.emit(vault, "Redeem")
          .withArgs(await deployer.getAddress(), noteFP("1000"), amplFP("1000"), 0n);
      });
    });

    describe("when vault holds both underlying and perps", function () {
      it("should transfer proportional amounts of both", async function () {
        const { deployer, vault, underlying, perp } = await loadFixture(setupWithDeposit);
        // Simulate vault receiving perps
        await perp.mint(vault.target, perpFP("500"));

        // Redeem half: should get 500 AMPL and 250 SPOT
        await expect(() => vault.redeem(noteFP("500"))).to.changeTokenBalances(
          underlying,
          [deployer],
          [amplFP("500")],
        );
      });

      it("should transfer proportional perps to user", async function () {
        const { deployer, vault, perp } = await loadFixture(setupWithDeposit);
        await perp.mint(vault.target, perpFP("500"));
        // perpAmtOut = 500 * 10^9 * 500 * 10^18 / (1000 * 10^18) = 250 * 10^9
        await expect(() => vault.redeem(noteFP("500"))).to.changeTokenBalance(
          perp,
          deployer,
          perpFP("250"),
        );
      });

      it("should return both redemption amounts", async function () {
        const { vault, perp } = await loadFixture(setupWithDeposit);
        await perp.mint(vault.target, perpFP("500"));
        const [underlyingOut, perpOut] = await vault.redeem.staticCall(noteFP("500"));
        expect(underlyingOut).to.eq(amplFP("500"));
        expect(perpOut).to.eq(perpFP("250"));
      });

      it("should emit Redeem event with both amounts", async function () {
        const { deployer, vault, perp } = await loadFixture(setupWithDeposit);
        await perp.mint(vault.target, perpFP("500"));
        await expect(vault.redeem(noteFP("500")))
          .to.emit(vault, "Redeem")
          .withArgs(
            await deployer.getAddress(),
            noteFP("500"),
            amplFP("500"),
            perpFP("250"),
          );
      });
    });
  });
});
