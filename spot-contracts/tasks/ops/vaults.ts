import { getAdminAddress, getImplementationAddress } from "@openzeppelin/upgrades-core";
import { task, types } from "hardhat/config";
import { TaskArguments } from "hardhat/types";
import { BigNumber, utils } from "ethers";

task("ops:vault:info")
  .addPositionalParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);
    const vaultDecimals = await vault.decimals();
    const proxyAdminAddress = await getAdminAddress(hre.ethers.provider, vaultAddress);
    const implAddress = await getImplementationAddress(hre.ethers.provider, vaultAddress);
    const vaultSupply = await vault.totalSupply();

    const perp = await hre.ethers.getContractAt("PerpetualTranche", await vault.perp());
    const perpDecimals = await perp.decimals();
    const priceDecimals = await perp.PRICE_DECIMALS();

    const underlying = await hre.ethers.getContractAt("MockERC20", await vault.underlying());
    const underlyingDecimals = await underlying.decimals();

    let pokeAvailable = true;
    try {
      await vault.callStatic.recoverAndRedeploy();
    } catch (e) {
      pokeAvailable = false;
    }
    console.log("---------------------------------------------------------------");
    console.log("RolloverVault:", vault.address);
    console.log("proxyAdmin:", proxyAdminAddress);
    console.log("implementation:", implAddress);
    console.log("owner:", await vault.owner());
    console.log("paused:", await vault.paused());
    console.log("perp:", perp.address);
    console.log("underlying:", underlying.address);
    console.log("minDeploymentAmt:", utils.formatUnits(await vault.minDeploymentAmt(), underlyingDecimals));
    console.log("totalSupply:", utils.formatUnits(vaultSupply, vaultDecimals));
    console.log("tvl:", utils.formatUnits(await vault.callStatic.getTVL(), underlyingDecimals));
    console.log("pokeAvailable:", pokeAvailable);
    console.log("---------------------------------------------------------------");
    const data = [];
    const underlyingBalance = await vault.vaultAssetBalance(underlying.address);
    data.push({
      asset: await underlying.symbol(),
      balance: utils.formatUnits(underlyingBalance, underlyingDecimals),
      price: "1",
    });
    const deployedCount = (await vault.deployedCount()).toNumber();
    for (let i = 0; i < deployedCount; i++) {
      const tokenAddress = await vault.callStatic.deployedAt(i);
      const balance = await vault.vaultAssetBalance(tokenAddress);
      const value = await vault.callStatic.getVaultAssetValue(tokenAddress);
      const price = value.mul(BigNumber.from(10 ** priceDecimals)).div(balance);

      const token = await hre.ethers.getContractAt("MockERC20", tokenAddress);
      data.push({
        asset: await token.symbol(),
        balance: utils.formatUnits(balance, underlyingDecimals),
        price: utils.formatUnits(price, priceDecimals),
      });
    }

    const earned1Balance = await vault.vaultAssetBalance(perp.address);
    const earned1Price = await perp.callStatic.getAvgPrice();
    data.push({
      asset: await perp.symbol(),
      balance: utils.formatUnits(earned1Balance, perpDecimals),
      price: utils.formatUnits(earned1Price, priceDecimals),
    });
    console.table(data);
  });

task("ops:vault:deposit")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam(
    "underlyingAmount",
    "the total amount of underlying tokens (in float) to deposit",
    undefined,
    types.string,
    false,
  )
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress, underlyingAmount } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);
    const underlying = await hre.ethers.getContractAt("MockERC20", await vault.underlying());
    const fixedPtAmount = utils.parseUnits(underlyingAmount, await underlying.decimals());

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Signer note balance", utils.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()));
    console.log(
      "Signer underlying balance",
      utils.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Approving router to spend tokens:");
    if ((await underlying.allowance(signerAddress, vault.address)).lt(fixedPtAmount)) {
      const tx1 = await underlying.connect(signer).approve(vault.address, fixedPtAmount);
      await tx1.wait();
      console.log("Tx", tx1.hash);
    }

    console.log("Deposit:");
    const tx3 = await vault.connect(signer).deposit(fixedPtAmount);
    await tx3.wait();
    console.log("Tx", tx3.hash);

    console.log("Signer note balance", utils.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()));
    console.log(
      "Signer underlying balance",
      utils.formatUnits(await underlying.balanceOf(signerAddress), await underlying.decimals()),
    );
  });

task("ops:vault:redeem")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam("amount", "the total amount of vault notes (in float) to redeem", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress, amount } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);
    const underlying = await hre.ethers.getContractAt("MockERC20", await vault.underlying());
    const underlyingDecimals = await underlying.decimals();
    const fixedPtAmount = utils.parseUnits(amount, await vault.decimals());

    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);
    console.log("Signer note balance", utils.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()));

    console.log("---------------------------------------------------------------");
    console.log("Preview redeem:", amount);
    const redemptions = await vault.callStatic.redeem(fixedPtAmount);
    const redemptionData = [];
    for (let i = 0; i < redemptions.length; i++) {
      const token = await hre.ethers.getContractAt("MockERC20", redemptions[i].token);
      redemptionData.push({
        asset: await token.symbol(),
        amount: utils.formatUnits(redemptions[i].amount, underlyingDecimals),
      });
    }
    console.table(redemptionData);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    console.log("Redeem:");
    const tx = await vault.connect(signer).redeem(fixedPtAmount);
    await tx.wait();
    console.log("Tx", tx.hash);
    console.log("Signer note balance", utils.formatUnits(await vault.balanceOf(signerAddress), await vault.decimals()));
  });

task("ops:vault:recoverAndRedeploy")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Recover and redeploy:");
    const tx = await vault.connect(signer).recoverAndRedeploy();
    await tx.wait();
    console.log("Tx", tx.hash);
  });

task("ops:vault:deploy")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Deploy:");
    const tx = await vault.connect(signer).deploy();
    await tx.wait();
    console.log("Tx", tx.hash);
  });

task("ops:vault:recover")
  .addParam("vaultAddress", "the address of the vault contract", undefined, types.string, false)
  .addParam("fromIdx", "the index of sender", 0, types.int)
  .setAction(async function (args: TaskArguments, hre) {
    const { vaultAddress } = args;

    const vault = await hre.ethers.getContractAt("RolloverVault", vaultAddress);

    console.log("---------------------------------------------------------------");
    console.log("Execution:");
    const signer = (await hre.ethers.getSigners())[args.fromIdx];
    const signerAddress = await signer.getAddress();
    console.log("Signer", signerAddress);

    console.log("Recover:");
    const tx = await vault.connect(signer)["recover()"]();
    await tx.wait();
    console.log("Tx", tx.hash);
  });
