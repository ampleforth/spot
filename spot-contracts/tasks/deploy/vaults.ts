import { getImplementationAddress } from "@openzeppelin/upgrades-core";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { sleep } from "../helpers";

task("deploy:RolloverVault")
  .addParam("perpAddress", "The address of the perpetual tranche contract", undefined, types.string, false)
  .addParam("name", "the ERC20 name", undefined, types.string, false)
  .addParam("symbol", "the ERC20 symbol", undefined, types.string, false)
  .addParam("verify", "flag to set false for local deployments", true, types.boolean)
  .setAction(async function (args: TaskArguments, hre) {
    const { perpAddress, name, symbol, verify } = args;
    const deployer = (await hre.ethers.getSigners())[0];
    console.log("Signer", await deployer.getAddress());

    const RolloverVault = await hre.ethers.getContractFactory("RolloverVault");
    const vault = await hre.upgrades.deployProxy(RolloverVault.connect(deployer));

    const implAddress = await getImplementationAddress(hre.ethers.provider, vault.target);

    console.log("perp", perpAddress);
    console.log("vault", vault.target);
    console.log("vaultImpl", implAddress);

    const initTx = await vault.init(name, symbol, perpAddress);
    await initTx.wait();

    if (verify) {
      await sleep(15);
      await hre.run("verify:contract", {
        address: implAddress,
      });
    } else {
      console.log("Skipping verification");
    }
  });
