import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { getImplementationAddress } from "@openzeppelin/upgrades-core";
import { sleep } from "../helpers";

task("deploy:BondIssuer")
  .addParam("bondFactoryAddress", "the address of the band factory", undefined, types.string, false)
  .addParam("issueFrequency", "time between issues", undefined, types.int, false)
  .addParam("issueWindowOffset", "clock alignment for window opening", undefined, types.int, false)
  .addParam("bondDuration", "length of the bonds", undefined, types.int, false)
  .addParam("collateralTokenAddress", "address of the collateral token", undefined, types.string, false)
  .addParam("trancheRatios", "list of tranche ratios", undefined, types.json, false)
  .addParam("verify", "flag to set false for local deployments", true, types.boolean)
  .addParam("issue", "flag to set true to issue first bond", false, types.boolean)
  .setAction(async function (args: TaskArguments, hre) {
    const {
      bondFactoryAddress,
      issueFrequency,
      issueWindowOffset,
      bondDuration,
      collateralTokenAddress,
      trancheRatios,
      verify,
      issue,
    } = args;

    const signers = await hre.ethers.getSigners();
    const deployer = signers[0];
    console.log("Signer", await deployer.getAddress());

    const BondIssuer = hre.ethers.getContractFactory("BondIssuer");
    const bondIssuer = await hre.upgrades.deployProxy(
      BondIssuer.connect(deployer),
      [bondFactoryAddress, collateralTokenAddress, bondDuration, trancheRatios, issueFrequency, issueWindowOffset],
      {
        initializer: "init(address,address,uint256,uint256[],uint256,uint256)",
      },
    );
    if (issue) {
      await (await bondIssuer.issue()).wait();
    }
    if (verify) {
      await sleep(30);
      await hre.run("verify:contract", {
        address: bondIssuer.target,
        constructorArguments: [bondFactoryAddress, collateralTokenAddress],
      });
    } else {
      console.log("Skipping verification");
    }

    console.log("Bond issuer", bondIssuer.target);
  });

task("deploy:PerpSystem")
  .addParam("bondIssuerAddress", "the address of the bond issuer", undefined, types.string, false)
  .addParam("collateralTokenAddress", "the address of the collateral token", undefined, types.string, false)
  .addParam("perpName", "the ERC20 name of the perp token", undefined, types.string, false)
  .addParam("perpSymbol", "the ERC20 symbol of the perp token", undefined, types.string, false)
  .addParam("vaultName", "the ERC20 name of the vault token", undefined, types.string, false)
  .addParam("vaultSymbol", "the ERC20 symbol of the vault token", undefined, types.string, false)
  .addParam("verify", "flag to set false for local deployments", true, types.boolean)
  .setAction(async function (args: TaskArguments, hre) {
    const { bondIssuerAddress, collateralTokenAddress, perpName, perpSymbol, vaultName, vaultSymbol, verify } = args;
    const deployer = (await hre.ethers.getSigners())[0];
    console.log("Signer", await deployer.getAddress());

    const FeePolicy = await hre.ethers.getContractFactory("FeePolicy");
    const feePolicy = await hre.upgrades.deployProxy(FeePolicy.connect(deployer));

    const PerpetualTranche = await hre.ethers.getContractFactory("PerpetualTranche");
    const perp = await hre.upgrades.deployProxy(PerpetualTranche.connect(deployer));

    const RolloverVault = await hre.ethers.getContractFactory("RolloverVault");
    const vault = await hre.upgrades.deployProxy(RolloverVault.connect(deployer));

    console.log("perp", perp.target);
    console.log("vault", vault.target);
    console.log("feePolicy", feePolicy.target);

    console.log("fee policy init");
    await (await feePolicy.init()).wait();

    console.log("perp init");
    const perpInitTx = await perp.init(
      perpName,
      perpSymbol,
      collateralTokenAddress,
      bondIssuerAddress,
      feePolicy.target,
    );
    await perpInitTx.wait();

    console.log("vault init");
    const vaultInitTx = await vault.init(vaultName, vaultSymbol, perp.target, feePolicy.target);
    await vaultInitTx.wait();

    console.log("point perp to vault");
    await (await perp.updateVault(vault.target)).wait();

    if (verify) {
      await sleep(30);
      // We just need to verify the proxy once
      await hre.run("verify:contract", {
        address: feePolicy.target,
      });
      // Verifying implementations
      await hre.run("verify:contract", {
        address: await getImplementationAddress(hre.ethers.provider, feePolicy.target),
      });
      await hre.run("verify:contract", {
        address: await getImplementationAddress(hre.ethers.provider, perp.target),
      });
      await hre.run("verify:contract", {
        address: await getImplementationAddress(hre.ethers.provider, vault.target),
      });
    } else {
      console.log("Skipping verification");
    }
  });

task("deploy:Router")
  .addParam("verify", "flag to set false for local deployments", true, types.boolean)
  .setAction(async function (args: TaskArguments, hre) {
    console.log("Signer", await (await hre.ethers.getSigners())[0].getAddress());

    const RouterV2 = await hre.ethers.getContractFactory("RouterV2");
    const router = await RouterV2.deploy();
    console.log("RouterV2", router.target);

    if (args.verify) {
      await sleep(30);
      await hre.run("verify:contract", {
        address: router.target,
      });
    } else {
      console.log("Skipping verification");
    }
  });

task("deploy:FeePolicy")
  .addParam("verify", "flag to set false for local deployments", true, types.boolean)
  .setAction(async function (args: TaskArguments, hre) {
    const deployer = (await hre.ethers.getSigners())[0];
    console.log("Signer", await deployer.getAddress());

    const FeePolicy = await hre.ethers.getContractFactory("FeePolicy");
    const feePolicy = await hre.upgrades.deployProxy(FeePolicy.connect(deployer), [], {
      initializer: "init()",
    });
    console.log("feePolicy", feePolicy.target);

    if (args.verify) {
      await sleep(30);
      await hre.run("verify:contract", {
        address: feePolicy.target,
      });
      await hre.run("verify:contract", {
        address: await getImplementationAddress(hre.ethers.provider, feePolicy.target),
      });
    } else {
      console.log("Skipping verification");
    }
  });
