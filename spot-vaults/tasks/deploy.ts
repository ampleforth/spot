import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { sleep } from "./tools";

task("deploy:mocks").setAction(async function (args: TaskArguments, hre) {
  const deployer = (await hre.ethers.getSigners())[0];
  console.log("Signer", await deployer.getAddress());

  const MockUSDOracle = await hre.ethers.getContractFactory("MockCLOracle");
  const usdOracle = await MockUSDOracle.deploy();
  console.log("usdOracle", usdOracle.target);
  await usdOracle.mockLastRoundData("100000000", parseInt(Date.now() / 1000));

  const MockCPIOracle = await hre.ethers.getContractFactory("MockCPIOracle");
  const cpiOracle = await MockCPIOracle.deploy();
  console.log("cpiOracle", cpiOracle.target);
  await cpiOracle.mockData("1200000000000000000", true);
});

task("deploy:SpotAppraiser")
  .addParam("perp", "the address of the perp token", undefined, types.string, false)
  .addParam("usdOracle", "the address of the usd oracle", undefined, types.string, false)
  .addParam("cpiOracle", "the address of the usd oracle", undefined, types.string, false)
  .addParam("verify", "flag to set false for local deployments", true, types.boolean)
  .setAction(async function (args: TaskArguments, hre) {
    const deployer = (await hre.ethers.getSigners())[0];
    console.log("Signer", await deployer.getAddress());

    const { perp, usdOracle, cpiOracle } = args;

    const SpotAppraiser = await hre.ethers.getContractFactory("SpotAppraiser");
    const spotAppraiser = await SpotAppraiser.deploy(perp, usdOracle, cpiOracle);
    console.log("spotAppraiser", spotAppraiser.target);

    if (args.verify) {
      await sleep(30);
      await hre.run("verify:contract", {
        address: spotAppraiser.target,
      });
    } else {
      console.log("Skipping verification");
    }
  });

task("deploy:BillBroker")
  .addParam(
    "name",
    "the ERC20 name of the bill broker LP token",
    undefined,
    types.string,
    false,
  )
  .addParam(
    "symbol",
    "the ERC20 symbol of the bill broker LP token",
    undefined,
    types.string,
    false,
  )
  .addParam("usd", "the address of the usd token", undefined, types.string, false)
  .addParam("perp", "the address of the perp token", undefined, types.string, false)
  .addParam(
    "pricingStrategy",
    "the address of the pricing strategy",
    undefined,
    types.string,
    false,
  )
  .addParam("verify", "flag to set false for local deployments", true, types.boolean)
  .setAction(async function (args: TaskArguments, hre) {
    const deployer = (await hre.ethers.getSigners())[0];
    console.log("Signer", await deployer.getAddress());

    const { name, symbol, usd, perp, pricingStrategy } = args;
    const BillBroker = await hre.ethers.getContractFactory("BillBroker");
    const billBroker = await hre.upgrades.deployProxy(
      BillBroker.connect(deployer),
      [name, symbol, usd, perp, pricingStrategy],
      {
        initializer: "init(string,string,address,address,address)",
      },
    );
    console.log("billBroker", billBroker.target);

    if (args.verify) {
      await sleep(30);
      await hre.run("verify:contract", {
        address: billBroker.target,
      });
    } else {
      console.log("Skipping verification");
    }
  });

task("deploy:WethWamplManager")
  .addParam(
    "vault",
    "the address of the weth-wampl charm vault",
    undefined,
    types.string,
    false,
  )
  .addParam("cpiOracle", "the address of the usd oracle", undefined, types.string, false)
  .addParam("ethOracle", "the address of the eth oracle", undefined, types.string, false)
  .addParam("verify", "flag to set false for local deployments", true, types.boolean)
  .setAction(async function (args: TaskArguments, hre) {
    const deployer = (await hre.ethers.getSigners())[0];
    console.log("Signer", await deployer.getAddress());

    const { vault, cpiOracle, ethOracle } = args;

    const WethWamplManager = await hre.ethers.getContractFactory("WethWamplManager");
    const manager = await WethWamplManager.deploy(vault, cpiOracle, ethOracle);
    console.log("wethWamplManager", manager.target);

    if (args.verify) {
      await sleep(30);
      await hre.run("verify:contract", {
        address: manager.target,
        constructorArguments: [vault, ethOracle, cpiOracle],
      });
    } else {
      console.log("Skipping verification");
    }
  });
