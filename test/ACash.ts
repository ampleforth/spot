import { expect } from "chai";
import { ethers } from "hardhat";

describe("ACash", function () {
  it("Should construct with name and symbol", async function () {
      const ACash = await ethers.getContractFactory("ACash");
      const acash = await ACash.deploy("Spot Cash", "SPOT", "9");
      await acash.deployed();

      expect(await acash.name()).to.equal("Spot Cash");
      expect(await acash.symbol()).to.equal("SPOT");
      expect(await acash.decimals()).to.equal(9);

      //    const setGreetingTx = await acash.setGreeting("Hola, mundo!");

      // wait until the transaction is mined
      // await setGreetingTx.wait();

      //    expect(await acash.greet()).to.equal("Hola, mundo!");
  });
});
