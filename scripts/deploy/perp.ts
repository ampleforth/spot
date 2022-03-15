import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";

task("deploy:BondIssuer")
  .addParam("bondFactory", "the address of the band factory", undefined, types.string, false)
  .addParam("issueFrequency", "time between issues", undefined, types.int, false)
  .addParam("issueWindowOffset", "clock alignment for window opening", undefined, types.int, false)
  .addParam("bondDuration", "length of the bonds", undefined, types.int, false)
  .addParam("collateralToken", "address of the collateral token", undefined, types.string, false)
  .addParam("trancheRatios", "list of tranche ratios", undefined, types.json, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { bondFactory, issueFrequency, issueWindowOffset, bondDuration, collateralToken, trancheRatios } = args;
    console.log("Signer", await (await hre.ethers.getSigners())[0].getAddress());

    const BondIssuer = await hre.ethers.getContractFactory("BondIssuer");
    const bondIssuer = await BondIssuer.deploy(
      bondFactory,
      issueFrequency,
      issueWindowOffset,
      bondDuration,
      collateralToken,
      trancheRatios,
    );

    await bondIssuer.deployed();

    await bondIssuer.issue();

    await hre.run("verify:contract", {
      address: bondIssuer.address,
      constructorArguments: [
        bondFactory,
        issueFrequency,
        issueWindowOffset,
        bondDuration,
        collateralToken,
        trancheRatios,
      ],
    });

    console.log("Bond issuer implementation", bondIssuer.address);
  });

task("deploy:PerpetualTranche")
  .addParam("bondIssuer", "the address of the bond issuer", undefined, types.string, false)
  .addParam("name", "the ERC20 name", undefined, types.string, false)
  .addParam("symbol", "the ERC20 symbol", undefined, types.string, false)
  .addParam("decimals", "the number of decimals", undefined, types.int, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { bondIssuer, name, symbol, decimals } = args;
    console.log("Signer", await (await hre.ethers.getSigners())[0].getAddress());

    const PerpetualTranche = await hre.ethers.getContractFactory("PerpetualTranche");
    const perp = await PerpetualTranche.deploy(name, symbol, decimals);
    await perp.deployed();

    const BasicFeeStrategy = await hre.ethers.getContractFactory("BasicFeeStrategy");
    const feeStrategyArgs = [perp.address, perp.address, perp.address, "10000", "10000", "10000"];
    const feeStrategy = await BasicFeeStrategy.deploy(...feeStrategyArgs);
    await feeStrategy.deployed();

    const BasicPricingStrategy = await hre.ethers.getContractFactory("BasicPricingStrategy");
    const pricingStrategy = await BasicPricingStrategy.deploy();
    await pricingStrategy.deployed();

    await perp.init(bondIssuer, pricingStrategy.address, feeStrategy.address);
    await perp.updateTolerableBondMaturiy("0", "864000");

    console.log("perp", perp.address);
    console.log("feeStrategy", feeStrategy.address);
    console.log("pricingStrategy", pricingStrategy.address);

    await hre.run("verify:contract", {
      address: feeStrategy.address,
      constructorArguments: feeStrategyArgs,
    });

    await hre.run("verify:contract", {
      address: pricingStrategy.address,
    });

    await hre.run("verify:contract", {
      address: perp.address,
      constructorArguments: [name, symbol, decimals],
    });
  });

task("deploy:PerpetualTranche:setYield")
  .addParam("perp", "the address of the perp contract", undefined, types.string, false)
  .addParam("collateralToken", "the address of the collateral token", undefined, types.string, false)
  .addParam("trancheRatios", "the bond's tranche ratios", undefined, types.json, false)
  .addParam("yields", "the yields to be set", undefined, types.json, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { perp, collateralToken, trancheRatios, yields } = args;
    const pTranche = await hre.ethers.getContractAt("PerpetualTranche", perp);
    const abiCoder = new hre.ethers.utils.AbiCoder();
    const hash = hre.ethers.utils.keccak256(
      abiCoder.encode(["address", "uint256[]"], [collateralToken, trancheRatios]),
    );
    await pTranche.updateBondYields(hash, yields);
  });

task("deploy:RolloverVault")
  .addParam("perp", "the address of the perp contract", undefined, types.string, false)
  .addParam("underlying", "the address of the underlying asset", undefined, types.string, false)
  .addParam("name", "the ERC20 name of the vault token", undefined, types.string, false)
  .addParam("symbol", "the ERC20 symbol of the vault token", undefined, types.string, false)
  .addParam("initialRate", "the initial exchange rate", "100000", types.string, true)
  .setAction(async function (args: TaskArguments, hre) {
    const { perp, underlying, name, symbol, initialRate } = args;
    console.log("Signer", await (await hre.ethers.getSigners())[0].getAddress());

    const RolloverVault = await hre.ethers.getContractFactory("RolloverVault");
    const constructorArguments = [perp, underlying, name, symbol];
    const vault = await RolloverVault.deploy(...constructorArguments);

    await vault.deployed();

    const token = await hre.ethers.getContractAt("IERC20", underlying);
    await token.approve(vault.address, vault.INITIAL_DEPOSIT());

    await vault.init(initialRate, "20000", "7200");

    console.log("rolloverVault", vault.address);

    await hre.run("verify:contract", {
      address: vault.address,
      constructorArguments: constructorArguments,
    });
  });

task("deploy:Router").setAction(async function (args: TaskArguments, hre) {
  const { bondIssuer, name, symbol, decimals } = args;
  console.log("Signer", await (await hre.ethers.getSigners())[0].getAddress());

  const RouterV1 = await hre.ethers.getContractFactory("RouterV1");
  const router = await RouterV1.deploy();
  await router.deployed();

  console.log("router", router.address);
  await hre.run("verify:contract", {
    address: router.address,
  });
});
