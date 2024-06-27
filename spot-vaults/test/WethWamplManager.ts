import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { DMock } from "./helpers";

describe.only("WethWamplManager", function () {
  async function setupContracts() {
    const accounts = await ethers.getSigners();
    const owner = accounts[0];
    const addr1 = accounts[1];

    // Deploy mock contracts
    const mockVault = new DMock("MockAlphaProVault");
    await mockVault.deploy();
    const mockCPIOracle = new DMock("MedianOracle");
    await mockCPIOracle.deploy();
    const mockETHOracle = new DMock("MockCLOracle");
    await mockETHOracle.deploy();
    await mockETHOracle.mockMethod("decimals()", [8]);

    // Deploy Manager contract
    const Manager = await ethers.getContractFactory("WethWamplManager");
    const manager = await Manager.deploy(
      mockVault.target,
      mockCPIOracle.target,
      mockETHOracle.target,
    );

    return { owner, addr1, mockVault, mockCPIOracle, mockETHOracle, manager };
  }

  describe("Initialization", function () {
    it("Should set the correct owner", async function () {
      const { manager, owner } = await loadFixture(setupContracts);
      expect(await manager.owner()).to.equal(await owner.getAddress());
    });

    it("Should set the correct vault address", async function () {
      const { manager, mockVault } = await loadFixture(setupContracts);
      expect(await manager.VAULT()).to.equal(mockVault.target);
    });

    it("Should set the correct CPI oracle address", async function () {
      const { manager, mockCPIOracle } = await loadFixture(setupContracts);
      expect(await manager.AMPL_CPI_ORACLE()).to.equal(mockCPIOracle.target);
    });

    it("Should set the correct ETH oracle address", async function () {
      const { manager, mockETHOracle } = await loadFixture(setupContracts);
      expect(await manager.ETH_ORACLE()).to.equal(mockETHOracle.target);
    });
  });

  // TODO: fix me!
  describe("Owner only methods", function () {
    it("Should fail to transfer ownership when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(
        manager.connect(addr1).transferOwnership(addr1.address),
      ).to.be.revertedWith("Unauthorized caller");
    });

    it("Should transfer ownership when called by owner", async function () {
      const { manager, owner, addr1 } = await loadFixture(setupContracts);
      await manager.connect(owner).transferOwnership(addr1.address);
      expect(await manager.owner()).to.equal(await addr1.getAddress());
    });

    it("Should fail to force rebalance when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      await expect(manager.connect(addr1).forceRebalance()).to.be.revertedWith(
        "Unauthorized caller",
      );
    });

    it("Should force rebalance when called by owner", async function () {
      const { manager, owner, mockVault } = await loadFixture(setupContracts);

      await mockVault.mockMethod("period()", [1000]);
      await mockVault.mockMethod("setPeriod(uint256)", []);
      await mockVault.mockMethod("rebalance()", []);

      await manager.connect(owner).forceRebalance();

      // Check that the calls were made to the mock vault
      const calls = await mockVault.mockCalls();
      expect(calls).to.include.deep.members([
        { data: mockVault.interface.encodeFunctionData("setPeriod", [0]) },
        { data: mockVault.interface.encodeFunctionData("rebalance", []) },
        { data: mockVault.interface.encodeFunctionData("setPeriod", [1000]) },
      ]);
    });

    it("Should fail to call vault method when called by non-owner", async function () {
      const { manager, addr1 } = await loadFixture(setupContracts);
      const methodSig = "0x12345678";
      const callData = "0xabcdef";

      await expect(
        manager.connect(addr1).callVaultMethod(methodSig, callData),
      ).to.be.revertedWith("Unauthorized caller");
    });

    it("Should call vault method when called by owner", async function () {
      const { manager, owner, mockVault } = await loadFixture(setupContracts);
      const methodSig = "0x12345678";
      const callData = "0xabcdef";
      const returnValue = "0xfeed";

      await mockVault.mockCall(methodSig, callData, returnValue);

      const result = await manager.connect(owner).callVaultMethod(methodSig, callData);
      expect(result).to.deep.equal([true, returnValue]);
    });
  });
});
