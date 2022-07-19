import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";

task("deploy:BondIssuer")
  .addParam("bondFactoryAddress", "the address of the band factory", undefined, types.string, false)
  .addParam("issueFrequency", "time between issues", undefined, types.int, false)
  .addParam("issueWindowOffset", "clock alignment for window opening", undefined, types.int, false)
  .addParam("bondDuration", "length of the bonds", undefined, types.int, false)
  .addParam("collateralTokenAddress", "address of the collateral token", undefined, types.string, false)
  .addParam("trancheRatios", "list of tranche ratios", undefined, types.json, false)
  .setAction(async function (args: TaskArguments, hre) {
    const {
      bondFactoryAddress,
      issueFrequency,
      issueWindowOffset,
      bondDuration,
      collateralTokenAddress,
      trancheRatios,
    } = args;
    console.log("Signer", await (await hre.ethers.getSigners())[0].getAddress());

    const BondIssuer = await hre.ethers.getContractFactory("BondIssuer");
    const bondIssuer = await BondIssuer.deploy(
      bondFactoryAddress,
      issueFrequency,
      issueWindowOffset,
      bondDuration,
      collateralTokenAddress,
      trancheRatios,
    );

    await bondIssuer.deployed();

    await bondIssuer.issue();

    await hre.run("verify:contract", {
      address: bondIssuer.address,
      constructorArguments: [
        bondFactoryAddress,
        issueFrequency,
        issueWindowOffset,
        bondDuration,
        collateralTokenAddress,
        trancheRatios,
      ],
    });

    console.log("Bond issuer", bondIssuer.address);
  });

task("deploy:PerpetualTranche")
  .addParam("bondIssuerAddress", "the address of the bond issuer", undefined, types.string, false)
  .addParam("collateralTokenAddress", "the address of the collateral token", undefined, types.string, false)
  .addParam("name", "the ERC20 name", undefined, types.string, false)
  .addParam("symbol", "the ERC20 symbol", undefined, types.string, false)
  .addParam("minMatuirtySec", "the minimum maturity in seconds for bond to in reserve", 1, types.int)
  .addParam("maxMatuirtySec", "the maximum maturity in seconds for bond to in reserve", 86400, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { bondIssuerAddress, collateralTokenAddress, name, symbol, minMatuirtySec, maxMatuirtySec } = args;
    const deployer = (await hre.ethers.getSigners())[0];
    console.log("Signer", await deployer.getAddress());

    const PerpetualTranche = await hre.ethers.getContractFactory("PerpetualTranche");
    const perp = await hre.upgrades.deployProxy(PerpetualTranche.connect(deployer));
    await perp.deployed();

    const BasicFeeStrategy = await hre.ethers.getContractFactory("BasicFeeStrategy");
    const feeStrategy = await BasicFeeStrategy.deploy(perp.address, perp.address, "1000000", "1000000", "0");
    await feeStrategy.deployed();

    const CDRPricingStrategy = await hre.ethers.getContractFactory("CDRPricingStrategy");
    const pricingStrategy = await CDRPricingStrategy.deploy();
    await pricingStrategy.deployed();

    const TrancheClassYieldStrategy = await hre.ethers.getContractFactory("TrancheClassYieldStrategy");
    const yieldStrategy = await TrancheClassYieldStrategy.deploy();
    await yieldStrategy.deployed();
    await yieldStrategy.init();

    console.log("perp", perp.address);
    console.log("feeStrategy", feeStrategy.address);
    console.log("pricingStrategy", pricingStrategy.address);
    console.log("yieldStrategy", yieldStrategy.address);

    const initTx = await perp.init(
      name,
      symbol,
      collateralTokenAddress,
      bondIssuerAddress,
      feeStrategy.address,
      pricingStrategy.address,
      yieldStrategy.address,
    );
    await initTx.wait();
    await perp.updateTolerableTrancheMaturity(minMatuirtySec, maxMatuirtySec);

    await hre.run("verify:contract", {
      address: feeStrategy.address,
      constructorArguments: [perp.address, perp.address, "1000000", "1000000", "0"],
    });

    await hre.run("verify:contract", {
      address: pricingStrategy.address,
    });

    await hre.run("verify:contract", {
      address: yieldStrategy.address,
    });

    await hre.run("verify:contract", {
      address: perp.address,
    });
  });

task("deploy:YieldStrategy:setYield")
  .addParam("yieldStrategyAddress", "the address of the yield strategy contract", undefined, types.string, false)
  .addParam("collateralTokenAddress", "the address of the collateral token", undefined, types.string, false)
  .addParam("trancheRatios", "the bond's tranche ratios", undefined, types.json, false)
  .addParam("trancheIndex", "the tranche's index", undefined, types.string, false)
  .addParam("trancheYield", "the yields to be set in float", undefined, types.string, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { yieldStrategyAddress, collateralTokenAddress, trancheRatios, trancheIndex, trancheYield } = args;
    const yieldStrategy = await hre.ethers.getContractAt("TrancheClassYieldStrategy", yieldStrategyAddress);
    const abiCoder = new hre.ethers.utils.AbiCoder();
    const hash = hre.ethers.utils.keccak256(
      abiCoder.encode(["address", "uint256[]", "uint256"], [collateralTokenAddress, trancheRatios, trancheIndex]),
    );
    const tx = await yieldStrategy.updateDefinedYield(
      hash,
      hre.ethers.utils.parseUnits(trancheYield, await yieldStrategy.decimals()),
    );
    console.log(tx.hash);
    await tx.wait();
  });

task("deploy:Router").setAction(async function (args: TaskArguments, hre) {
  console.log("Signer", await (await hre.ethers.getSigners())[0].getAddress());

  const RouterV1 = await hre.ethers.getContractFactory("RouterV1");
  const router = await RouterV1.deploy();
  await router.deployed();

  console.log("router", router.address);
  await hre.run("verify:contract", {
    address: router.address,
  });
});
