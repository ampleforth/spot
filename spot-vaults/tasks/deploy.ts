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

task("deploy:SpotPricer")
  .addParam(
    "wethWamplPool",
    "the address of the weth-wampl univ3 pool",
    undefined,
    types.string,
    false,
  )
  .addParam(
    "usdcSpotPool",
    "the address of the usdc-spot univ3 pool",
    undefined,
    types.string,
    false,
  )
  .addParam("ethOracle", "the address of the eth oracle", undefined, types.string, false)
  .addParam("usdOracle", "the address of the usd oracle", undefined, types.string, false)
  .addParam("verify", "flag to set false for local deployments", true, types.boolean)
  .setAction(async function (args: TaskArguments, hre) {
    const deployer = (await hre.ethers.getSigners())[0];
    console.log("Signer", await deployer.getAddress());

    const { wethWamplPool, usdcSpotPool, ethOracle, usdOracle } = args;

    const SpotPricer = await hre.ethers.getContractFactory("SpotPricer");
    const spotPricer = await SpotPricer.deploy(
      wethWamplPool,
      usdcSpotPool,
      ethOracle,
      usdOracle,
    );
    console.log("spotPricer", spotPricer.target);

    if (args.verify) {
      await sleep(30);
      await hre.run("verify:contract", {
        address: spotPricer.target,
        constructorArguments: [wethWamplPool, usdcSpotPool, ethOracle, usdOracle],
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
  .addParam("oracle", "the address of the oracle", undefined, types.string, false)
  .addParam("verify", "flag to set false for local deployments", true, types.boolean)
  .setAction(async function (args: TaskArguments, hre) {
    const deployer = (await hre.ethers.getSigners())[0];
    console.log("Signer", await deployer.getAddress());

    const { name, symbol, usd, perp, oracle } = args;
    const BillBroker = await hre.ethers.getContractFactory("BillBroker");
    const billBroker = await hre.upgrades.deployProxy(
      BillBroker.connect(deployer),
      [name, symbol, usd, perp, oracle],
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

task("deploy:CharmManager")
  .addParam(
    "manager",
    "the contract reference of the manager to be deployed",
    undefined,
    types.string,
    false,
  )
  .addParam("vault", "the address of the charm vault", undefined, types.string, false)
  .addParam("oracle", "the address of the meta oracle", undefined, types.string, false)
  .addParam("verify", "flag to set false for local deployments", true, types.boolean)
  .setAction(async function (args: TaskArguments, hre) {
    const deployer = (await hre.ethers.getSigners())[0];
    console.log("Signer", await deployer.getAddress());

    const { manager, vault, oracle } = args;

    const Factory = await hre.ethers.getContractFactory(manager);
    const mgr = await Factory.deploy(vault, oracle);
    console.log(manager, mgr.target);

    if (args.verify) {
      await sleep(30);
      await hre.run("verify:contract", {
        address: mgr.target,
        constructorArguments: [vault, oracle],
      });
    } else {
      console.log("Skipping verification");
    }
  });
